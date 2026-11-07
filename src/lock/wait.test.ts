import { describe, expect, test } from "bun:test";
import type { Row } from "../db/index.ts";
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
      'rootstock lock: wait for "alpha-sync" must be { mode: "poll" | "block", ms: an integer from 0 (poll) or 1 (block) to 1000 (wait.maxMs), turns: a createTurnQueue() queue, signal?: an AbortSignal } (block mode needs wait.block in the lock slice) — got {"mode":"block","ms":10}',
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

describe("hardening: a waited acquire cleans up on every path", () => {
  /** fakeDeps whose sleep rejects, with a clock that moves on every read. */
  const rejectingSleep = () => {
    const deps = fakeDeps({
      sleep: async () => {
        throw new Error("sleep");
      },
    });
    deps.now = () => {
      deps.clock += 10;
      return deps.clock;
    };
    return deps;
  };

  test("a rejecting sleep between polls closes the session and frees the turn", async () => {
    const turns = createTurnQueue();
    const s = fakeSession();
    s.answer("L1", ...Array.from({ length: 500 }, () => [{ locked: false, pid: PID }]));
    const first = waiter(rejectingSleep(), { turns, ms: 200 }, s);
    expect((await refusal(first.acquire)).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(s.closes).toBe(1);
    const next = waiter(fakeDeps(), { turns });
    await next.acquire;
    expect(next.opens()).toBe(1);
  });

  test("a rejecting sleep while queued gives up and frees the turn", async () => {
    const turns = createTurnQueue();
    const holder = waiter(fakeDeps(), { turns });
    const ahead = await holder.acquire;
    const quitter = waiter(rejectingSleep(), { turns });
    expect((await refusal(quitter.acquire)).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(quitter.opens()).toBe(0);
    const deps = manualDeps();
    const next = waiter(deps, { turns });
    await ahead.release();
    await deps.advance(0);
    expect(next.opens()).toBe(1);
    await (await next.acquire).release();
  });

  test("a throwing randomUUID after a successful poll closes the session and frees the turn", async () => {
    const turns = createTurnQueue();
    const boom = new Error("no entropy");
    const deps = fakeDeps({
      randomUUID: () => {
        throw boom;
      },
    });
    const w = waiter(deps, { turns });
    expect(await caught(w.acquire)).toBe(boom);
    expect(w.session.closes).toBe(1);
    const next = waiter(fakeDeps(), { turns });
    await next.acquire;
    expect(next.opens()).toBe(1);
  });

  test("an abort that lands during the fence gives the lock back and refuses ABANDONED", async () => {
    const s = fakeSession();
    const ac = new AbortController();
    s.answer("L2", () => {
      ac.abort();
      return [{ pid: PID }];
    });
    const deps = fakeDeps();
    const turns = createTurnQueue();
    const err = await refusal(waiter(deps, { turns, signal: ac.signal }, s).acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(s.seen).toEqual(["L1", "L2", "L6"]);
    expect(s.closes).toBe(1);
    expect(deps.events.map((e) => e.type)).toEqual(["lock.wait", "lock.acquired", "lock.refused"]);
    const next = waiter(fakeDeps(), { turns });
    await next.acquire;
    expect(next.opens()).toBe(1);
  });

  test("an abort wins over a deadline reached in the same poll", async () => {
    const s = fakeSession();
    const ac = new AbortController();
    s.answer("L1", () => {
      ac.abort();
      return [{ locked: false, pid: PID }];
    });
    const err = await refusal(
      waiter(fakeDeps(), { turns: createTurnQueue(), signal: ac.signal, ms: 0 }, s).acquire,
    );
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
  });

  test("a forged signal refuses WAIT", async () => {
    const forged = { [Symbol.toStringTag]: "AbortSignal" };
    let opens = 0;
    const err = await refusal(
      acquireRunLock(
        () => {
          opens += 1;
          return fakeSession();
        },
        SLICE,
        "alpha-sync",
        fakeDeps(),
        {
          wait: {
            mode: "poll",
            ms: 10,
            turns: createTurnQueue(),
            signal: forged as unknown as AbortSignal,
          },
        },
      ),
    );
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_WAIT");
    expect(opens).toBe(0);
  });

  test("the wait is read once: a getter cannot widen ms after validation", async () => {
    let reads = 0;
    const wait = {
      mode: "poll" as const,
      turns: createTurnQueue(),
      get ms() {
        reads += 1;
        return reads === 1 ? 0 : 1000;
      },
    };
    const s = fakeSession();
    s.answer("L1", ...Array.from({ length: 50 }, () => [{ locked: false, pid: PID }]));
    const err = await refusal(acquireRunLock(() => s, SLICE, "alpha-sync", fakeDeps(), { wait }));
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(s.seen).toEqual(["L1"]);
  });
});

describe("round 2: nothing in flight holds the turn", () => {
  const LONG = lockSlice({
    profile: "lock",
    names: ["alpha-sync"],
    heartbeatSeconds: 30,
    probeStallSeconds: 60,
    maxRecoveries: 5,
    endTimeoutSeconds: 5,
    wait: { maxMs: 120_000, pollIntervalMs: 50 },
  });

  function longWaiter(deps: LockDeps, wait: Partial<LockWait> & { turns: TurnQueue }) {
    const session = fakeSession();
    const acquire = acquireRunLock(() => session, LONG, "alpha-sync", deps, {
      wait: { mode: "poll", ms: 100_000, ...wait },
    });
    acquire.catch(() => {});
    return { session, acquire };
  }

  test("release frees the turn before a close that hangs: the next waiter reaches L1", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const s = fakeSession();
    const hung = { sql: s.sql, close: () => new Promise<void>(() => {}) };
    const first = acquireRunLock(() => hung, SLICE, "alpha-sync", deps, {
      wait: { mode: "poll", ms: 1000, turns },
    });
    const lock = await first;
    const next = waiter(deps, { turns });
    void lock.release();
    await deps.advance(10);
    expect(s.seen.at(-1)).toBe("L6");
    expect(next.session.seen[0]).toBe("L1");
    await (await next.acquire).release();
  });

  test("a hung L1 refuses HELD at the deadline, closes, and frees the turn", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const w = longWaiter(deps, { turns });
    w.session.answer("L1", () => new Promise<Row[]>(() => {}));
    const next = longWaiter(deps, { turns, ms: 110_000 });
    await deps.advance(99_999);
    expect(next.session.seen).toEqual([]);
    await deps.advance(1);
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(err.waitedMs).toBe(100_000);
    expect(w.session.closes).toBe(1);
    await deps.advance(1);
    expect(next.session.seen[0]).toBe("L1");
    await (await next.acquire).release();
  });

  test("an abort during a hung L1 refuses ABANDONED at once", async () => {
    const deps = manualDeps();
    const ac = new AbortController();
    const w = longWaiter(deps, { turns: createTurnQueue(), signal: ac.signal });
    w.session.answer("L1", () => new Promise<Row[]>(() => {}));
    await deps.advance(10);
    ac.abort();
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(w.session.closes).toBe(1);
  });

  test("an ms: 0 wait still gets its one L1 answered", async () => {
    const deps = manualDeps();
    const w = longWaiter(deps, { turns: createTurnQueue(), ms: 0 });
    await deps.advance(1);
    await (await w.acquire).release();
    expect(w.session.seen).toEqual(["L1", "L2", "L6"]);
  });

  test("a hung fence refuses UNFENCED with a timeout cause, and frees the turn", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const w = longWaiter(deps, { turns, ms: 1000 });
    w.session.answer("L2", () => new Promise<Row[]>(() => {}));
    const next = longWaiter(deps, { turns });
    await deps.advance(60_000);
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_UNFENCED");
    expect((err.cause as Error).message).toBe(
      "rootstock lock: the fence for alpha-sync did not settle within 60000 ms",
    );
    expect(w.session.closes).toBe(1);
    await deps.advance(1);
    expect(next.session.seen[0]).toBe("L1");
    await (await next.acquire).release();
  });
});

// w4d §8.1: block mode, unit half (the DB half is wait.pg.ts LB1-LB4).

const BLOCK_SLICE = lockSlice({
  profile: "lock",
  names: ["alpha-sync"],
  heartbeatSeconds: 30,
  probeStallSeconds: 60,
  maxRecoveries: 5,
  endTimeoutSeconds: 5,
  wait: { maxMs: 1000, pollIntervalMs: 50, block: { checkIntervalMs: 200 } },
});
const STALL = 60_000;

function blocker(
  deps: LockDeps,
  wait: { ms?: number; signal?: AbortSignal; turns?: TurnQueue } = {},
  session = fakeSession(),
): Waiter {
  let opens = 0;
  const open = () => {
    opens += 1;
    return session;
  };
  const acquire = acquireRunLock(open, BLOCK_SLICE, "alpha-sync", deps, {
    wait: { mode: "block", ms: 1000, turns: createTurnQueue(), ...wait },
  });
  acquire.catch(() => {});
  return { session, opens: () => opens, acquire };
}

const pgError = (code: string, message = `server said ${code}`) =>
  Object.assign(new Error(message), { code });
const outcomes = (events: readonly LockEvent[]) =>
  events.map((e) =>
    e.type === "lock.wait"
      ? `wait:${e.mode}:${e.outcome}`
      : e.type === "lock.refused"
        ? e.code
        : e.type,
  );
const never = () => new Promise<Row[]>(() => {});

describe("block mode (w4d §8.1)", () => {
  test("LB5: block without wait.block refuses WAIT with the block note; ms 0 in block refuses WAIT", async () => {
    const turns = createTurnQueue();
    const noBlock = await refusal(
      acquireRunLock(() => fakeSession(), SLICE, "alpha-sync", fakeDeps(), {
        wait: { mode: "block", ms: 100, turns },
      }),
    );
    expect(noBlock.code).toBe("ERR_ROOTSTOCK_LOCK_WAIT");
    expect(noBlock.message).toBe(
      'rootstock lock: wait for "alpha-sync" must be { mode: "poll" | "block", ms: an integer from 0 (poll) or 1 (block) to 1000 (wait.maxMs), turns: a createTurnQueue() queue, signal?: an AbortSignal } (block mode needs wait.block in the lock slice) — got {"mode":"block","ms":100}',
    );
    for (const ms of [0, 1001, 2.5]) {
      let opened = false;
      const deps = fakeDeps();
      const err = await refusal(
        acquireRunLock(
          () => {
            opened = true;
            return fakeSession();
          },
          BLOCK_SLICE,
          "alpha-sync",
          deps,
          { wait: { mode: "block", ms, turns } },
        ),
      );
      expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_WAIT");
      expect(err.message).toBe(
        `rootstock lock: wait for "alpha-sync" must be { mode: "poll" | "block", ms: an integer from 0 (poll) or 1 (block) to 1000 (wait.maxMs), turns: a createTurnQueue() queue, signal?: an AbortSignal } — got {"mode":"block","ms":${ms}}`,
      );
      expect(opened).toBe(false);
      expect(deps.events).toEqual([
        { type: "lock.refused", name: "alpha-sync", code: "ERR_ROOTSTOCK_LOCK_WAIT" },
      ]);
    }
    // ms 0 is still a poll wait's to take, and 1 is block's smallest.
    await (await waiter(fakeDeps(), { turns, ms: 0 }).acquire).release();
    await (await blocker(fakeDeps(), { ms: 1 }).acquire).release();
  });

  test("acquires with B0, B1, B2, B3, then the fence; B3 restores B0's texts", async () => {
    const s = fakeSession();
    s.answer("B0", [{ lt: "5s", cc: "0" }]);
    const deps = fakeDeps();
    const w = blocker(deps, { ms: 800 }, s);
    const lock = await w.acquire;
    expect(w.opens()).toBe(1);
    expect(s.calls.map((c) => [c.id, c.params])).toEqual([
      ["B0", []],
      ["B1", ["800ms", "200ms"]],
      ["B2", ["alpha-sync"]],
      ["B3", ["5s", "0"]],
      ["L2", ["alpha-sync", lock.holder]],
    ]);
    expect(outcomes(deps.events)).toEqual(["wait:block:acquired", "lock.acquired"]);
    expect(waits(deps.events)[0]).toEqual({
      type: "lock.wait",
      name: "alpha-sync",
      mode: "block",
      outcome: "acquired",
      waitedMs: 0,
    });
    await lock.release();
    expect(s.seen.at(-1)).toBe("L6");
    expect([s.closes, s.destroys]).toEqual([1, 0]);
  });

  test("A15: B1 refused 22023 or 42704 blocks without the connection check, emits once, restores lock_timeout only", async () => {
    for (const code of ["22023", "42704"]) {
      const s = fakeSession();
      s.answer("B0", [{ lt: "5s", cc: "0" }]);
      s.answer("B1", pgError(code, "client_connection_check_interval must be set to 0"));
      const deps = fakeDeps();
      const lock = await blocker(deps, { ms: 800 }, s).acquire;
      expect(s.calls.map((c) => [c.id, c.params])).toEqual([
        ["B0", []],
        ["B1", ["800ms", "200ms"]],
        ["B1L", ["800ms"]],
        ["B2", ["alpha-sync"]],
        ["B3L", ["5s"]],
        ["L2", ["alpha-sync", lock.holder]],
      ]);
      expect(outcomes(deps.events)).toEqual([
        "lock.connection_check_unavailable",
        "wait:block:acquired",
        "lock.acquired",
      ]);
      expect(deps.events[0]).toEqual({
        type: "lock.connection_check_unavailable",
        name: "alpha-sync",
      });
      await lock.release();
    }
    // Any other B1 failure is still an error, rethrown untouched.
    const s = fakeSession();
    const boom = pgError("42501");
    s.answer("B1", boom);
    const deps = fakeDeps();
    expect(await blocker(deps, {}, s).acquire.catch((e) => e)).toBe(boom);
    expect(s.seen).toEqual(["B0", "B1"]);
    expect(outcomes(deps.events)).toEqual(["wait:block:error"]);
  });

  test("an abort during the settings refuses ABANDONED without sending B2", async () => {
    const s = fakeSession(undefined, { destroy: true });
    const ac = new AbortController();
    s.answer("B1", () => {
      ac.abort();
      return [{ lt: "", cc: "" }];
    });
    const deps = fakeDeps();
    const err = await refusal(blocker(deps, { signal: ac.signal }, s).acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(s.seen).toEqual(["B0", "B1"]);
    expect([s.closes, s.destroys]).toEqual([1, 0]);
    expect(outcomes(deps.events)).toEqual(["wait:block:aborted", "ERR_ROOTSTOCK_LOCK_ABANDONED"]);
  });

  test("A15: an abort while blocked without the connection check still destroys the session", async () => {
    const s = fakeSession(undefined, { destroy: true });
    s.answer("B1", pgError("22023"));
    s.answer("B2", never);
    const ac = new AbortController();
    const deps = fakeDeps();
    const w = blocker(deps, { signal: ac.signal }, s);
    while (!s.seen.includes("B2")) await Promise.resolve();
    ac.abort();
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(err.details).toEqual({ code: "ERR_ROOTSTOCK_LOCK_ABANDONED", waitedMs: 0 });
    expect(s.seen).toEqual(["B0", "B1", "B1L", "B2"]);
    expect(s.destroys).toBe(1);
  });

  test("B1's lock_timeout is what is left of the wait after the turn, never below 1", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const first = blocker(deps, { turns });
    const lock = await first.acquire;
    const second = blocker(deps, { turns, ms: 300 });
    await deps.advance(299);
    await lock.release();
    await deps.advance(0);
    await (await second.acquire).release();
    expect(second.session.calls.find((c) => c.id === "B1")?.params).toEqual(["1ms", "200ms"]);
  });

  test("LB2 (unit): B2 rejecting 55P03 is HELD after a wait with outcome timeout", async () => {
    const s = fakeSession();
    s.answer("B2", pgError("55P03", "canceling statement due to lock timeout"));
    const deps = fakeDeps();
    const err = await refusal(blocker(deps, {}, s).acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(err.waitedMs).toBe(0);
    expect(outcomes(deps.events)).toEqual(["wait:block:timeout", "ERR_ROOTSTOCK_LOCK_HELD"]);
    expect(s.seen).toEqual(["B0", "B1", "B2"]);
    expect([s.closes, s.destroys]).toEqual([1, 0]);
  });

  test("B2 rejecting otherwise closes, reports error, rethrows the same object, and frees the turn", async () => {
    const turns = createTurnQueue();
    const s = fakeSession();
    const boom = pgError("57P01");
    s.answer("B2", boom);
    const deps = manualDeps();
    const w = blocker(deps, { turns }, s);
    const next = blocker(deps, { turns });
    await deps.advance(1);
    expect(await caught(w.acquire)).toBe(boom);
    expect(outcomes(deps.events)[0]).toBe("wait:block:error");
    expect(s.closes).toBe(1);
    await deps.advance(1);
    await (await next.acquire).release();
  });

  test("B0 rejecting (42704: no client_connection_check_interval) closes, reports error, rethrows untouched", async () => {
    const turns = createTurnQueue();
    const s = fakeSession();
    const missing = pgError("42704", "unrecognized configuration parameter");
    s.answer("B0", missing);
    const deps = manualDeps();
    const w = blocker(deps, { turns }, s);
    const next = blocker(deps, { turns });
    await deps.advance(1);
    expect(await caught(w.acquire)).toBe(missing);
    expect(s.seen).toEqual(["B0"]);
    expect(s.closes).toBe(1);
    expect(outcomes(deps.events)[0]).toBe("wait:block:error");
    await deps.advance(1);
    await (await next.acquire).release();
  });

  test("a B0 that does not answer two texts, and a B1 that stalls, are errors before B2", async () => {
    const odd = fakeSession();
    odd.answer("B0", [{ lt: null, cc: "0" }]);
    const err = await caught(blocker(fakeDeps(), {}, odd).acquire);
    expect((err as Error).message).toBe(
      "rootstock lock: the settings read for alpha-sync did not answer two texts",
    );
    expect(odd.seen).toEqual(["B0"]);
    expect(odd.closes).toBe(1);

    const hung = fakeSession();
    hung.answer("B1", never);
    const deps = manualDeps();
    const w = blocker(deps, {}, hung);
    await deps.advance(STALL);
    const stall = await caught(w.acquire);
    expect((stall as Error).message).toBe(
      "rootstock lock: the settings for alpha-sync did not settle within 60000 ms",
    );
    expect(hung.seen).toEqual(["B0", "B1"]);
    expect(hung.closes).toBe(1);
    expect(outcomes(deps.events)).toEqual(["wait:block:error"]);
  });

  test("LB3 (unit): an abort while blocked destroys the session (close not called) and refuses ABANDONED", async () => {
    const s = fakeSession();
    s.answer("B2", never);
    const ac = new AbortController();
    const deps = manualDeps();
    const w = blocker(deps, { signal: ac.signal }, s);
    await deps.advance(40);
    expect(s.seen).toEqual(["B0", "B1", "B2"]);
    ac.abort();
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(err.waitedMs).toBe(40);
    expect([s.destroys, s.closes]).toEqual([1, 0]);
    expect(outcomes(deps.events)).toEqual(["wait:block:aborted", "ERR_ROOTSTOCK_LOCK_ABANDONED"]);
  });

  test("LB3b (unit): a session without destroy falls back to close(); a failing end is end_failed", async () => {
    const s = fakeSession(undefined, { destroy: false });
    expect("destroy" in s).toBe(false);
    s.answer("B2", never);
    const ac = new AbortController();
    const deps = manualDeps();
    const w = blocker(deps, { signal: ac.signal }, s);
    await deps.advance(1);
    ac.abort();
    expect((await refusal(w.acquire)).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(s.closes).toBe(1);

    const failing = fakeSession();
    const endErr = new Error("end failed");
    failing.failClose(endErr);
    failing.answer("B2", never);
    const ac2 = new AbortController();
    const deps2 = manualDeps();
    const w2 = blocker(deps2, { signal: ac2.signal }, failing);
    await deps2.advance(1);
    ac2.abort();
    expect((await refusal(w2.acquire)).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect([failing.destroys, failing.closes]).toEqual([1, 0]);
    expect(deps2.events).toContainEqual({
      type: "lock.end_failed",
      name: "alpha-sync",
      phase: "acquire-error",
      error: endErr,
      code: undefined,
    });
  });

  test("a B2 the server never times out refuses HELD once remainingMs + the stall has passed", async () => {
    const s = fakeSession();
    s.answer("B2", never);
    const deps = manualDeps();
    const w = blocker(deps, { ms: 500 }, s);
    await deps.advance(500 + STALL - 1);
    expect(s.closes).toBe(0);
    await deps.advance(1);
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(err.waitedMs).toBe(500 + STALL);
    expect([s.closes, s.destroys]).toEqual([1, 0]);
    expect(outcomes(deps.events)).toEqual(["wait:block:timeout", "ERR_ROOTSTOCK_LOCK_HELD"]);
  });

  test("LB4 (unit): a grant answered after the abort is unlocked, closed, ABANDONED, never fenced", async () => {
    const s = fakeSession();
    const ac = new AbortController();
    s.answer("B2", () => {
      ac.abort();
      return [{ locked: true, pid: PID }];
    });
    s.answer("L6", () => {
      expect(s.closes).toBe(0);
      return [{ pg_advisory_unlock: true }];
    });
    const deps = fakeDeps();
    const err = await refusal(blocker(deps, { signal: ac.signal }, s).acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(s.seen).toEqual(["B0", "B1", "B2", "L6"]);
    expect([s.closes, s.destroys]).toEqual([1, 0]);
    expect(outcomes(deps.events)).toEqual(["wait:block:aborted", "ERR_ROOTSTOCK_LOCK_ABANDONED"]);
  });

  test("B2 answering anything but locked true with a pid is MALFUNCTION, closed", async () => {
    for (const [row, answer] of [
      [{ locked: false, pid: PID }, false],
      [{ locked: true, pid: 0 }, 0],
    ] as const) {
      const s = fakeSession();
      s.answer("B2", [row]);
      const deps = fakeDeps();
      const err = await refusal(blocker(deps, {}, s).acquire);
      expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_MALFUNCTION");
      expect(err.answer).toBe(answer);
      expect(s.closes).toBe(1);
      expect(outcomes(deps.events)).toEqual(["wait:block:error", "ERR_ROOTSTOCK_LOCK_MALFUNCTION"]);
    }
  });

  test("B3 rejecting or stalling unlocks, closes, reports error, and rethrows; nothing is fenced", async () => {
    const s = fakeSession();
    const boom = pgError("08006");
    s.answer("B3", boom);
    const deps = fakeDeps();
    expect(await caught(blocker(deps, {}, s).acquire)).toBe(boom);
    expect(s.seen).toEqual(["B0", "B1", "B2", "B3", "L6"]);
    expect(s.closes).toBe(1);
    expect(outcomes(deps.events)).toEqual(["wait:block:error"]);

    const hung = fakeSession();
    hung.answer("B3", never);
    hung.answer("L6", never);
    const md = manualDeps();
    const w = blocker(md, {}, hung);
    await md.advance(STALL);
    await md.advance(STALL);
    const err = await caught(w.acquire);
    expect((err as Error).message).toBe(
      "rootstock lock: restoring the settings for alpha-sync did not settle within 60000 ms",
    );
    expect(hung.seen).toEqual(["B0", "B1", "B2", "B3", "L6"]);
    expect(hung.closes).toBe(1);
    expect(outcomes(md.events)).toEqual(["lock.unlock_failed", "wait:block:error"]);
  });

  test("the fence is bounded by the stall: a hung L2 refuses UNFENCED", async () => {
    const s = fakeSession();
    s.answer("L2", never);
    const deps = manualDeps();
    const w = blocker(deps, {}, s);
    await deps.advance(STALL);
    const err = await refusal(w.acquire);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_UNFENCED");
    expect(s.closes).toBe(1);
  });

  test("an abort while queued refuses ABANDONED without open, with mode block", async () => {
    const deps = manualDeps();
    const turns = createTurnQueue();
    const first = blocker(deps, { turns });
    const ac = new AbortController();
    const second = blocker(deps, { turns, signal: ac.signal });
    await deps.advance(10);
    ac.abort();
    expect((await refusal(second.acquire)).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(second.opens()).toBe(0);
    expect(waits(deps.events).at(-1)).toMatchObject({ mode: "block", outcome: "aborted" });
    await (await first.acquire).release();
  });
});
