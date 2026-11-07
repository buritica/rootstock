import { pgCode } from "../db/index.ts";
import { perSlice } from "../internal/slice.ts";
import { pause, stalled, within } from "./bound.ts";
import { RootstockLockError, refusals } from "./errors.ts";
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
  /** Opens a fresh session: the acquire's, and a recovery's after a stalled probe. */
  readonly open: () => LockSession;
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

/**
 * How long a session rests after a rejected statement before it sends the
 * next one. postgres.js wedges a query sent in the same turn as an ECONNRESET
 * rejection (C-S1, session.pg.ts X1w); 5 ms was enough in every measured case.
 */
export const SETTLE_MS = 20;

/** The backend pid off an L1 row, or undefined when it is not a positive integer. */
export function pidIn(row: Row | undefined): number | undefined {
  const pid = Number(row?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Step 0's checks that need no I/O: the brand, then the name. */
function validate(
  open: () => LockSession,
  slice: LockSlice,
  name: string,
  deps: LockDeps,
): Attempt {
  const statements = statementsOf("acquireRunLock", slice);
  const a: Attempt = {
    slice,
    name,
    deps,
    emit: emitter(deps.onEvent),
    statements,
    open,
    releaseTurn: () => {},
  };
  if (!admits(slice, name)) throw refused(a, refusals.name(slice, name));
  return a;
}

/**
 * Takes the lock with one try-lock, or with `opts.wait` by waiting for the
 * turn and polling (§2.6), then fences it (§2.5). The session is closed on
 * every refusal; the keepalive is not started. `open` is called once for the
 * acquire and once more for each recovery after a stalled probe, so each call
 * must return a session on a new dedicated client, never a shared one.
 */
export async function acquireRunLock(
  open: () => LockSession,
  slice: LockSlice,
  name: string,
  deps: LockDeps,
  opts?: { wait?: LockWait },
): Promise<RunLock> {
  const a = validate(open, slice, name, deps);
  if (opts?.wait !== undefined) return pollAcquire(a, checkWait(a, opts.wait));
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
  const pid = pidIn(row);
  if (pid === undefined) {
    // A lock taken on a backend that cannot name itself is a malfunction,
    // not a pool: the answer is the pid it gave.
    await closeQuietly(a, session, "refusal");
    throw refused(a, refusals.malfunction(name, row?.pid));
  }
  return fence(a, session, pid);
}

/** What bounds a waited acquire's fence: the wait's deadline and signal (§2.6). */
export interface FenceBound {
  /** Milliseconds the fence may take, read when it is sent. */
  readonly ms: () => number;
  readonly signal?: AbortSignal;
  /** The refusal for a fence that did not answer in time, or whose wait was aborted. */
  readonly refusal: (why: "timeout" | "aborted", cause: Error) => RootstockLockError;
}

/**
 * Steps 5-7: write the fencing row on the backend that took the lock, and
 * hand the lock out. Owns the session from here: every throw closes it and
 * releases the turn first.
 */
export async function fence(
  a: Attempt,
  session: LockSession,
  pid: number,
  bound?: FenceBound,
): Promise<RunLock> {
  const { name } = a;
  let holder: string;
  try {
    // Postgres prints a uuid in lowercase; the recovery compare is by text.
    holder = String(a.deps.randomUUID()).toLowerCase();
  } catch (err) {
    await closeQuietly(a, session, "acquire-error");
    a.releaseTurn();
    throw err;
  }
  let row: Row | undefined;
  try {
    const work = session.sql.unsafe(a.statements.fence, [name, holder]);
    if (bound === undefined) {
      [row] = await work;
    } else {
      const ms = bound.ms();
      const fenced = await within(a.deps, work, ms, bound.signal);
      if (fenced === "timeout" || fenced === "aborted") {
        await closeQuietly(a, session, "refusal");
        throw refused(a, bound.refusal(fenced, stalled(`the fence for ${name}`, ms)));
      }
      [row] = fenced.value;
    }
  } catch (err) {
    if (err instanceof RootstockLockError) throw err;
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

/** Thrown by a statement the lock was about to send after release() began; never escapes. */
class AfterRelease extends Error {}

/**
 * How much longer than the driver's own bounded close a recovery waits for
 * the stalled session to close, so a driver that ends on time is not
 * reported as a stalled close.
 */
export const CLOSE_MARGIN_MS = 1000;

/** The recovery poll's floor: `wait.pollIntervalMs` may be as low as 10 for a waited acquire. */
export const RECOVERY_POLL_FLOOR_MS = 100;

/** How a recovery ended: `stalled` carries the timeout that made it unverifiable. */
type Recovery = "recovered" | "failed" | "released" | { stalled: Error };

function held(a: Attempt, firstSession: LockSession, firstPid: number, holder: string): RunLock {
  const { name, slice, deps, emit, statements } = a;
  /** The session every statement goes to; a recovery after a stalled probe replaces it. */
  let session = firstSession;
  /** The session a stalled-probe recovery is closing: nothing on it reports, nothing goes to it. */
  let retired: LockSession | undefined;
  /** A stalled-probe recovery is moving the lock: the keepalive stands down until it ends. */
  let replacing = false;
  /** Whether the current session's backend took the advisory lock (release() unlocks only then). */
  let holding = true;
  const stallMs = slice.probeStallSeconds * 1000;
  let pid = firstPid;
  let recoveries = 0;
  let keepalive: { handle: unknown } | undefined;
  let released = false;
  /** Set once a gate refuses: every later gate rethrows it, with no I/O. */
  let terminal: RootstockLockError | undefined;
  /** The gate in flight, shared by concurrent callers so one blip recovers once. */
  let gating: Promise<void> | undefined;
  /** A statement rejected: every statement sent before this time rests until it (C-S1). */
  let restUntil = Number.NEGATIVE_INFINITY;
  const begin = probeGuard(stallMs, deps.now);

  /**
   * Every statement after the fence goes through here: it rests out the
   * settle after any rejection on the session, whichever statement rejected,
   * and after release() began it sends nothing but L6.
   */
  async function run(text: string, params?: readonly unknown[]): Promise<Row[]> {
    const rest = restUntil - deps.now();
    if (rest > 0) await pause(deps, rest);
    if (released && text !== L6) throw new AfterRelease();
    // Bound once sent: a rejection from a session a recovery has since
    // replaced does not make the new one rest.
    const target = session;
    try {
      return await target.sql.unsafe(text, params);
    } catch (err) {
      if (target === session) restUntil = deps.now() + SETTLE_MS;
      throw err;
    }
  }

  /** L6 bounded by `ms`, best effort: a rejection or a timeout is `lock.unlock_failed`. */
  async function unlock(ms: number): Promise<void> {
    try {
      if ((await within(deps, run(L6, [name]), ms)) === "timeout") {
        emit({ type: "lock.unlock_failed", name, ...failure(stalled(`unlocking ${name}`, ms)) });
      }
    } catch (error) {
      emit({ type: "lock.unlock_failed", name, ...failure(error) });
    }
  }

  /** L4 bounded by the stall: the row, or the timeout as a stall. */
  async function claimOnce(): Promise<{ row: Row | undefined } | { stalled: Error }> {
    const claimed = await within(deps, run(statements.claim, [name]), stallMs);
    if (claimed === "timeout")
      return { stalled: stalled(`the recovery claim for ${name}`, stallMs) };
    return { row: claimed.value[0] };
  }

  /**
   * After an L4 on the backend the lock already had, following a probe that
   * REJECTED: the level stacked only if the backend now holds two. Anything
   * less (a backend restarted onto the same pid, an unlock_all) is a fresh
   * take and the only level, so it stays. A re-probe that rejects cannot tell,
   * so the level stays too: release()'s close frees a stacked one.
   */
  async function undoStackedLevel(): Promise<Error | undefined> {
    let rows: Row[];
    try {
      const probed = await within(deps, run(L3), stallMs);
      if (probed === "timeout") return stalled(`the ownership probe for ${name}`, stallMs);
      rows = probed.value;
    } catch {
      return undefined;
    }
    if (Number(rows[0]?.pid) === pid && Number(rows[0]?.held) >= 2) await unlock(stallMs);
    return undefined;
  }

  /**
   * After a probe that stalled: a claim on the same session would queue
   * behind the hung probe, so the stalled session is closed (which frees the
   * advisory lock if its backend still hears it) and a fresh one takes its
   * place. The closed session's backend may still hold the lock until the
   * server ends it (see outwaitStalledBackend).
   */
  async function reopen(attempt: number): Promise<"released" | "failed" | undefined> {
    const stale = session;
    retired = stale;
    holding = false;
    const ms = slice.endTimeoutSeconds * 1000 + CLOSE_MARGIN_MS;
    // One end_failed at most, and none once the bound has fired or release() began.
    let bounded = false;
    const closing = Promise.resolve()
      .then(() => stale.close())
      .then(
        () => {},
        (error) => {
          if (!bounded && !released) {
            emit({ type: "lock.end_failed", name, phase: "recovery", ...failure(error) });
          }
        },
      );
    const closed = await within(deps, closing, ms);
    bounded = true;
    if (released) return "released";
    if (closed === "timeout") {
      const error = stalled(`closing the stalled session for ${name}`, ms);
      emit({ type: "lock.end_failed", name, phase: "recovery", ...failure(error) });
    }
    const { open } = a;
    let fresh: LockSession;
    try {
      fresh = open();
    } catch (error) {
      emit({ type: "lock.recovery_failed", name, attempt, ...failure(error) });
      return "failed";
    }
    // Assigned in the same turn as the released check above, so release()
    // always closes whichever session is current.
    session = fresh;
    retired = undefined;
    restUntil = Number.NEGATIVE_INFINITY;
    emit({ type: "lock.session_replaced", name, attempt, previousPid: pid });
    return undefined;
  }

  /**
   * After a stalled probe, a fresh claim that reads the lock held while the
   * fencing row still names this holder is most likely reading this run's own
   * stalled backend, which the server has not ended yet (a black-holed
   * socket can keep it for as long as the server's TCP keepalive allows).
   * L9 ends that backend, and only while pg_locks shows it, the pid this run
   * last held the lock on, holding this name and the fencing row still names
   * this run, in one statement. If another run's backend has
   * taken that pid and the lock between its try-lock and its fence, ending it
   * makes that run refuse (its fence fails), which is safe. No row: the
   * holder is not this run's backend, so the poll stops. Then the claim is
   * polled every `wait.pollIntervalMs` (at least RECOVERY_POLL_FLOOR_MS) until
   * the stall bound has passed. Polling is safe: a try-lock never takes a lock
   * another backend holds, and a run that takes it meanwhile fences its own
   * holder, which ends the poll. `own`: pg_locks showed this run's backend.
   */
  async function outwaitStalledBackend(
    attempt: number,
    first: Row | undefined,
  ): Promise<{ row: Row | undefined; own: boolean } | { stalled: Error } | "released" | "failed"> {
    let row = first;
    const ours = () => row?.locked !== true && row?.holder === holder;
    if (!ours()) return { row, own: false };
    const stalledPid = pid;
    let own = false;
    try {
      const ended = await within(
        deps,
        run(statements.terminate, [name, stalledPid, holder]),
        stallMs,
      );
      if (released) return "released";
      if (ended === "timeout") {
        const error = stalled(`ending the stalled backend for ${name}`, stallMs);
        emit({ type: "lock.recovery_failed", name, attempt, ...failure(error) });
        return { stalled: error };
      }
      if (ended.value.length === 0) {
        // That backend may have exited between the claim and L9: one more
        // claim tells a lock just freed from one another backend holds.
        const next = await claim(attempt, false);
        if (typeof next === "string" || "stalled" in next) return next;
        return { row: next.row, own: false };
      }
      own = true;
      if (ended.value[0]?.terminated === true) {
        emit({ type: "lock.stalled_backend_terminated", name, attempt, pid: stalledPid });
      }
    } catch (error) {
      if (released) return "released";
      // insufficient_privilege comes from pg_terminate_backend itself, after
      // pg_locks matched: only then was the backend seen holding the lock.
      own = pgCode(error) === "42501";
      emit({ type: "lock.terminate_failed", name, attempt, pid: stalledPid, ...failure(error) });
    }
    const every = Math.max(slice.wait.pollIntervalMs, RECOVERY_POLL_FLOOR_MS);
    const until = deps.now() + stallMs;
    while (ours() && deps.now() < until) {
      // A broken sleep must not turn the poll into a spin: stop and refuse.
      if (!(await pause(deps, Math.min(every, until - deps.now())))) break;
      if (released) return "released";
      const next = await claim(attempt, false);
      if (typeof next === "string" || "stalled" in next) return next;
      row = next.row;
    }
    return { row, own };
  }

  /**
   * One recovery claim, with every way it can end that is not a row: released,
   * failed (a rejection, retried once when `retry`), or stalled (never retried).
   */
  async function claim(
    attempt: number,
    retry: boolean,
  ): Promise<{ row: Row | undefined } | { stalled: Error } | "released" | "failed"> {
    let claimed: { row: Row | undefined } | { stalled: Error };
    try {
      claimed = await claimOnce();
    } catch (first) {
      if (released) return "released";
      if (!retry) {
        emit({ type: "lock.recovery_failed", name, attempt, ...failure(first) });
        return "failed";
      }
      // The first query on a severed session may be the one that pays for
      // the reconnect, so one retry, with no second increment.
      emit({ type: "lock.recovery_retrying", name, attempt, ...failure(first) });
      try {
        claimed = await claimOnce();
      } catch (second) {
        if (released) return "released";
        emit({ type: "lock.recovery_failed", name, attempt, ...failure(second) });
        return "failed";
      }
    }
    if (released) return "released";
    if ("stalled" in claimed) {
      emit({ type: "lock.recovery_failed", name, attempt, ...failure(claimed.stalled) });
    }
    return claimed;
  }

  /**
   * `probe`: how the gate's L3 failed. `rejected`: an L4 on the same pid may
   * have stacked a level. `stalled`: the claim goes on a fresh session.
   */
  async function recover(probe: "lost" | "rejected" | "stalled"): Promise<Recovery> {
    if (released) return "released";
    if (recoveries >= slice.maxRecoveries) {
      emit({
        type: "lock.recovery_exhausted",
        name,
        recoveries,
        max: slice.maxRecoveries,
      });
      return "failed";
    }
    recoveries += 1;
    const attempt = recoveries;
    if (probe !== "stalled") return settle(probe, attempt, await claim(attempt, true), false);
    replacing = true;
    try {
      const reopened = await reopen(attempt);
      if (reopened !== undefined) return reopened;
      const claimed = await claim(attempt, true);
      if (typeof claimed === "string" || "stalled" in claimed) return claimed;
      const outwaited = await outwaitStalledBackend(attempt, claimed.row);
      if (typeof outwaited === "string" || "stalled" in outwaited) return outwaited;
      return await settle(probe, attempt, outwaited, outwaited.own);
    } finally {
      replacing = false;
    }
  }

  /** Steps 4-7 of a recovery: what the claim's row means. `own`: the holder is this run's stalled backend. */
  async function settle(
    probe: "lost" | "rejected" | "stalled",
    attempt: number,
    claimed: { row: Row | undefined } | { stalled: Error } | "released" | "failed",
    own: boolean,
  ): Promise<Recovery> {
    if (typeof claimed === "string" || "stalled" in claimed) return claimed;
    const { row } = claimed;
    if (row?.locked !== true) {
      // A holder pg_locks showed is this run's own stalled backend: say which one.
      own = own && row?.holder === holder;
      emit({
        type: "lock.recovery_refused",
        name,
        attempt,
        reason: "held",
        ...(own ? { stalledPid: pid } : {}),
      });
      return "failed";
    }
    // Taking the lock again says nothing about the gap: only a fencing row
    // still naming this holder proves no other run took it meanwhile. The
    // advisory lock just taken is not ours to keep, so it goes now.
    holding = true;
    if (row.holder !== holder) {
      await unlock(stallMs);
      holding = false;
      if (released) return "released";
      emit({ type: "lock.recovery_refused", name, attempt, reason: "displaced" });
      return "failed";
    }
    const before = pid;
    // Assigned before any further await, so a keepalive tick that reads the
    // new backend compares against it.
    pid = Number(row.pid);
    if (probe === "rejected" && pid === before) {
      const stall = await undoStackedLevel();
      if (released) return "released";
      if (stall !== undefined) return { stalled: stall };
    }
    emit({ type: "lock.recovered", name, attempt, max: slice.maxRecoveries, pid });
    return "recovered";
  }

  function latch(err: RootstockLockError): RootstockLockError {
    terminal ??= err;
    return terminal;
  }

  async function gate(): Promise<void> {
    let probe: { rows: Row[] } | { error: unknown } | "timeout";
    try {
      const probed = await within(deps, run(L3), stallMs);
      probe = probed === "timeout" ? probed : { rows: probed.value };
    } catch (error) {
      probe = { error };
    }
    // After release() the lock is not held, whatever the probe read.
    if (released) throw latch(refusals.lost(name));
    const kind =
      probe === "timeout"
        ? "stalled"
        : "error" in probe
          ? "rejected"
          : lockOwnershipLost(probe.rows[0], pid)
            ? "lost"
            : undefined;
    if (kind === undefined) return;
    const refusal =
      kind === "lost"
        ? refusals.lost(name)
        : refusals.unverifiable(
            name,
            probe !== "timeout" && "error" in probe
              ? probe.error
              : stalled(`the ownership probe for ${name}`, stallMs),
          );
    const outcome = await recover(kind);
    if (outcome === "released") throw latch(refusals.lost(name));
    if (outcome === "recovered") return;
    throw latch(outcome === "failed" ? refusal : refusals.unverifiable(name, outcome.stalled));
  }

  function tick(): void {
    if (released || terminal !== undefined || replacing) return;
    const done = begin();
    if (done === null) return;
    const asked = pid;
    const on = session;
    /** A recovery is replacing, or has replaced, the session this tick went to: the gate owns the answer. */
    const stale = () => released || terminal !== undefined || session !== on || on === retired;
    void (async () => {
      try {
        const [row] = await run(L3);
        if (stale()) return;
        if (lockOwnershipLost(row, pid)) {
          // A gate in flight owns this answer (it may be moving the lock to
          // a new backend right now), so the tick reports nothing then.
          if (gating !== undefined || pid !== asked) return;
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
        await run(statements.heartbeat, [name, holder]);
      } catch (error) {
        if (!stale()) emit({ type: "lock.keepalive_failed", name, ...failure(error) });
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
    ensureExclusive(): Promise<void> {
      if (terminal !== undefined) return Promise.reject(terminal);
      // After release() the lock is not held; saying so needs no I/O.
      if (released) return Promise.reject(latch(refusals.lost(name)));
      gating ??= gate().finally(() => {
        gating = undefined;
      });
      return gating;
    },
    startKeepalive(): void {
      if (keepalive !== undefined || released || terminal !== undefined) return;
      keepalive = { handle: deps.setInterval(tick, slice.heartbeatSeconds * 1000) };
    },
    stopKeepalive,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        stopKeepalive();
        // A session a failed recovery already closed holds nothing to unlock.
        if (holding) await unlock(slice.endTimeoutSeconds * 1000);
      } finally {
        // The turn goes as soon as L6 is done or out of time: a close that
        // hangs must not hold the next waiter (the database lock still does,
        // until the session ends). The close is bounded by the driver.
        a.releaseTurn();
        await closeQuietly(a, session, "release");
      }
    },
  });
}
