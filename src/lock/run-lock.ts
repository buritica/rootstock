import type { Sql } from "../db/index.ts";
import { perSlice } from "../internal/slice.ts";
import { type RootstockLockError, refusals } from "./errors.ts";
import { type Emit, emitter, failure, type LockEvent } from "./events.ts";
import { lockOwnershipLost } from "./probe.ts";
import type { LockSession } from "./session.ts";
import { admits, assertLockSlice, type LockSlice } from "./slice.ts";
import { L1, L3, L6, type TableStatements, tableStatements } from "./statements.ts";
import { checkWait, type LockWait, pollAcquire } from "./wait.ts";

export interface LockDeps {
  /** Milliseconds. */
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  randomUUID: () => string;
  /** Resolves after ms, or as soon as signal aborts. Never rejects. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onEvent?: (e: LockEvent) => void;
}

export interface RunLock {
  readonly name: string;
  /** The fencing uuid of this acquisition. */
  readonly holder: string;
  /** The gate: resolves while held; recovers when it can; throws LOST or UNVERIFIABLE otherwise. */
  ensureExclusive(): Promise<void>;
  /** Idempotent. */
  startKeepalive(): void;
  /** Synchronous, never throws, idempotent. */
  stopKeepalive(): void;
  /** stopKeepalive, unlock, close, release the turn; each failure is an event; never throws; idempotent. */
  release(): Promise<void>;
}

type Row = Record<string, unknown>;

/** One acquire in progress: what every step after `open` needs. */
export interface Attempt {
  readonly slice: LockSlice;
  readonly name: string;
  readonly deps: LockDeps;
  readonly emit: Emit;
  readonly statements: TableStatements;
  /** Releases a held wait turn; a no-op without one. Called at most once. */
  releaseTurn: () => void;
}

/** The fencing table's statements, after the brand check, built once per slice. */
const statementsOf = perSlice(assertLockSlice, (slice: LockSlice) => tableStatements(slice.table));

/** Emits `lock.refused`, releases any held turn, and returns the error to throw. */
export function refused(a: Attempt, err: RootstockLockError): RootstockLockError {
  a.emit({ type: "lock.refused", name: a.name, code: err.code });
  a.releaseTurn();
  return err;
}

/** Closes the session; a failure is an event, never a throw. */
export async function closeQuietly(
  a: Attempt,
  session: LockSession,
  phase: "acquire-error" | "refusal" | "release",
): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    a.emit({ type: "lock.end_failed", name: a.name, phase, ...failure(error) });
  }
}

/** Step 0's checks that need no I/O: the brand, then the name. */
function validate(slice: LockSlice, name: string, deps: LockDeps): Attempt {
  const statements = statementsOf("acquireRunLock", slice);
  const a: Attempt = {
    slice,
    name,
    deps,
    emit: emitter(deps.onEvent),
    statements,
    releaseTurn: () => {},
  };
  if (!admits(slice, name)) throw refused(a, refusals.name(slice, name));
  return a;
}

/**
 * Takes the lock with one try-lock, or with `opts.wait` by waiting for the
 * turn and polling (§2.6), then fences it (§2.5). The session is opened once
 * and closed on every refusal; the keepalive is not started.
 */
export async function acquireRunLock(
  open: () => LockSession,
  slice: LockSlice,
  name: string,
  deps: LockDeps,
  opts?: { wait?: LockWait },
): Promise<RunLock> {
  const a = validate(slice, name, deps);
  if (opts?.wait !== undefined) return pollAcquire(a, open, checkWait(a, opts.wait));
  const session = open();
  let row: Row | undefined;
  try {
    [row] = await session.sql.unsafe(L1, [name]);
  } catch (err) {
    await closeQuietly(a, session, "acquire-error");
    throw err;
  }
  const locked = row?.locked;
  if (locked === false) {
    await closeQuietly(a, session, "refusal");
    throw refused(a, refusals.held(name));
  }
  if (locked !== true) {
    await closeQuietly(a, session, "refusal");
    throw refused(a, refusals.malfunction(name, locked));
  }
  return fence(a, session, Number(row?.pid));
}

/** Steps 5-7: write the fencing row on the backend that took the lock, and hand the lock out. */
export async function fence(a: Attempt, session: LockSession, pid: number): Promise<RunLock> {
  const { name } = a;
  const holder = a.deps.randomUUID();
  let row: Row | undefined;
  try {
    [row] = await session.sql.unsafe(a.statements.fence, [name, holder]);
  } catch (err) {
    await closeQuietly(a, session, "refusal");
    throw refused(a, refusals.unfenced(a.slice, name, err));
  }
  if (row === undefined || Number(row.pid) !== pid) {
    await closeQuietly(a, session, "refusal");
    throw refused(a, refusals.conn(name, pid, row === undefined ? null : Number(row.pid)));
  }
  a.emit({ type: "lock.acquired", name, pid });
  return held(a, session, pid, holder);
}

/**
 * The compare-and-clear in-flight guard: a probe in flight blocks the next
 * one until it settles or stalls, and a stalled probe that settles late
 * cannot disarm the guard a newer probe holds.
 */
function probeGuard(stallMs: number, now: () => number): () => (() => void) | null {
  let startedAt: number | null = null;
  let generation = 0;
  return () => {
    if (startedAt !== null && now() - startedAt < stallMs) return null;
    startedAt = now();
    generation += 1;
    const mine = generation;
    return () => {
      if (generation === mine) startedAt = null;
    };
  };
}

function held(a: Attempt, session: LockSession, firstPid: number, holder: string): RunLock {
  const { name, slice, deps, emit, statements } = a;
  const sql: Sql = session.sql;
  let pid = firstPid;
  let recoveries = 0;
  let keepalive: { handle: unknown } | undefined;
  let released = false;
  const begin = probeGuard(slice.probeStallSeconds * 1000, deps.now);

  async function claimOnce(): Promise<Row | undefined> {
    const [row] = await sql.unsafe(statements.claim, [name]);
    return row;
  }

  async function recover(): Promise<boolean> {
    if (recoveries >= slice.maxRecoveries) {
      emit({
        type: "lock.recovery_exhausted",
        name,
        recoveries,
        max: slice.maxRecoveries,
      });
      return false;
    }
    recoveries += 1;
    const attempt = recoveries;
    let row: Row | undefined;
    try {
      row = await claimOnce();
    } catch (first) {
      // The first query on a severed session may be the one that pays for
      // the reconnect, so one retry, with no second increment.
      emit({ type: "lock.recovery_retrying", name, attempt, ...failure(first) });
      try {
        row = await claimOnce();
      } catch (second) {
        emit({ type: "lock.recovery_failed", name, attempt, ...failure(second) });
        return false;
      }
    }
    if (row?.locked !== true) {
      emit({ type: "lock.recovery_refused", name, attempt, reason: "held" });
      return false;
    }
    // Taking the lock again says nothing about the gap: only a fencing row
    // still naming this holder proves no other run took it meanwhile. The
    // advisory lock just taken goes when the session closes.
    if (row.holder !== holder) {
      emit({ type: "lock.recovery_refused", name, attempt, reason: "displaced" });
      return false;
    }
    pid = Number(row.pid);
    emit({ type: "lock.recovered", name, attempt, max: slice.maxRecoveries, pid });
    return true;
  }

  function tick(): void {
    const done = begin();
    if (done === null) return;
    void (async () => {
      try {
        const [row] = await sql.unsafe(L3);
        if (lockOwnershipLost(row, pid)) {
          // Reported, never recovered: only the gate recovers.
          emit({
            type: "lock.session_lost",
            name,
            expectedPid: pid,
            actualPid: Number(row?.pid),
            held: Number(row?.held),
          });
          return;
        }
        await sql.unsafe(statements.heartbeat, [name, holder]);
      } catch (error) {
        emit({ type: "lock.keepalive_failed", name, ...failure(error) });
      } finally {
        done();
      }
    })();
  }

  function stopKeepalive(): void {
    if (keepalive === undefined) return;
    const { handle } = keepalive;
    keepalive = undefined;
    try {
      deps.clearInterval(handle);
    } catch {
      // stopKeepalive never throws.
    }
  }

  return Object.freeze({
    name,
    holder,
    async ensureExclusive(): Promise<void> {
      let row: Row | undefined;
      try {
        [row] = await sql.unsafe(L3);
      } catch (err) {
        if (await recover()) return;
        throw refusals.unverifiable(name, err);
      }
      if (lockOwnershipLost(row, pid)) {
        if (await recover()) return;
        throw refusals.lost(name);
      }
    },
    startKeepalive(): void {
      if (keepalive !== undefined || released) return;
      keepalive = { handle: deps.setInterval(tick, slice.heartbeatSeconds * 1000) };
    },
    stopKeepalive,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      stopKeepalive();
      try {
        await sql.unsafe(L6, [name]);
      } catch (error) {
        emit({ type: "lock.unlock_failed", name, ...failure(error) });
      }
      await closeQuietly(a, session, "release");
      a.releaseTurn();
    },
  });
}
