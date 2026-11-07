import { describe, expect, test } from "bun:test";
import { lockErrorCode, RootstockLockError } from "./errors.ts";
import type { LockEvent } from "./events.ts";
import {
  type FakeSession,
  fakeDeps,
  fakeSession,
  flush,
  HOLDER,
  PID,
} from "./fake.test-support.ts";
import { lockOwnershipLost } from "./probe.ts";
import { acquireRunLock, type LockDeps } from "./run-lock.ts";
import { type LockSlice, lockSlice } from "./slice.ts";

const SLICE = lockSlice({
  profile: "lock",
  names: ["alpha-sync", "beta-sync", "gamma-*"],
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

function take(session: FakeSession, deps: LockDeps, slice: LockSlice = SLICE, name = "alpha-sync") {
  return acquireRunLock(() => session, slice, name, deps);
}

const types = (events: readonly LockEvent[]) => events.map((e) => e.type);

describe("acquire", () => {
  test("U1: a rejecting try-lock closes the session, then rethrows the same object", async () => {
    const s = fakeSession();
    const boom = new Error("socket gone");
    s.answer("L1", boom);
    const deps = fakeDeps();
    expect(await caught(take(s, deps))).toBe(boom);
    expect(s.closes).toBe(1);
    expect(deps.events).toEqual([]);

    const s2 = fakeSession();
    s2.answer("L1", boom);
    const endErr = new Error("end failed");
    s2.failClose(endErr);
    const deps2 = fakeDeps();
    expect(await caught(take(s2, deps2))).toBe(boom);
    expect(deps2.events).toEqual([
      {
        type: "lock.end_failed",
        name: "alpha-sync",
        phase: "acquire-error",
        error: endErr,
        code: undefined,
      },
    ]);
  });

  test("U2: false is HELD; null, a string or no row is MALFUNCTION with the answer", async () => {
    const s = fakeSession();
    s.answer("L1", [{ locked: false, pid: PID }]);
    const deps = fakeDeps();
    const err = (await caught(take(s, deps))) as RootstockLockError;
    expect(err).toBeInstanceOf(RootstockLockError);
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(err.message).toBe(
      "rootstock lock: another session holds the alpha-sync lock — refusing to run concurrently. If no other run exists, a dead session may linger after an abrupt disconnect: check pg_locks, or wait for the server to reap it",
    );
    expect(s.closes).toBe(1);
    expect(deps.events).toEqual([
      { type: "lock.refused", name: "alpha-sync", code: "ERR_ROOTSTOCK_LOCK_HELD" },
    ]);

    for (const [rows, answer, text] of [
      [[{ locked: null, pid: PID }], null, "null"],
      [[{ locked: "t", pid: PID }], "t", '"t"'],
      [[], undefined, "undefined"],
    ] as const) {
      const m = fakeSession();
      m.answer("L1", [...rows]);
      const d = fakeDeps();
      const e = (await caught(take(m, d))) as RootstockLockError;
      expect(e.code).toBe("ERR_ROOTSTOCK_LOCK_MALFUNCTION");
      expect(Object.hasOwn(e, "answer")).toBe(true);
      expect(e.answer).toBe(answer);
      expect(e.message).toBe(
        `rootstock lock: pg_try_advisory_lock for alpha-sync answered neither true nor false (got ${text}) — a malfunction, not a busy lock; nothing was run`,
      );
      expect(m.closes).toBe(1);
      expect(m.seen).toEqual(["L1"]);
    }
  });

  test("U2: a failing close on a refusal is an end_failed refusal event, and still HELD", async () => {
    const s = fakeSession();
    s.answer("L1", [{ locked: false, pid: PID }]);
    const endErr = Object.assign(new Error("x"), { code: "57P01" });
    s.failClose(endErr);
    const deps = fakeDeps();
    const err = (await caught(take(s, deps))) as RootstockLockError;
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(deps.events).toEqual([
      {
        type: "lock.end_failed",
        name: "alpha-sync",
        phase: "refusal",
        error: endErr,
        code: "57P01",
      },
      { type: "lock.refused", name: "alpha-sync", code: "ERR_ROOTSTOCK_LOCK_HELD" },
    ]);
  });

  test("U5: the try-lock runs before the fence", async () => {
    const s = fakeSession();
    s.answer("L2", (params) => {
      if (!s.seen.slice(0, -1).includes("L1")) throw new Error("fence before try-lock");
      return [{ pid: PID, params }];
    });
    const lock = await take(s, fakeDeps());
    expect(s.seen).toEqual(["L1", "L2"]);
    expect(lock.holder).toBe(HOLDER);
  });

  test("U6: a rejecting fence is UNFENCED with the cause, the session closed, nothing after", async () => {
    const s = fakeSession();
    const cause = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    s.answer("L2", cause);
    const deps = fakeDeps();
    const err = (await caught(take(s, deps))) as RootstockLockError;
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_UNFENCED");
    expect(err.cause).toBe(cause);
    expect(err.message).toBe(
      "rootstock lock: took the alpha-sync lock but could not record its holder in rootstock.run_locks — refusing to run unfenced, because a severed session could then not be told apart from another run taking over; run the migrations (the table ships with rootstock 0.6.0, or is your own)",
    );
    expect(s.seen).toEqual(["L1", "L2"]);
    expect(s.closes).toBe(1);
    expect(types(deps.events)).toEqual(["lock.refused"]);
  });

  test("U7: the happy path is exactly try-lock, fence, probe", async () => {
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    await lock.ensureExclusive();
    expect(s.seen).toEqual(["L1", "L2", "L3"]);
    expect(deps.events).toEqual([{ type: "lock.acquired", name: "alpha-sync", pid: PID }]);
    expect(deps.intervals).toBe(0);
    expect(lock.name).toBe("alpha-sync");
  });

  test("U8: a lock another session holds is HELD and the session is closed", async () => {
    const s = fakeSession();
    s.answer("L1", [{ locked: false, pid: PID + 9 }]);
    const err = await caught(take(s, fakeDeps()));
    expect(lockErrorCode(err)).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    expect(s.closes).toBe(1);
    expect(s.seen).toEqual(["L1"]);
  });

  test("U9: a fence with no row, or on another backend, is CONN", async () => {
    const none = fakeSession();
    none.answer("L2", []);
    const e1 = (await caught(take(none, fakeDeps()))) as RootstockLockError;
    expect(e1.code).toBe("ERR_ROOTSTOCK_LOCK_CONN");
    expect(e1.expectedPid).toBe(PID);
    expect(e1.actualPid).toBeNull();
    expect(e1.message).toBe(
      `rootstock lock: the fence for alpha-sync did not land on the session that holds the lock (pid ${PID}, fence pid none) — a pool was passed as the lock session, or the session was severed between the two statements; re-run, and check the lock profile if it repeats`,
    );
    expect(none.closes).toBe(1);

    const other = fakeSession();
    other.answer("L2", [{ pid: PID + 1 }]);
    const e2 = (await caught(take(other, fakeDeps()))) as RootstockLockError;
    expect(e2.code).toBe("ERR_ROOTSTOCK_LOCK_CONN");
    expect([e2.expectedPid, e2.actualPid]).toEqual([PID, PID + 1]);
    expect(e2.message).toContain(`(pid ${PID}, fence pid ${PID + 1})`);
  });

  test("U14: NAME refuses before open is called", async () => {
    let opened = 0;
    const deps = fakeDeps();
    const err = (await caught(
      acquireRunLock(
        () => {
          opened += 1;
          return fakeSession();
        },
        SLICE,
        "delta-sync",
        deps,
      ),
    )) as RootstockLockError;
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_NAME");
    expect(err.message).toBe(
      'rootstock lock: "delta-sync" is not a lock this config declares — declared: alpha-sync, beta-sync, gamma-*',
    );
    expect(opened).toBe(0);
    expect(deps.events).toEqual([
      { type: "lock.refused", name: "delta-sync", code: "ERR_ROOTSTOCK_LOCK_NAME" },
    ]);
    // A family member is admitted; the bare prefix is not.
    expect((await take(fakeSession(), fakeDeps(), SLICE, "gamma-x")).name).toBe("gamma-x");
    expect(lockErrorCode(await caught(take(fakeSession(), fakeDeps(), SLICE, "gamma-")))).toBe(
      "ERR_ROOTSTOCK_LOCK_NAME",
    );
  });

  test("an unbranded slice is refused before open", async () => {
    let opened = 0;
    const err = (await caught(
      acquireRunLock(
        () => {
          opened += 1;
          return fakeSession();
        },
        { ...SLICE },
        "alpha-sync",
        fakeDeps(),
      ),
    )) as Error;
    expect(err.message).toBe(
      "acquireRunLock: expected a LockSlice built by lockSlice() — got an object that parser did not return",
    );
    expect(opened).toBe(0);
  });

  test("a throw from open propagates untouched, with no event", async () => {
    const boom = new Error("cannot open");
    const deps = fakeDeps();
    const err = await caught(
      acquireRunLock(
        () => {
          throw boom;
        },
        SLICE,
        "alpha-sync",
        deps,
      ),
    );
    expect(err).toBe(boom);
    expect(deps.events).toEqual([]);
  });

  test("U15: a hook that throws changes no outcome", async () => {
    const throwing = {
      onEvent: () => {
        throw new Error("hook");
      },
    };
    const ok = await take(fakeSession(), fakeDeps(throwing));
    await ok.ensureExclusive();
    await ok.release();
    const s = fakeSession();
    s.answer("L1", [{ locked: false, pid: PID }]);
    expect(lockErrorCode(await caught(take(s, fakeDeps(throwing))))).toBe(
      "ERR_ROOTSTOCK_LOCK_HELD",
    );
  });
});

describe("the gate", () => {
  test("U3: a rejecting probe whose recovery fails is UNVERIFIABLE with the cause", async () => {
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    const probeErr = new Error("probe failed");
    s.answer("L3", probeErr);
    s.answer("L4", new Error("still down"), new Error("still down"));
    const err = (await caught(lock.ensureExclusive())) as RootstockLockError;
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_UNVERIFIABLE");
    expect(err.cause).toBe(probeErr);
    expect(err.stopsRun).toBe(true);
    expect(err.message).toBe(
      "rootstock lock: the alpha-sync lock is UNVERIFIABLE — the ownership probe failed and the lock could not be recovered, so exclusivity cannot be asserted; aborting the run",
    );
  });

  test("U10: recovery retries once, refuses held or displaced, and recovers", async () => {
    // Rejects once, then succeeds.
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    const first = new Error("sacrificial");
    s.answer("L3", [{ pid: PID + 1, held: 0 }]);
    s.answer("L4", first, [{ locked: true, pid: PID + 2, holder: HOLDER }]);
    await lock.ensureExclusive();
    expect(deps.events.slice(1)).toEqual([
      {
        type: "lock.recovery_retrying",
        name: "alpha-sync",
        attempt: 1,
        error: first,
        code: undefined,
      },
      { type: "lock.recovered", name: "alpha-sync", attempt: 1, max: 5, pid: PID + 2 },
    ]);
    // The next probe compares against the recovered pid.
    s.answer("L3", [{ pid: PID + 2, held: 1 }]);
    await lock.ensureExclusive();
    expect(s.seen.filter((id) => id === "L4")).toHaveLength(2);

    // Rejects twice.
    const s2 = fakeSession();
    const d2 = fakeDeps();
    const l2 = await take(s2, d2);
    const second = new Error("still down");
    s2.answer("L3", [{ pid: PID, held: 0 }]);
    s2.answer("L4", new Error("first"), second);
    expect(lockErrorCode(await caught(l2.ensureExclusive()))).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(d2.events.at(-1)).toEqual({
      type: "lock.recovery_failed",
      name: "alpha-sync",
      attempt: 1,
      error: second,
      code: undefined,
    });

    // Held by another session.
    const s3 = fakeSession();
    const d3 = fakeDeps();
    const l3 = await take(s3, d3);
    s3.answer("L3", [{ pid: PID, held: 0 }]);
    s3.answer("L4", [{ locked: false, pid: PID, holder: HOLDER }]);
    expect(lockErrorCode(await caught(l3.ensureExclusive()))).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(d3.events.at(-1)).toEqual({
      type: "lock.recovery_refused",
      name: "alpha-sync",
      attempt: 1,
      reason: "held",
    });

    // Displaced: the fencing row names another holder.
    const s4 = fakeSession();
    const d4 = fakeDeps();
    const l4 = await take(s4, d4);
    s4.answer("L3", [{ pid: PID + 1, held: 0 }]);
    s4.answer("L4", [{ locked: true, pid: PID + 1, holder: "another-holder" }]);
    const lost = (await caught(l4.ensureExclusive())) as RootstockLockError;
    expect(lost.code).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(lost.stopsRun).toBe(true);
    expect(lost.message).toBe(
      "rootstock lock: the alpha-sync lock was LOST and could not be recovered — the session was severed or no longer holds it; aborting the run (the lock.recovery_* events say which: still down, held by another session, or taken by another run while this one was away)",
    );
    expect(d4.events.at(-1)).toEqual({
      type: "lock.recovery_refused",
      name: "alpha-sync",
      attempt: 1,
      reason: "displaced",
    });
  });

  test("U11: past maxRecoveries the gate reports exhaustion and throws LOST", async () => {
    const slice = lockSlice({
      ...SLICE,
      table: { ...SLICE.table },
      maxRecoveries: 2,
      wait: { ...SLICE.wait },
    });
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps, slice);
    let pid = PID;
    for (let i = 0; i < 2; i += 1) {
      s.answer("L3", [{ pid, held: 0 }]);
      pid += 1;
      s.answer("L4", [{ locked: true, pid, holder: HOLDER }]);
      await lock.ensureExclusive();
    }
    s.answer("L3", [{ pid, held: 0 }]);
    expect(lockErrorCode(await caught(lock.ensureExclusive()))).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(deps.events.at(-1)).toEqual({
      type: "lock.recovery_exhausted",
      name: "alpha-sync",
      recoveries: 2,
      max: 2,
    });
    expect(s.seen.filter((id) => id === "L4")).toHaveLength(2);
  });
});

describe("keepalive and release", () => {
  test("U12: a lost probe is reported and never recovered; a healthy one beats", async () => {
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    lock.startKeepalive();
    lock.startKeepalive();
    expect(deps.intervals).toBe(1);

    s.answer("L3", [{ pid: PID + 3, held: 0 }]);
    deps.fire();
    await flush();
    expect(deps.events.at(-1)).toEqual({
      type: "lock.session_lost",
      name: "alpha-sync",
      expectedPid: PID,
      actualPid: PID + 3,
      held: 0,
    });
    expect(s.seen).toEqual(["L1", "L2", "L3"]);

    deps.fire();
    await flush();
    expect(s.seen.slice(3)).toEqual(["L3", "L5"]);

    const err = new Error("probe down");
    s.answer("L3", err);
    deps.fire();
    await flush();
    expect(deps.events.at(-1)).toEqual({
      type: "lock.keepalive_failed",
      name: "alpha-sync",
      error: err,
      code: undefined,
    });
    expect(s.seen).not.toContain("L4");
  });

  test("U12: a probe in flight under the stall skips the tick; a stalled one does not", async () => {
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    let unblock = () => {};
    s.answer(
      "L3",
      () =>
        new Promise((resolve) => {
          unblock = () => resolve([{ pid: PID, held: 1 }]);
        }),
    );
    lock.startKeepalive();
    deps.fire();
    await flush();
    const probes = () => s.seen.filter((id) => id === "L3").length;
    expect(probes()).toBe(1);
    deps.clock += 59_999;
    deps.fire();
    await flush();
    expect(probes()).toBe(1);
    deps.clock += 1;
    deps.fire();
    await flush();
    expect(probes()).toBe(2);
    unblock();
    await flush();
    lock.stopKeepalive();
  });

  test("U4: a failing unlock is an event, the session still closes, release never rejects", async () => {
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    const unlockErr = Object.assign(new Error("gone"), { code: "57P01" });
    const endErr = new Error("end failed");
    s.answer("L6", unlockErr);
    s.failClose(endErr);
    expect(await lock.release()).toBeUndefined();
    expect(s.closes).toBe(1);
    expect(deps.events.slice(1)).toEqual([
      { type: "lock.unlock_failed", name: "alpha-sync", error: unlockErr, code: "57P01" },
      {
        type: "lock.end_failed",
        name: "alpha-sync",
        phase: "release",
        error: endErr,
        code: undefined,
      },
    ]);
    expect(await lock.release()).toBeUndefined();
    expect(s.closes).toBe(1);
    expect(s.seen.filter((id) => id === "L6")).toHaveLength(1);
  });

  test("U13: release stops the keepalive first, so no tick fires after it", async () => {
    const s = fakeSession();
    const deps = fakeDeps();
    const lock = await take(s, deps);
    lock.startKeepalive();
    await lock.release();
    deps.fire();
    await flush();
    expect(s.seen).toEqual(["L1", "L2", "L6"]);
    lock.startKeepalive();
    expect(deps.intervals).toBe(0);
  });

  test("stopKeepalive never throws and is idempotent", async () => {
    const lock = await take(
      fakeSession(),
      fakeDeps({
        clearInterval: () => {
          throw new Error("clear");
        },
      }),
    );
    lock.stopKeepalive();
    lock.startKeepalive();
    lock.stopKeepalive();
    lock.stopKeepalive();
  });
});

describe("U16: lockOwnershipLost", () => {
  test("only a matching pid holding at least one lock is still owned", () => {
    expect(lockOwnershipLost({ pid: 7, held: 1 }, 7)).toBe(false);
    expect(lockOwnershipLost({ pid: "7", held: "2" }, 7)).toBe(false);
    expect(lockOwnershipLost({ pid: 7, held: 0 }, 7)).toBe(true);
    expect(lockOwnershipLost({ pid: 7, held: Number.NaN }, 7)).toBe(true);
    expect(lockOwnershipLost({ pid: 7, held: "x" }, 7)).toBe(true);
    expect(lockOwnershipLost({ pid: 7 }, 7)).toBe(true);
    expect(lockOwnershipLost(undefined, 7)).toBe(true);
    expect(lockOwnershipLost({ pid: 8, held: 1 }, 7)).toBe(true);
  });
});

describe("lockErrorCode", () => {
  test("reads a lock code off any object, and nothing else", () => {
    expect(lockErrorCode({ code: "ERR_ROOTSTOCK_LOCK_LOST" })).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(lockErrorCode(new Error("x"))).toBeUndefined();
    expect(lockErrorCode({ code: "ERR_ROOTSTOCK_TX_BUSY" })).toBeUndefined();
    expect(lockErrorCode(null)).toBeUndefined();
    expect(
      lockErrorCode({
        get code() {
          throw new Error("hostile");
        },
      }),
    ).toBeUndefined();
  });

  test("the error's name and stopsRun", () => {
    const e = new RootstockLockError("ERR_ROOTSTOCK_LOCK_HELD", "alpha-sync", "x");
    expect(e.name).toBe("RootstockLockError");
    expect(e.stopsRun).toBe(false);
    expect(e.lockName).toBe("alpha-sync");
    expect(e).toBeInstanceOf(Error);
  });
});
