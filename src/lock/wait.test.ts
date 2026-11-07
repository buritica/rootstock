import { describe, expect, test } from "bun:test";
import { RootstockLockError } from "./errors.ts";
import type { LockEvent } from "./events.ts";
import {
  type FakeSession,
  fakeDeps,
  fakeSession,
  flush,
  manualDeps,
  PID,
} from "./fake.test-support.ts";
import { acquireRunLock, type LockDeps, type RunLock } from "./run-lock.ts";
import { lockSlice } from "./slice.ts";
import { createTurnQueue, type TurnQueue } from "./turns.ts";
import type { LockWait } from "./wait.ts";

const SLICE = lockSlice({
  profile: "lock",
  names: ["alpha-sync", "beta-sync"],
  heartbeatSeconds: 30,
  probeStallSeconds: 60,
  maxRecoveries: 5,
  endTimeoutSeconds: 5,
  wait: { maxMs: 1000, pollIntervalMs: 50 },
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

async function refusal(p: Promise<unknown>): Promise<RootstockLockError> {
  const err = await caught(p);
  if (!(err instanceof RootstockLockError)) throw err;
  return err;
}

interface Waiter {
  session: FakeSession;
  opens: () => number;
  acquire: Promise<RunLock>;
}

function waiter(
  deps: LockDeps,
  wait: Partial<LockWait> & { turns: TurnQueue },
  session = fakeSession(),
): Waiter {
  let opens = 0;
  const open = () => {
    opens += 1;
    return session;
  };
  const acquire = acquireRunLock(open, SLICE, "alpha-sync", deps, {
    wait: { mode: "poll", ms: 1000, ...wait },
  });
  acquire.catch(() => {});
  return { session, opens: () => opens, acquire };
}

const waits = (events: readonly LockEvent[]) => events.filter((e) => e.type === "lock.wait");

describe("turns", () => {
  test("W1: three waiters on one name acquire in arrival order", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const order: string[] = [];
    const [a, b, c] = ["a", "b", "c"].map((id) => {
      const w = waiter(deps, { turns });
      void w.acquire.then(() => order.push(id));
      return w;
    }) as [Waiter, Waiter, Waiter];
    await deps.advance(10);
    expect(order).toEqual(["a"]);
    expect([b.opens(), c.opens()]).toEqual([0, 0]);
    await (await a.acquire).release();
    await deps.advance(10);
    expect(order).toEqual(["a", "b"]);
    expect(c.opens()).toBe(0);
    await (await b.acquire).release();
    await deps.advance(10);
    expect(order).toEqual(["a", "b", "c"]);
    await (await c.acquire).release();
  });

  test("W2: a queued waiter that times out refuses without open; the one behind keeps waiting", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const a = waiter(deps, { turns });
    const b = waiter(deps, { turns, ms: 100 });
    const c = waiter(deps, { turns, ms: 1000 });
    await deps.advance(100);
    const err = await refusal(b.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(err.waitedMs).toBe(100);
    expect(err.message).toBe(
      "rootstock lock: another session held the alpha-sync lock for the whole 100 ms wait — refusing to run concurrently",
    );
    expect(b.opens()).toBe(0);
    await deps.advance(200);
    expect(c.opens()).toBe(0);
    await (await a.acquire).release();
    await deps.advance(1);
    const lock = await c.acquire;
    expect(c.opens()).toBe(1);
    await lock.release();
  });

  test("a throw from open releases the turn", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const boom = new Error("no client");
    const p = acquireRunLock(
      () => {
        throw boom;
      },
      SLICE,
      "alpha-sync",
      deps,
      { wait: { mode: "poll", ms: 100, turns } },
    );
    expect(await caught(p)).toBe(boom);
    const next = waiter(deps, { turns });
    await deps.advance(1);
    await (await next.acquire).release();
  });
});

describe("validation", () => {
  test("W3: a bad wait refuses WAIT before open", async () => {
    const turns = createTurnQueue();
    const bad: unknown[] = [
      { mode: "poll", ms: 1001, turns },
      { mode: "poll", ms: -1, turns },
      { mode: "poll", ms: 1.5, turns },
      { mode: "block", ms: 10, turns },
      { mode: "poll", ms: 10, turns: {} },
      { mode: "poll", ms: 10, turns, signal: { aborted: false } },
      null,
    ];
    for (const wait of bad) {
      const deps = fakeDeps();
      let opened = false;
      const err = await refusal(
        acquireRunLock(
          () => {
            opened = true;
            return fakeSession();
          },
          SLICE,
          "alpha-sync",
          deps,
          { wait: wait as LockWait },
        ),
      );
      expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_WAIT");
      expect(opened).toBe(false);
      expect(deps.events).toEqual([
        { type: "lock.refused", name: "alpha-sync", code: "ERR_ROOTSTOCK_LOCK_WAIT" },
      ]);
    }
    const deps = fakeDeps();
    const err = await refusal(
      acquireRunLock(() => fakeSession(), SLICE, "alpha-sync", deps, {
        wait: { mode: "block", ms: 10, turns } as unknown as LockWait,
      }),
    );
    expect(err.message).toBe(
      'rootstock lock: wait for "alpha-sync" must be { mode: "poll", ms: an integer from 0 to 1000 (wait.maxMs), turns: a createTurnQueue() queue, signal?: an AbortSignal } — got {"mode":"block","ms":10}',
    );
  });
});

describe("poll", () => {
  test("W4: ms 0 makes exactly one L1", async () => {
    const s = fakeSession();
    s.answer("L1", [{ locked: false, pid: PID }]);
    const deps = fakeDeps();
    const w = waiter(deps, { turns: createTurnQueue(), ms: 0 }, s);
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(err.waitedMs).toBe(0);
    expect(s.seen).toEqual(["L1"]);
    expect(s.closes).toBe(1);
  });

  test("polls every pollIntervalMs until the lock frees, then fences", async () => {
    const s = fakeSession();
    s.answer("L1", [{ locked: false }], [{ locked: false }]);
    const deps = fakeDeps();
    const lock = await waiter(deps, { turns: createTurnQueue(), ms: 500 }, s).acquire;
    expect(s.seen).toEqual(["L1", "L1", "L1", "L2"]);
    expect(waits(deps.events)).toEqual([
      { type: "lock.wait", name: "alpha-sync", mode: "poll", outcome: "acquired", waitedMs: 100 },
    ]);
    await lock.release();
  });

  test("the last sleep is cut to the deadline", async () => {
    const s = fakeSession();
    s.answer("L1", ...Array.from({ length: 5 }, () => [{ locked: false }]));
    const deps = fakeDeps();
    const err = await refusal(waiter(deps, { turns: createTurnQueue(), ms: 120 }, s).acquire);
    expect(err.waitedMs).toBe(120);
    expect(s.seen).toEqual(["L1", "L1", "L1", "L1"]);
  });

  test("W5: an abort while queued refuses ABANDONED without open", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const a = waiter(deps, { turns });
    const ac = new AbortController();
    const b = waiter(deps, { turns, signal: ac.signal });
    await deps.advance(30);
    ac.abort();
    const err = await refusal(b.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(err.waitedMs).toBe(30);
    expect(b.opens()).toBe(0);
    await (await a.acquire).release();

    const pre = new AbortController();
    pre.abort();
    const c = waiter(deps, { turns, signal: pre.signal });
    expect((await refusal(c.acquire)).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(c.opens()).toBe(0);
  });

  test("W5: an abort between polls refuses ABANDONED after the session closes", async () => {
    const deps = manualDeps();
    const s = fakeSession();
    s.answer("L1", [{ locked: false }]);
    const ac = new AbortController();
    const w = waiter(deps, { turns: createTurnQueue(), signal: ac.signal }, s);
    await deps.advance(20);
    expect(deps.sleepers).toBe(1);
    ac.abort();
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(err.waitedMs).toBe(20);
    expect(s.closes).toBe(1);
    expect(s.seen).toEqual(["L1"]);
  });

  test("W6: an L1 that wins after the abort is unlocked, then the session closes, then ABANDONED", async () => {
    const s = fakeSession();
    const ac = new AbortController();
    s.answer("L1", () => {
      ac.abort();
      return [{ locked: true, pid: PID }];
    });
    s.answer("L6", () => {
      expect(s.closes).toBe(0);
      return [{ pg_advisory_unlock: true }];
    });
    const deps = fakeDeps();
    const err = await refusal(
      waiter(deps, { turns: createTurnQueue(), signal: ac.signal }, s).acquire,
    );
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(s.seen).toEqual(["L1", "L6"]);
    expect(s.closes).toBe(1);
    expect(deps.events.map((e) => e.type)).toEqual(["lock.wait", "lock.refused"]);
  });

  test("W7: one lock.wait per waited acquire, with its outcome, before acquired or refused", async () => {
    const run = async (setup: (s: FakeSession) => void, signal?: AbortSignal, ms = 1000) => {
      const s = fakeSession();
      setup(s);
      const deps = fakeDeps();
      await caught(waiter(deps, { turns: createTurnQueue(), ms, signal }, s).acquire).catch(
        () => {},
      );
      await flush();
      return deps.events.map((e) =>
        e.type === "lock.wait" ? `wait:${e.outcome}` : e.type === "lock.refused" ? e.code : e.type,
      );
    };
    const okDeps = fakeDeps();
    const ok = await waiter(okDeps, { turns: createTurnQueue() }).acquire;
    expect(okDeps.events.map((e) => e.type)).toEqual(["lock.wait", "lock.acquired"]);
    expect(waits(okDeps.events)[0]).toMatchObject({ outcome: "acquired", waitedMs: 0 });
    await ok.release();

    expect(await run((s) => s.answer("L1", [{ locked: false }]), undefined, 0)).toEqual([
      "wait:timeout",
      "ERR_ROOTSTOCK_LOCK_HELD",
    ]);
    expect(await run((s) => s.answer("L1", [{ locked: null }]))).toEqual([
      "wait:error",
      "ERR_ROOTSTOCK_LOCK_MALFUNCTION",
    ]);
    expect(await run((s) => s.answer("L2", new Error("no table")))).toEqual([
      "wait:acquired",
      "ERR_ROOTSTOCK_LOCK_UNFENCED",
    ]);
    expect(await run((s) => s.answer("L2", [{ pid: PID + 9 }]))).toEqual([
      "wait:acquired",
      "ERR_ROOTSTOCK_LOCK_CONN",
    ]);
    const ac = new AbortController();
    expect(
      await run(
        (s) =>
          s.answer("L1", () => {
            ac.abort();
            return [{ locked: false }];
          }),
        ac.signal,
      ),
    ).toEqual(["wait:aborted", "ERR_ROOTSTOCK_LOCK_ABANDONED"]);
  });

  test("W7b: a rejecting second poll closes, reports error, rethrows, and frees the turn", async () => {
    const turns = createTurnQueue();
    const s = fakeSession();
    const boom = new Error("connection reset");
    s.answer("L1", [{ locked: false }], boom);
    const endErr = new Error("end failed");
    s.failClose(endErr);
    const deps = manualDeps();
    const w = waiter(deps, { turns }, s);
    const next = waiter(deps, { turns });
    await deps.advance(50);
    expect(await caught(w.acquire)).toBe(boom);
    expect(s.closes).toBe(1);
    const mine = deps.events.slice(0, 2);
    expect(mine).toEqual([
      {
        type: "lock.end_failed",
        name: "alpha-sync",
        phase: "acquire-error",
        error: endErr,
        code: undefined,
      },
      { type: "lock.wait", name: "alpha-sync", mode: "poll", outcome: "error", waitedMs: 50 },
    ]);
    expect(deps.events.map((e) => e.type)).not.toContain("lock.refused");
    await deps.advance(1);
    const lock = await next.acquire;
    expect(next.opens()).toBe(1);
    await lock.release();
  });
});
