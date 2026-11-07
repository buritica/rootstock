import { pgCode, type Row } from "../db/index.ts";
import { intIn, isRecord } from "../internal/slice.ts";
import { pause, stalled, within } from "./bound.ts";
import { ABORT_SIGNAL, type RootstockLockError, refusals } from "./errors.ts";
import { failure } from "./events.ts";
import { type Attempt, closeQuietly, fence, pidIn, type RunLock, refused } from "./run-lock.ts";
import type { LockSession } from "./session.ts";
import { B0, B1, B2, L1, L6 } from "./statements.ts";
import { enqueueTurn, isTurnQueue, type TurnQueue } from "./turns.ts";

export type LockWait =
  | { mode: "poll"; ms: number; signal?: AbortSignal; turns: TurnQueue }
  | { mode: "block"; ms: number; signal?: AbortSignal; turns: TurnQueue };

// By tag, not instanceof: a signal from another realm or module copy is still
// one. The tag can be forged, so the members the wait uses are checked too.
function isAbortSignal(v: unknown): boolean {
  try {
    if (Object.prototype.toString.call(v) !== `[object ${ABORT_SIGNAL}]`) return false;
    const s = v as Record<string, unknown>;
    return (
      typeof s.aborted === "boolean" &&
      typeof s.addEventListener === "function" &&
      typeof s.removeEventListener === "function"
    );
  } catch {
    return false;
  }
}

/**
 * §2.6's validation, with block mode (w4d §8.1): anything else refuses WAIT
 * (emitting `lock.refused`). Block mode needs `wait.block` in the slice and
 * an `ms` of at least 1 (a lock_timeout of 0 means forever). Each field is
 * read once, and the wait that comes back is a fresh frozen copy of the
 * values checked, so a getter cannot change one afterwards.
 */
export function checkWait(a: Attempt, wait: unknown): LockWait {
  const w = isRecord(wait) ? wait : undefined;
  const { mode, ms, turns, signal } = w ?? {};
  const needsBlock = mode === "block" && a.slice.wait.block === undefined;
  const ok =
    w !== undefined &&
    (mode === "poll" || (mode === "block" && !needsBlock)) &&
    intIn(ms, mode === "block" ? 1 : 0, a.slice.wait.maxMs) &&
    isTurnQueue(turns) &&
    (signal === undefined || isAbortSignal(signal));
  if (!ok) {
    const summary = w === undefined ? wait : { mode, ms };
    throw refused(a, refusals.wait(a.slice, a.name, summary, needsBlock));
  }
  return Object.freeze(
    signal === undefined ? { mode, ms, turns } : { mode, ms, turns, signal: signal as AbortSignal },
  );
}

/**
 * Waits for the predecessor's link, racing the deadline (via `deps.sleep`)
 * and the caller's signal. The sleep is cancelled once the race is decided.
 */
async function awaitTurn(
  a: Attempt,
  ahead: Promise<void> | undefined,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<"turn" | "timeout" | "aborted"> {
  if (signal?.aborted) return "aborted";
  if (ahead === undefined) return "turn";
  let got = false;
  const cancel = new AbortController();
  const onAbort = () => cancel.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([
      ahead.then(() => {
        got = true;
      }),
      // A sleep that rejects ends the race as the deadline would: fail closed.
      pause(a.deps, Math.max(0, deadline - a.deps.now()), cancel.signal),
    ]);
  } finally {
    cancel.abort();
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) return "aborted";
  return got ? "turn" : "timeout";
}

/** §2.6: take the turn, then poll L1 until it is ours, then fence (§2.5 step 5 on). */
export async function pollAcquire(a: Attempt, wait: LockWait): Promise<RunLock> {
  const { deps, name, slice, emit } = a;
  const { signal } = wait;
  const start = deps.now();
  const deadline = start + wait.ms;
  const report = (outcome: "acquired" | "timeout" | "aborted" | "error"): number => {
    const waitedMs = deps.now() - start;
    emit({ type: "lock.wait", name, mode: "poll", outcome, waitedMs });
    return waitedMs;
  };

  /**
   * How long a statement of the wait may take: what is left of the wait, but
   * never less than the slice's probe stall, so the last poll at the deadline
   * (and every poll of an `ms: 0` wait) still gets its answer.
   */
  const statementMs = () => Math.max(deadline - deps.now(), slice.probeStallSeconds * 1000);

  const turn = enqueueTurn(wait.turns, name);
  a.releaseTurn = turn.done;
  /** Open and not yet closed or handed to the fence. */
  let session: LockSession | undefined;
  /** Closes the session, reports the wait, then refuses: the order every refusal after open keeps. */
  const giveUp = async (
    outcome: "timeout" | "aborted" | "error",
    refusal: (waitedMs: number) => RootstockLockError,
  ): Promise<never> => {
    const s = session as LockSession;
    session = undefined;
    await closeQuietly(a, s, "refusal");
    throw refused(a, refusal(report(outcome)));
  };
  try {
    const queued = await awaitTurn(a, turn.ahead, deadline, signal);
    if (queued === "aborted") throw refused(a, refusals.abandoned(name, report("aborted")));
    if (queued === "timeout") throw refused(a, refusals.heldAfterWait(name, report("timeout")));

    const { open } = a;
    session = open();
    for (;;) {
      let row: Record<string, unknown> | undefined;
      let polled: { value: Record<string, unknown>[] } | "timeout" | "aborted";
      try {
        // An L1 in flight is bounded too: a hung one must not hold the turn.
        polled = await within(deps, session.sql.unsafe(L1, [name]), statementMs(), signal);
      } catch (err) {
        const s = session;
        session = undefined;
        await closeQuietly(a, s, "acquire-error");
        report("error");
        throw err;
      }
      if (polled === "aborted")
        return await giveUp("aborted", (ms) => refusals.abandoned(name, ms));
      if (polled === "timeout") {
        return await giveUp("timeout", (ms) => refusals.heldAfterWait(name, ms));
      }
      [row] = polled.value;
      const locked = row?.locked;
      if (locked === true) {
        if (signal?.aborted) {
          // The last-poll race: never hand out a lock taken after the abort.
          try {
            await session.sql.unsafe(L6, [name]);
          } catch (error) {
            emit({ type: "lock.unlock_failed", name, ...failure(error) });
          }
          return await giveUp("aborted", (ms) => refusals.abandoned(name, ms));
        }
        const pid = pidIn(row);
        if (pid === undefined) {
          return await giveUp("error", () => refusals.malfunction(name, row?.pid));
        }
        report("acquired");
        const s = session;
        session = undefined;
        const lock = await fence(a, s, pid, {
          ms: statementMs,
          signal,
          refusal: (why, cause) =>
            why === "aborted"
              ? refusals.abandoned(name, deps.now() - start)
              : refusals.unfenced(slice, name, cause),
        });
        if (signal?.aborted) {
          // The abort landed during the fence: the lock goes back.
          await lock.release();
          throw refused(a, refusals.abandoned(name, deps.now() - start));
        }
        return lock;
      }
      if (locked !== false) {
        return await giveUp("error", () => refusals.malfunction(name, locked));
      }
      // An abort wins over the deadline: the caller asked to stop.
      if (signal?.aborted) {
        return await giveUp("aborted", (ms) => refusals.abandoned(name, ms));
      }
      if (deps.now() >= deadline) {
        return await giveUp("timeout", (ms) => refusals.heldAfterWait(name, ms));
      }
      // A rejecting sleep is swallowed: the signal is checked right after it.
      await pause(deps, Math.min(slice.wait.pollIntervalMs, deadline - deps.now()), signal);
      if (signal?.aborted) {
        return await giveUp("aborted", (ms) => refusals.abandoned(name, ms));
      }
    }
  } catch (err) {
    // Any throw the paths above did not plan for (a throwing clock, a broken
    // hook into the driver) still closes the session and frees the turn.
    if (session !== undefined) {
      const s = session;
      session = undefined;
      await closeQuietly(a, s, "acquire-error");
    }
    a.releaseTurn();
    throw err;
  }
}

/** Ends a session at once (block mode's abort): destroy() when it has one, else close(). */
async function destroyQuietly(a: Attempt, session: LockSession): Promise<void> {
  try {
    await (session.destroy === undefined ? session.close() : session.destroy());
  } catch (error) {
    a.emit({ type: "lock.end_failed", name: a.name, phase: "acquire-error", ...failure(error) });
  }
}

/**
 * w4d §8.1: take the turn, open, save and set lock_timeout and
 * client_connection_check_interval (B0, B1), block in pg_advisory_lock (B2),
 * restore the settings (B3) before the fence, then fence (§2.5 step 5 on).
 * Only the session the acquire opens runs B0-B3; a recovery's fresh session
 * never does.
 */
export async function blockAcquire(a: Attempt, wait: LockWait): Promise<RunLock> {
  const { deps, name, slice, emit } = a;
  const { signal } = wait;
  // checkWait refused a block-mode wait on a slice without it.
  const { checkIntervalMs } = slice.wait.block as { readonly checkIntervalMs: number };
  const stall = slice.probeStallSeconds * 1000;
  const start = deps.now();
  const deadline = start + wait.ms;
  const report = (outcome: "acquired" | "timeout" | "aborted" | "error"): number => {
    const waitedMs = deps.now() - start;
    emit({ type: "lock.wait", name, mode: "block", outcome, waitedMs });
    return waitedMs;
  };

  const turn = enqueueTurn(wait.turns, name);
  a.releaseTurn = turn.done;
  /** Open and not yet closed or handed to the fence. */
  let session: LockSession | undefined;
  /** Takes the session out of `session`, so nothing below ends it twice. */
  const take = (): LockSession => {
    const s = session as LockSession;
    session = undefined;
    return s;
  };
  /** Closes the session, reports the wait, then refuses. */
  const giveUp = async (
    outcome: "timeout" | "aborted" | "error",
    refusal: (waitedMs: number) => RootstockLockError,
  ): Promise<never> => {
    await closeQuietly(a, take(), "refusal");
    throw refused(a, refusal(report(outcome)));
  };
  /** Closes the session and reports the wait; the catch below frees the turn and rethrows untouched. */
  const fail = async (err: unknown): Promise<never> => {
    await closeQuietly(a, take(), "acquire-error");
    report("error");
    throw err;
  };
  /** A statement bounded by the probe stall: its rows, or the stall as a thrown error. */
  const bounded = async (
    text: string,
    params: readonly unknown[],
    what: string,
  ): Promise<Row[]> => {
    const done = await within(deps, (session as LockSession).sql.unsafe(text, params), stall);
    if (done === "timeout") throw stalled(what, stall);
    return done.value;
  };
  try {
    const queued = await awaitTurn(a, turn.ahead, deadline, signal);
    if (queued === "aborted") throw refused(a, refusals.abandoned(name, report("aborted")));
    if (queued === "timeout") throw refused(a, refusals.heldAfterWait(name, report("timeout")));

    const { open } = a;
    session = open();
    let settings: [string, string];
    let remainingMs: number;
    try {
      const [row] = await bounded(B0, [], `the settings read for ${name}`);
      const { lt, cc } = row ?? {};
      if (typeof lt !== "string" || typeof cc !== "string") {
        throw new Error(`rootstock lock: the settings read for ${name} did not answer two texts`);
      }
      settings = [lt, cc];
      remainingMs = Math.max(1, deadline - deps.now());
      await bounded(B1, [`${remainingMs}ms`, `${checkIntervalMs}ms`], `the settings for ${name}`);
    } catch (err) {
      return await fail(err);
    }

    let blocked: { value: Row[] } | "timeout" | "aborted";
    try {
      blocked = await within(deps, session.sql.unsafe(B2, [name]), remainingMs + stall, signal);
    } catch (err) {
      if (pgCode(err) === "55P03") {
        return await giveUp("timeout", (ms) => refusals.heldAfterWait(name, ms));
      }
      return await fail(err);
    }
    if (blocked === "aborted") {
      // The backend may still be waiting: the socket goes now, not after it.
      await destroyQuietly(a, take());
      throw refused(a, refusals.abandoned(name, report("aborted")));
    }
    if (blocked === "timeout") {
      // The server did not honour lock_timeout.
      return await giveUp("timeout", (ms) => refusals.heldAfterWait(name, ms));
    }
    const [row] = blocked.value;
    if (row?.locked !== true) {
      return await giveUp("error", () => refusals.malfunction(name, row?.locked));
    }
    const pid = pidIn(row);
    if (pid === undefined) {
      return await giveUp("error", () => refusals.malfunction(name, row?.pid));
    }
    if (signal?.aborted) {
      // The last-grant race: never hand out a lock granted after the abort.
      try {
        await session.sql.unsafe(L6, [name]);
      } catch (error) {
        emit({ type: "lock.unlock_failed", name, ...failure(error) });
      }
      return await giveUp("aborted", (ms) => refusals.abandoned(name, ms));
    }

    try {
      await bounded(B1, settings, `restoring the settings for ${name}`);
    } catch (err) {
      try {
        const unlocked = await within(deps, session.sql.unsafe(L6, [name]), stall);
        if (unlocked === "timeout") {
          emit({
            type: "lock.unlock_failed",
            name,
            ...failure(stalled(`unlocking ${name}`, stall)),
          });
        }
      } catch (error) {
        emit({ type: "lock.unlock_failed", name, ...failure(error) });
      }
      return await fail(err);
    }

    report("acquired");
    return await fence(a, take(), pid, {
      ms: () => stall,
      refusal: (_why, cause) => refusals.unfenced(slice, name, cause),
    });
  } catch (err) {
    // Any throw the paths above did not plan for (a throwing clock, a broken
    // hook into the driver) still closes the session and frees the turn.
    if (session !== undefined) await closeQuietly(a, take(), "acquire-error");
    a.releaseTurn();
    throw err;
  }
}
