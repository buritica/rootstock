import { codeIn, q } from "../internal/slice.ts";

const CODES = [
  "ERR_ROOTSTOCK_RUNNER_INPUT",
  "ERR_ROOTSTOCK_RUNNER_BACKFILL",
  "ERR_ROOTSTOCK_RUNNER_START",
] as const;
export type RunnerErrorCode = (typeof CODES)[number];
const CODE_SET: ReadonlySet<RunnerErrorCode> = new Set(CODES);

/**
 * A runner refusal. INPUT and BACKFILL are made before any I/O; START wraps
 * a run record that could not be started (`cause` is the original). Branch
 * on `code`, never on the text.
 */
export class RootstockRunnerError extends Error {
  override readonly name = "RootstockRunnerError";
  readonly code: RunnerErrorCode;
  /** The text after "rootstock runner: ". */
  readonly detail: string;

  constructor(code: RunnerErrorCode, detail: string, opts?: { cause: unknown }) {
    super(`rootstock runner: ${detail}`, opts);
    this.code = code;
    this.detail = detail;
  }
}

/** The code of a runner refusal, by `code` (survives two module copies), or undefined. */
export function runnerErrorCode(err: unknown): RunnerErrorCode | undefined {
  return codeIn(CODE_SET, err);
}

/** An INPUT refusal: `rootstock runner: <fn>(): <field> <what> — got <q(value)>` (F25). */
export const input = (
  fn: string,
  field: string,
  what: string,
  value: unknown,
): RootstockRunnerError =>
  new RootstockRunnerError(
    "ERR_ROOTSTOCK_RUNNER_INPUT",
    `${fn}(): ${field} ${what} — got ${q(value)}`,
  );

export const isFn = (v: unknown): boolean => typeof v === "function";

/** Refuses anything without the Transactor's `begin` and `sql`. */
export function checkTransactor(fn: string, tx: unknown): void {
  const t = tx as { begin?: unknown; sql?: unknown } | null;
  if (typeof t !== "object" || t === null || !isFn(t.begin) || !isFn(t.sql)) {
    throw input(fn, "tx", "must be a Transactor", tx);
  }
}
