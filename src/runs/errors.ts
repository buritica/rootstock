import { pgCode } from "../db/index.ts";
import { codeIn, q } from "../internal/slice.ts";
import type { BrakeJudgement, ScopeJudgement } from "./events.ts";

const CODES = [
  "ERR_ROOTSTOCK_RUNS_INPUT",
  "ERR_ROOTSTOCK_RUNS_JOB",
  "ERR_ROOTSTOCK_RUNS_MODE",
  "ERR_ROOTSTOCK_RUNS_LOCK",
  "ERR_ROOTSTOCK_RUNS_NOTABLE",
  "ERR_ROOTSTOCK_RUNS_FINISHED",
  "ERR_ROOTSTOCK_RUNS_BRAKE",
  "ERR_ROOTSTOCK_RUNS_SCOPE",
  "ERR_ROOTSTOCK_RUNS_BREAKER",
  "ERR_ROOTSTOCK_RUNS_BUDGET",
  "ERR_ROOTSTOCK_RUNS_FENCE",
] as const;
export type RunsErrorCode = (typeof CODES)[number];
const CODE_SET: ReadonlySet<RunsErrorCode> = new Set(CODES);

interface Extras {
  readonly job?: string;
  readonly judgement?: BrakeJudgement | ScopeJudgement;
  readonly cause?: unknown;
}

/** A runs refusal. Branch on `code`, never on the text. */
export class RootstockRunsError extends Error {
  override readonly name = "RootstockRunsError";
  readonly code: RunsErrorCode;
  readonly job?: string;
  /** The text after "rootstock runs: ". */
  readonly detail: string;
  /** BRAKE and SCOPE: the judgement that refused. */
  readonly judgement?: BrakeJudgement | ScopeJudgement;

  constructor(code: RunsErrorCode, detail: string, extras: Extras = {}) {
    super(`rootstock runs: ${detail}`, "cause" in extras ? { cause: extras.cause } : undefined);
    this.code = code;
    this.detail = detail;
    if (extras.job !== undefined) this.job = extras.job;
    if (extras.judgement !== undefined) this.judgement = extras.judgement;
  }
}

/** The code of a runs refusal, by `code` (survives two module copies), or undefined. */
export function runsErrorCode(err: unknown): RunsErrorCode | undefined {
  return codeIn(CODE_SET, err);
}

/** The frozen texts (contract §3.8), one builder per text. */
export const refusals = {
  /** `detail` names the call and the field, e.g. `count("x"): n must be … — got …`. */
  input: (detail: string, job?: string) =>
    new RootstockRunsError("ERR_ROOTSTOCK_RUNS_INPUT", detail, job === undefined ? {} : { job }),
  job: (job: unknown, declared: readonly string[]) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_JOB",
      `${q(job)} is not a job this config declares — declared: ${declared.join(", ")}`,
      typeof job === "string" ? { job } : {},
    ),
  mode: (job: string, modes: readonly string[], mode: unknown) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_MODE",
      `${job} declares modes ${modes.join(", ")} — got ${q(mode)}`,
      { job },
    ),
  lock: (job: string, declared: string, name: unknown) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_LOCK",
      `${job} runs under the ${declared} lock — got a lock named ${q(name)}`,
      { job },
    ),
  notable: (table: { schema: string; name: string }, cause: unknown, job?: string) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_NOTABLE",
      `${table.schema}.${table.name} does not exist — run the migrations (the table ships with rootstock 0.8.0, or is your own)`,
      job === undefined ? { cause } : { job, cause },
    ),
  fence: (job: string, lockName: string, holder: string) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_FENCE",
      `the ${lockName} fence no longer names holder ${holder} — the lock was lost between the gate and the run record; nothing was written`,
      { job },
    ),
  finished: (id: string, job: string, call: string) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_FINISHED",
      `run ${id} (${job}) already finished — ${call}() after finish() or discard()`,
      { job },
    ),
  /** Only an armed brake refuses, so its cap is a number. */
  brake: (brake: string, judgement: BrakeJudgement & { cap: number }) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_BRAKE",
      `${brake} would archive ${judgement.planned} of ${judgement.held} (cap ${judgement.cap}) — refusing; pass the override to allow it`,
      { judgement },
    ),
  scope: (
    job: string,
    kind: "shrink" | "exclusion",
    items: readonly string[],
    judgement: ScopeJudgement,
  ) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_SCOPE",
      `${job} scope ${kind === "shrink" ? "lost" : "newly excludes"} ${items.length} item(s) since the last successful run (${items.slice(0, 10).join(", ")}${items.length > 10 ? ", …" : ""}) — refusing; pass the override to allow it`,
      { job, judgement },
    ),
  scopeNoBaseline: (job: string, judgement: ScopeJudgement) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_SCOPE",
      `${job} has no successful run to compare its scope against — refusing; pass firstRun: true for a job's first run`,
      { job, judgement },
    ),
  breaker: (breaker: string, count: number) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_BREAKER",
      `${breaker} tripped after ${count} consecutive quota failures — stopping`,
    ),
  budget: (budget: string, limit: number, windowMinutes: number, planned: number) =>
    new RootstockRunsError(
      "ERR_ROOTSTOCK_RUNS_BUDGET",
      `${budget} is spent (${limit} per ${windowMinutes} min) — refusing ${planned} more`,
    ),
};

/** Runs `run`, turning a missing table (42P01) into NOTABLE for `table`. */
export async function guarded<T>(
  table: { schema: string; name: string },
  run: () => Promise<T>,
  job?: string,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (pgCode(err) === "42P01") throw refusals.notable(table, err, job);
    throw err;
  }
}
