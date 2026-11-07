import { pgCode } from "../db/index.ts";
import { safeHook } from "../internal/slice.ts";
import type { LockErrorCode } from "./errors.ts";

type Err = { error: unknown; code: string | undefined };

/**
 * What the lock reports. The five failure events carry the thrown error
 * itself: the lock binds only its name, so no bound value can reach a
 * message, and these are the lines a lost-lock post-mortem starts from.
 */
export type LockEvent =
  | { type: "lock.acquired"; name: string; pid: number }
  | { type: "lock.refused"; name: string; code: LockErrorCode }
  | {
      type: "lock.wait";
      name: string;
      mode: "poll";
      outcome: "acquired" | "timeout" | "aborted" | "error";
      waitedMs: number;
    }
  | {
      type: "lock.session_lost";
      name: string;
      expectedPid: number;
      actualPid: number;
      held: number;
    }
  | ({ type: "lock.keepalive_failed"; name: string } & Err)
  | ({ type: "lock.recovery_retrying"; name: string; attempt: number } & Err)
  | ({ type: "lock.recovery_failed"; name: string; attempt: number } & Err)
  | {
      type: "lock.recovery_refused";
      name: string;
      attempt: number;
      reason: "held" | "displaced";
      /** After a stalled probe: the run's own stalled backend, seen still holding the lock in pg_locks (#41). */
      stalledPid?: number;
    }
  /** A stalled probe's recovery ended the run's own stalled backend, which still held the lock (#41). */
  | { type: "lock.stalled_backend_terminated"; name: string; attempt: number; pid: number }
  /** Ending the run's own stalled backend failed (often a missing privilege); the recovery polls on (#41). */
  | ({ type: "lock.terminate_failed"; name: string; attempt: number; pid: number } & Err)
  /** A stalled probe's recovery closed the session and opened a fresh one (#41). */
  | { type: "lock.session_replaced"; name: string; attempt: number; previousPid: number }
  | { type: "lock.recovered"; name: string; attempt: number; max: number; pid: number }
  | { type: "lock.recovery_exhausted"; name: string; recoveries: number; max: number }
  | ({ type: "lock.unlock_failed"; name: string } & Err)
  | ({
      type: "lock.end_failed";
      name: string;
      /** `recovery`: closing the session a stalled probe left behind. */
      phase: "acquire-error" | "refusal" | "release" | "recovery";
    } & Err);

export type Emit = (e: LockEvent) => void;

/** The hook, made safe: one that throws or rejects is ignored, so it can never change what the lock does. */
export function emitter(onEvent: ((e: LockEvent) => void) | undefined): Emit {
  return (e) => safeHook(onEvent, e);
}

/** `{ error, code }` for a failure event. */
export function failure(error: unknown): Err {
  return { error, code: pgCode(error) };
}
