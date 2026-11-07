import { intIn, isRecord } from "../internal/slice.ts";
import { ABORT_SIGNAL, type RootstockLockError, refusals } from "./errors.ts";
import { failure } from "./events.ts";
import { type Attempt, closeQuietly, fence, type RunLock, refused } from "./run-lock.ts";
import type { LockSession } from "./session.ts";
import { L1, L6 } from "./statements.ts";
import { enqueueTurn, isTurnQueue, type TurnQueue } from "./turns.ts";

export type LockWait = { mode: "poll"; ms: number; signal?: AbortSignal; turns: TurnQueue };

// By tag, not instanceof: a signal from another realm or module copy is still one.
const isAbortSignal = (v: unknown): boolean =>
  Object.prototype.toString.call(v) === `[object ${ABORT_SIGNAL}]`;

/** §2.6's validation: anything else refuses WAIT (emitting `lock.refused`). */
export function checkWait(a: Attempt, wait: unknown): LockWait {
  const w = isRecord(wait) ? wait : undefined;
  const ms = w?.ms;
  const ok =
    w !== undefined &&
    w.mode === "poll" &&
    intIn(ms, 0, a.slice.wait.maxMs) &&
    isTurnQueue(w.turns) &&
    (w.signal === undefined || isAbortSignal(w.signal));
  if (!ok) {
    const summary = w === undefined ? wait : { mode: w.mode, ms };
    throw refused(a, refusals.wait(a.slice, a.name, summary));
  }
  return wait as LockWait;
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
      a.deps.sleep(Math.max(0, deadline - a.deps.now()), cancel.signal),
    ]);
  } finally {
    cancel.abort();
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) return "aborted";
  return got ? "turn" : "timeout";
}

/** §2.6: take the turn, then poll L1 until it is ours, then fence (§2.5 step 5 on). */
export async function pollAcquire(
  a: Attempt,
  open: () => LockSession,
  wait: LockWait,
): Promise<RunLock> {
  const { deps, name, slice, emit } = a;
  const { signal } = wait;
  const start = deps.now();
  const deadline = start + wait.ms;
  const report = (outcome: "acquired" | "timeout" | "aborted" | "error"): number => {
    const waitedMs = deps.now() - start;
    emit({ type: "lock.wait", name, mode: "poll", outcome, waitedMs });
    return waitedMs;
  };
  /** Closes the session, reports the wait, then refuses: the order every refusal after open keeps. */
  const giveUp = async (
    session: LockSession,
    outcome: "timeout" | "aborted" | "error",
    refusal: (waitedMs: number) => RootstockLockError,
  ): Promise<never> => {
    await closeQuietly(a, session, "refusal");
    throw refused(a, refusal(report(outcome)));
  };

  const turn = enqueueTurn(wait.turns, name);
  a.releaseTurn = turn.done;
  const queued = await awaitTurn(a, turn.ahead, deadline, signal);
  if (queued === "aborted") throw refused(a, refusals.abandoned(name, report("aborted")));
  if (queued === "timeout") throw refused(a, refusals.heldAfterWait(name, report("timeout")));

  let session: LockSession;
  try {
    session = open();
  } catch (err) {
    a.releaseTurn();
    throw err;
  }
  for (;;) {
    let row: Record<string, unknown> | undefined;
    try {
      [row] = await session.sql.unsafe(L1, [name]);
    } catch (err) {
      await closeQuietly(a, session, "acquire-error");
      report("error");
      a.releaseTurn();
      throw err;
    }
    const locked = row?.locked;
    if (locked === true) {
      if (signal?.aborted) {
        // The last-poll race: never hand out a lock taken after the abort.
        try {
          await session.sql.unsafe(L6, [name]);
        } catch (error) {
          emit({ type: "lock.unlock_failed", name, ...failure(error) });
        }
        return giveUp(session, "aborted", (ms) => refusals.abandoned(name, ms));
      }
      report("acquired");
      return fence(a, session, Number(row?.pid));
    }
    if (locked !== false) {
      return giveUp(session, "error", () => refusals.malfunction(name, locked));
    }
    if (deps.now() >= deadline) {
      return giveUp(session, "timeout", (ms) => refusals.heldAfterWait(name, ms));
    }
    await deps.sleep(Math.min(slice.wait.pollIntervalMs, deadline - deps.now()), signal);
    if (signal?.aborted) {
      return giveUp(session, "aborted", (ms) => refusals.abandoned(name, ms));
    }
  }
}
