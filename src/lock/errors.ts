import { codeIn, q } from "../internal/slice.ts";
import type { LockSlice } from "./slice.ts";

const CODES = [
  "ERR_ROOTSTOCK_LOCK_NAME",
  "ERR_ROOTSTOCK_LOCK_WAIT",
  "ERR_ROOTSTOCK_LOCK_HELD",
  "ERR_ROOTSTOCK_LOCK_MALFUNCTION",
  "ERR_ROOTSTOCK_LOCK_CONN",
  "ERR_ROOTSTOCK_LOCK_UNFENCED",
  "ERR_ROOTSTOCK_LOCK_LOST",
  "ERR_ROOTSTOCK_LOCK_UNVERIFIABLE",
  "ERR_ROOTSTOCK_LOCK_ABANDONED",
] as const;
export type LockErrorCode = (typeof CODES)[number];
const CODE_SET: ReadonlySet<LockErrorCode> = new Set(CODES);

interface Extras {
  readonly waitedMs?: number;
  readonly answer?: unknown;
  readonly expectedPid?: number;
  readonly actualPid?: number | null;
  readonly cause?: unknown;
}

/** A lock refusal. Branch on `code`, never on the text. */
export class RootstockLockError extends Error {
  override readonly name = "RootstockLockError";
  readonly code: LockErrorCode;
  readonly lockName: string;
  /** true for LOST and UNVERIFIABLE only: the run must stop. */
  readonly stopsRun: boolean;
  /** HELD after a wait, ABANDONED. */
  readonly waitedMs?: number;
  /** MALFUNCTION: the raw `locked` value. */
  readonly answer?: unknown;
  /** CONN. */
  readonly expectedPid?: number;
  /** CONN; null when the fence returned no row. */
  readonly actualPid?: number | null;

  constructor(code: LockErrorCode, lockName: string, message: string, extras: Extras = {}) {
    super(message, "cause" in extras ? { cause: extras.cause } : undefined);
    this.code = code;
    this.lockName = lockName;
    this.stopsRun =
      code === "ERR_ROOTSTOCK_LOCK_LOST" || code === "ERR_ROOTSTOCK_LOCK_UNVERIFIABLE";
    if ("waitedMs" in extras) this.waitedMs = extras.waitedMs;
    if ("answer" in extras) this.answer = extras.answer;
    if ("expectedPid" in extras) this.expectedPid = extras.expectedPid;
    if ("actualPid" in extras) this.actualPid = extras.actualPid;
  }
}

/** The code of a lock refusal, by `code` (survives two module copies), or undefined. */
export function lockErrorCode(err: unknown): LockErrorCode | undefined {
  return codeIn(CODE_SET, err);
}

// The global's name, in pieces: the purity scan reads string text too.
export const ABORT_SIGNAL = ["Abort", "Signal"].join("");

/** The frozen texts, one builder per refusal. */
export const refusals = {
  name: (slice: LockSlice, name: unknown) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_NAME",
      String(name),
      `rootstock lock: ${q(name)} is not a lock this config declares — declared: ${slice.names.join(", ")}`,
    ),
  wait: (slice: LockSlice, name: string, summary: unknown) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_WAIT",
      name,
      `rootstock lock: wait for ${q(name)} must be { mode: "poll", ms: an integer from 0 to ${slice.wait.maxMs} (wait.maxMs), turns: a createTurnQueue() queue, signal?: an ${ABORT_SIGNAL} } — got ${q(summary)}`,
    ),
  held: (name: string) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_HELD",
      name,
      `rootstock lock: another session holds the ${name} lock — refusing to run concurrently. If no other run exists, a dead session may linger after an abrupt disconnect: check pg_locks, or wait for the server to reap it`,
    ),
  heldAfterWait: (name: string, waitedMs: number) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_HELD",
      name,
      `rootstock lock: another session held the ${name} lock for the whole ${waitedMs} ms wait — refusing to run concurrently`,
      { waitedMs },
    ),
  malfunction: (name: string, answer: unknown) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_MALFUNCTION",
      name,
      `rootstock lock: pg_try_advisory_lock for ${name} answered neither true nor false (got ${answer === undefined ? "undefined" : q(answer)}) — a malfunction, not a busy lock; nothing was run`,
      { answer },
    ),
  conn: (name: string, expectedPid: number, actualPid: number | null) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_CONN",
      name,
      `rootstock lock: the fence for ${name} did not land on the session that holds the lock (pid ${expectedPid}, fence pid ${actualPid ?? "none"}) — a pool was passed as the lock session, or the session was severed between the two statements; re-run, and check the lock profile if it repeats`,
      { expectedPid, actualPid },
    ),
  unfenced: (slice: LockSlice, name: string, cause: unknown) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_UNFENCED",
      name,
      `rootstock lock: took the ${name} lock but could not record its holder in ${slice.table.schema}.${slice.table.name} — refusing to run unfenced, because a severed session could then not be told apart from another run taking over; run the migrations (the table ships with rootstock 0.6.0, or is your own)`,
      { cause },
    ),
  lost: (name: string) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_LOST",
      name,
      `rootstock lock: the ${name} lock was LOST and could not be recovered — the session was severed or no longer holds it; aborting the run (the lock.recovery_* events say which: still down, held by another session, or taken by another run while this one was away)`,
    ),
  unverifiable: (name: string, cause: unknown) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_UNVERIFIABLE",
      name,
      `rootstock lock: the ${name} lock is UNVERIFIABLE — the ownership probe failed and the lock could not be recovered, so exclusivity cannot be asserted; aborting the run`,
      { cause },
    ),
  abandoned: (name: string, waitedMs: number) =>
    new RootstockLockError(
      "ERR_ROOTSTOCK_LOCK_ABANDONED",
      name,
      `rootstock lock: the wait for the ${name} lock was aborted after ${waitedMs} ms — nothing was run`,
      { waitedMs },
    ),
};
