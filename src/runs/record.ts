import { pgCode, type Sql } from "../db/index.ts";
import { intIn, own, perSlice, q } from "../internal/slice.ts";
import type { RunLock } from "../lock/index.ts";
import { type RootstockRunsError, refusals } from "./errors.ts";
import { type Emit, emitter, failure, type RunStatus, type RunsDeps } from "./events.ts";
import {
  assertRunsSlice,
  COUNTER,
  type JobDecl,
  jobDecl,
  lockNameFor,
  MODEL,
  priceMicros,
  type RunsSlice,
} from "./slice.ts";
import { type RunsStatements, runsStatements } from "./statements.ts";

export interface Accounting {
  listed: number;
  written: number;
  unchanged: number;
  quarantined: number;
  excluded: number;
  /** Reason → count; summed into `excluded`'s check (§3.5). */
  excludedReasons?: Readonly<Record<string, number>>;
}

export type FinishResult =
  | {
      written: true;
      status: Exclude<RunStatus, "running">;
      reconciled: boolean | null;
      costUsd: string | null;
      costNote: string | null;
    }
  | { written: false; why: "settled-elsewhere" | "discarded" | "error"; error?: unknown };

export interface RunRow {
  id: string;
  job: string;
  mode: string;
  status: RunStatus;
  phase: string | null;
  lockName: string;
  holder: string;
  startedAt: Date;
  finishedAt: Date | null;
  listed: number | null;
  written: number | null;
  unchanged: number | null;
  quarantined: number | null;
  excluded: number | null;
  reconciled: boolean | null;
  excludedReasons: Record<string, number>;
  counts: Record<string, number>;
  tokens: Record<string, { input: number; output: number }>;
  costUsd: string | null;
  costNote: string | null;
  scope: unknown;
  scopeExcluded: unknown;
  overrides: string[];
  reason: string | null;
}

export interface Run {
  readonly id: string;
  readonly job: string;
  readonly mode: string;
  readonly lockName: string;
  readonly holder: string;
  readonly startedAt: Date;
  /** Adds n (a non-negative integer, default 1) to a repo counter. */
  count(name: string, n?: number): void;
  /** Adds tokens for a model. `estimated` marks the whole run's cost as estimated. */
  meter(model: string, input: number, output: number, opts?: { estimated?: boolean }): void;
  /** Sets the four buckets; the last call wins. Only for a reconciling job. */
  account(a: Accounting): void;
  /** Records an override flag given for this run (e.g. a brake allowed). Deduplicated, in call order. */
  override(flag: string): void;
  /** The scope this run covered, for the next run's scope guard. */
  scope(value: unknown, excluded?: unknown): void;
  /** Deletes the running row. For a run that turned out to have nothing to do. */
  discard(): Promise<FinishResult>;
  /** Settles the row. Idempotent: a second call returns the first result and writes nothing. */
  finish(
    status: Exclude<RunStatus, "running" | "interrupted">,
    opts?: { reason?: string; phase?: string },
  ): Promise<FinishResult>;
}

export interface JobSnapshot {
  total: number;
  /** Newest row whose status is not 'running'. */
  newestSettled: RunRow | null;
  /** Newest 'ok' row. */
  newestOk: RunRow | null;
  /** Oldest first. */
  running: readonly RunningRow[];
}

/**
 * A running row as R4 reads it: `live` when its fence still names its holder
 * and the advisory lock is held; `heartbeatAt` the fencing row's last beat
 * while that row names this holder, else null (§20 A9).
 */
export type RunningRow = RunRow & { live: boolean; heartbeatAt: Date | null };

export type RunsSnapshot = ReadonlyMap<string, JobSnapshot>;

type Row = Record<string, unknown>;

/** The run record's statements, after the brand check, built once per slice. */
const statementsOf = perSlice(assertRunsSlice, (slice: RunsSlice) =>
  runsStatements(slice.table, slice.lockTable),
);

/** A boolean column: a driver that hands back text gives "t" or "true". */
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";

const date = (ms: unknown): Date | null =>
  ms === null || ms === undefined ? null : new Date(Number(ms));

/** A run row from `<P(r)>`'s JSON (§3.2). */
function parseRow(json: Row): RunRow {
  return {
    id: json.id as string,
    job: json.job as string,
    mode: json.mode as string,
    status: json.status as RunStatus,
    phase: (json.phase ?? null) as string | null,
    lockName: json.lockName as string,
    holder: json.holder as string,
    startedAt: date(json.startedAtMs) as Date,
    finishedAt: date(json.finishedAtMs),
    listed: (json.listed ?? null) as number | null,
    written: (json.written ?? null) as number | null,
    unchanged: (json.unchanged ?? null) as number | null,
    quarantined: (json.quarantined ?? null) as number | null,
    excluded: (json.excluded ?? null) as number | null,
    reconciled:
      json.reconciled === null || json.reconciled === undefined ? null : bool(json.reconciled),
    excludedReasons: (json.excludedReasons ?? {}) as Record<string, number>,
    counts: (json.counts ?? {}) as Record<string, number>,
    tokens: (json.tokens ?? {}) as Record<string, { input: number; output: number }>,
    costUsd: (json.costUsd ?? null) as string | null,
    costNote: (json.costNote ?? null) as string | null,
    scope: json.scope ?? null,
    scopeExcluded: json.scopeExcluded ?? null,
    overrides: (json.overrides ?? []) as string[],
    reason: (json.reason ?? null) as string | null,
  };
}

/** The message of a driver error, or "" when it has none readable. */
function messageOf(err: unknown): string {
  try {
    const m = (err as { message?: unknown } | null)?.message;
    return typeof m === "string" ? m : "";
  } catch {
    return "";
  }
}

/**
 * The server's own message: the one on the hop of the cause chain that
 * carries the SQLSTATE, as pgCode finds it. A query builder's wrapper quotes
 * the whole statement, which names every table, so its text cannot say which
 * one is missing.
 */
function serverMessage(err: unknown): string {
  let current: unknown = err;
  for (let hop = 0; hop < 5; hop += 1) {
    if (typeof current !== "object" || current === null) return "";
    try {
      const { code, errno, cause } = current as {
        code?: unknown;
        errno?: unknown;
        cause?: unknown;
      };
      // pgCode of this hop alone (no cause): does the SQLSTATE sit here?
      if (pgCode({ code, errno }) !== undefined) return messageOf(current);
      if (cause === undefined || cause === current) return "";
      current = cause;
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Runs `run`, turning a missing table (42P01) into NOTABLE: for the lock's
 * fencing table when the server's message names it, else for the runs
 * table (§3.3 step 3).
 */
async function notable<T>(slice: RunsSlice, run: () => Promise<T>, job?: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (pgCode(err) !== "42P01") throw err;
    const { schema, name } = slice.lockTable;
    const m = serverMessage(err);
    // The server quotes the relation as the statement wrote it: "schema.name".
    const lock = m.includes(`"${schema}.${name}"`) || m.includes(`"${name}"`);
    throw refusals.notable(lock ? slice.lockTable : slice.table, err, job);
  }
}

const COUNT_MAX = 2_147_483_647;
const E_COUNT = `a non-negative integer of at most ${COUNT_MAX}`;
const PHASE = /^[a-z0-9_.:-]{1,32}$/;
const NOTE_MODELS_MAX = 200;
const MICRO = 1_000_000n;

/** `s` cut to its first `max` characters (code points, so no surrogate is split). */
function cut(s: string, max: number): string {
  return s.length <= max ? s : Array.from(s).slice(0, max).join("");
}

/** UTF-8 bytes of `s`. */
function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** `micro` micro-dollars as a decimal string with exactly 6 fractional digits. */
function dollars(micro: bigint): string {
  return `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, "0")}`;
}

interface Cost {
  costUsd: string | null;
  costNote: string | null;
}

/** §3.6: the cost of `tokens` under the slice's prices, in integer micro-dollars. */
function costOf(
  slice: RunsSlice,
  decl: JobDecl,
  tokens: ReadonlyMap<string, { input: number; output: number }>,
  estimated: boolean,
): Cost {
  if (!decl.metered) return { costUsd: null, costNote: "unmetered" };
  const prices = priceMicros(slice);
  const unpriced = [...tokens.keys()].filter((m) => !prices.has(m)).sort();
  if (unpriced.length > 0) {
    return { costUsd: null, costNote: `unpriced:${cut(unpriced.join(","), NOTE_MODELS_MAX)}` };
  }
  let sum = 0n;
  for (const [model, t] of tokens) {
    const p = prices.get(model) as { input: bigint; output: bigint };
    sum += BigInt(t.input) * p.input + BigInt(t.output) * p.output;
  }
  return {
    costUsd: dollars((sum + 500_000n) / MICRO),
    costNote: estimated ? "estimated" : null,
  };
}

interface Identity {
  status: Exclude<RunStatus, "running">;
  buckets: [number | null, number | null, number | null, number | null, number | null];
  reconciled: boolean | null;
  excludedReasons: string | null;
  /** The identity failure's text, when it failed. */
  failed: string | null;
  accounted: number | null;
}

/** §3.5: the buckets, `reconciled`, and the status the identity leaves. */
function identityOf(
  decl: JobDecl,
  job: string,
  status: Exclude<RunStatus, "running" | "interrupted">,
  a: Accounting | null,
): Identity {
  const none = [null, null, null, null, null] as Identity["buckets"];
  if (!decl.reconciles || (a === null && status === "refused")) {
    return {
      status,
      buckets: none,
      reconciled: null,
      excludedReasons: null,
      failed: null,
      accounted: null,
    };
  }
  if (a === null) {
    return {
      status: status === "ok" ? "failed" : status,
      buckets: none,
      reconciled: false,
      excludedReasons: null,
      failed: `rootstock runs: ${job} reconciles but finished without accounting`,
      accounted: null,
    };
  }
  const accounted = a.written + a.unchanged + a.quarantined + a.excluded;
  const reconciled = a.listed === accounted;
  return {
    status: !reconciled && status === "ok" ? "failed" : status,
    buckets: [a.listed, a.written, a.unchanged, a.quarantined, a.excluded],
    reconciled,
    excludedReasons: JSON.stringify(a.excludedReasons ?? {}),
    failed: reconciled
      ? null
      : `rootstock runs: listed ${a.listed} != accounted ${accounted} (written ${a.written} + unchanged ${a.unchanged} + quarantined ${a.quarantined} + excluded ${a.excluded})`,
    accounted,
  };
}

/** `account`'s argument checked and copied (INPUT on the first bad field). */
function checkAccounting(input: unknown, job: string): Accounting {
  const fail = (detail: string) => refusals.input(`account(): ${detail}`, job);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw fail(`the accounting must be an object — got ${q(input)}`);
  }
  const a = input as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["listed", "written", "unchanged", "quarantined", "excluded"] as const) {
    const v = own(a, key);
    if (!intIn(v, 0, COUNT_MAX)) throw fail(`${key} must be ${E_COUNT} — got ${q(v)}`);
    out[key] = v;
  }
  const raw = own(a, "excludedReasons");
  if (raw === undefined) return out as unknown as Accounting;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail(`excludedReasons must be an object — got ${q(raw)}`);
  }
  let sum = 0;
  const reasons: [string, number][] = [];
  for (const [reason, n] of Object.entries(raw)) {
    if (reason.length === 0 || reason.includes("\0")) {
      throw fail(`excludedReasons keys must be non-empty with no NUL — got ${q(reason)}`);
    }
    if (!intIn(n, 0, COUNT_MAX))
      throw fail(`excludedReasons[${q(reason)}] must be ${E_COUNT} — got ${q(n)}`);
    sum += n;
    reasons.push([reason, n]);
  }
  if (sum !== out.excluded) {
    throw fail(`excludedReasons sum to ${sum}, not excluded ${out.excluded}`);
  }
  return { ...(out as unknown as Accounting), excludedReasons: Object.fromEntries(reasons) };
}

/**
 * Starts a run under `args.lock` (§3.3): validates without I/O, gates the
 * lock, then R1 settles the lock's rows of other holders as interrupted and
 * inserts this run's running row, both only while the fence still names
 * this holder.
 */
export async function startRun(
  sql: Sql,
  slice: RunsSlice,
  args: {
    job: string;
    mode: string;
    lock: RunLock;
    afterRun?: (row: RunRow) => void | Promise<void>;
  },
  deps: RunsDeps,
): Promise<Run> {
  const statements = statementsOf("startRun", slice);
  const emit = emitter(deps.onEvent);
  const { job, mode, lock } = args;
  const refuse = (err: RootstockRunsError): RootstockRunsError => {
    emit({ type: "runs.refused", job: String(job), code: err.code });
    return err;
  };
  let decl: JobDecl;
  try {
    decl = jobDecl(slice, job);
  } catch (err) {
    throw refuse(err as RootstockRunsError);
  }
  if (!decl.modes.includes(mode)) throw refuse(refusals.mode(job, decl.modes, mode));
  const lockName = lockNameFor(decl, job);
  if (lock.name !== lockName) throw refuse(refusals.lock(job, lockName, lock.name));

  await lock.ensureExclusive();
  const id = String(deps.randomUUID()).toLowerCase();
  const holder = lock.holder;
  const [row] = await notable(slice, () =>
    sql.unsafe(statements.start, [id, job, mode, lockName, holder]),
  );
  if (!bool(row?.inserted)) throw refuse(refusals.fence(job, lockName, holder));
  const settled = JSON.parse(String(row?.settled ?? "[]")) as { id: string; job: string }[];
  for (const s of settled) {
    emit({ type: "runs.settled_interrupted", id: s.id, job: s.job, by: id });
  }
  emit({ type: "runs.started", id, job, mode, lockName, settled: settled.length });
  return makeRun(sql, slice, statements, decl, emit, args.afterRun, {
    id,
    job,
    mode,
    lockName,
    holder,
    startedAt: new Date(Number(row?.started_at_ms)),
  });
}

interface Identifiers {
  id: string;
  job: string;
  mode: string;
  lockName: string;
  holder: string;
  startedAt: Date;
}

function makeRun(
  sql: Sql,
  slice: RunsSlice,
  statements: RunsStatements,
  decl: JobDecl,
  emit: Emit,
  afterRun: ((row: RunRow) => void | Promise<void>) | undefined,
  ids: Identifiers,
): Run {
  const { id, job, holder } = ids;
  const counts = new Map<string, number>();
  const tokens = new Map<string, { input: number; output: number }>();
  const overrides: string[] = [];
  let estimated = false;
  let accounting: Accounting | null = null;
  let scopeJson: string | null = null;
  let scopeExcludedJson: string | null = null;
  let settling: Promise<FinishResult> | null = null;

  const input = (detail: string) => refusals.input(detail, job);
  const open = (call: string) => {
    if (settling !== null) throw refusals.finished(id, job, call);
  };
  const scopeText = (what: string, value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      throw input(`scope(): ${what} is not JSON-serializable — ${messageOf(err)}`);
    }
    if (text === undefined) throw input(`scope(): ${what} is not JSON-serializable`);
    const size = bytes(text);
    if (size > slice.maxScopeBytes) {
      throw input(
        `scope(): ${what} is ${size} bytes of JSON, over maxScopeBytes ${slice.maxScopeBytes}`,
      );
    }
    // jsonb refuses the NUL escape, which would lose the whole record at finish.
    if (text.includes("\\u0000")) throw input(`scope(): ${what} contains a NUL character`);
    return text;
  };

  const write = async (
    status: Exclude<RunStatus, "running" | "interrupted">,
    reasonIn: string | undefined,
    phase: string | null,
  ): Promise<FinishResult> => {
    const identity = identityOf(decl, job, status, accounting);
    const cost = costOf(slice, decl, tokens, estimated);
    const given = reasonIn === undefined ? undefined : reasonIn.replaceAll("\0", "�");
    const composed =
      identity.failed === null
        ? given
        : given === undefined
          ? identity.failed
          : `${identity.failed}; ${given}`;
    const reason = composed === undefined ? null : cut(composed, slice.maxReasonChars);
    let rows: Row[];
    try {
      rows = await sql.unsafe(statements.finish, [
        id,
        holder,
        identity.status,
        phase,
        ...identity.buckets,
        identity.reconciled,
        identity.excludedReasons,
        JSON.stringify(Object.fromEntries(counts)),
        JSON.stringify(Object.fromEntries(tokens)),
        cost.costUsd,
        cost.costNote,
        scopeJson,
        scopeExcludedJson,
        JSON.stringify(overrides),
        reason,
      ]);
    } catch (error) {
      emit({ type: "runs.record_failed", id, job, operation: "finish", ...failure(error) });
      return { written: false, why: "error", error };
    }
    const [r] = rows;
    if (r === undefined) {
      emit({ type: "runs.settled_elsewhere", id, job });
      return { written: false, why: "settled-elsewhere" };
    }
    if (identity.failed !== null) {
      const listed = identity.buckets[0];
      emit({ type: "runs.identity_failed", id, job, listed, accounted: identity.accounted });
    }
    const settled = {
      status: identity.status,
      reconciled: identity.reconciled,
      costUsd: cost.costUsd,
      costNote: cost.costNote,
    };
    emit({ type: "runs.finished", id, job, ...settled });
    if (afterRun !== undefined) {
      try {
        await afterRun(parseRow(JSON.parse(String(r.row)) as Row));
      } catch (error) {
        emit({ type: "runs.after_run_failed", id, job, error });
      }
    }
    return { written: true, ...settled };
  };

  return Object.freeze({
    ...ids,
    count(name: string, n: number = 1) {
      open("count");
      if (typeof name !== "string" || !COUNTER.test(name)) {
        throw input(`count(${q(name)}): name must match [a-z0-9_.:-]{1,64}`);
      }
      if (!Number.isSafeInteger(n) || n < 0) {
        throw input(`count(${q(name)}): n must be a non-negative integer — got ${q(n)}`);
      }
      const prev = counts.get(name);
      if (prev === undefined && counts.size >= slice.maxCountKeys) {
        throw input(
          `count(${q(name)}): more than maxCountKeys ${slice.maxCountKeys} distinct counter names`,
        );
      }
      counts.set(name, (prev ?? 0) + n);
    },
    meter(model: string, inTokens: number, outTokens: number, opts?: { estimated?: boolean }) {
      open("meter");
      if (typeof model !== "string" || !MODEL.test(model)) {
        throw input(`meter(${q(model)}): model must match [A-Za-z0-9_./:-]{1,128}`);
      }
      if (!decl.metered) throw input(`meter(${q(model)}): ${job} is declared metered: false`);
      for (const [what, v] of [
        ["input", inTokens],
        ["output", outTokens],
      ] as const) {
        if (!Number.isSafeInteger(v) || v < 0) {
          throw input(`meter(${q(model)}): ${what} must be a non-negative integer — got ${q(v)}`);
        }
      }
      const e = opts?.estimated;
      if (e !== undefined && typeof e !== "boolean") {
        throw input(`meter(${q(model)}): opts.estimated must be true or false — got ${q(e)}`);
      }
      const prev = tokens.get(model) ?? { input: 0, output: 0 };
      tokens.set(model, { input: prev.input + inTokens, output: prev.output + outTokens });
      if (e === true) estimated = true;
    },
    account(a: Accounting) {
      open("account");
      if (!decl.reconciles) throw input(`account(): ${job} is declared reconciles: false`);
      accounting = checkAccounting(a, job);
    },
    override(flag: string) {
      open("override");
      if (typeof flag !== "string" || !COUNTER.test(flag)) {
        throw input(`override(${q(flag)}): flag must match [a-z0-9_.:-]{1,64}`);
      }
      if (!overrides.includes(flag)) overrides.push(flag);
    },
    scope(value: unknown, excluded?: unknown) {
      open("scope");
      const v = scopeText("value", value);
      const x = scopeText("excluded", excluded);
      scopeJson = v;
      scopeExcludedJson = x;
    },
    discard(): Promise<FinishResult> {
      if (settling !== null) return settling;
      settling = (async (): Promise<FinishResult> => {
        let rows: Row[];
        try {
          rows = await sql.unsafe(statements.discard, [id, holder]);
        } catch (error) {
          emit({ type: "runs.record_failed", id, job, operation: "discard", ...failure(error) });
          return { written: false, why: "error", error };
        }
        if (rows.length === 0) {
          emit({ type: "runs.settled_elsewhere", id, job });
          return { written: false, why: "settled-elsewhere" };
        }
        emit({ type: "runs.discarded", id, job });
        return { written: false, why: "discarded" };
      })();
      return settling;
    },
    finish(
      status: Exclude<RunStatus, "running" | "interrupted">,
      opts?: { reason?: string; phase?: string },
    ): Promise<FinishResult> {
      if (settling !== null) return settling;
      if (status !== "ok" && status !== "failed" && status !== "refused") {
        return Promise.reject(
          input(`finish(): status must be "ok", "failed" or "refused" — got ${q(status)}`),
        );
      }
      const phase = opts?.phase ?? null;
      if (phase !== null && (typeof phase !== "string" || !PHASE.test(phase))) {
        return Promise.reject(
          input(`finish(): phase must match [a-z0-9_.:-]{1,32} — got ${q(phase)}`),
        );
      }
      const reason = opts?.reason;
      if (reason !== undefined && typeof reason !== "string") {
        return Promise.reject(input(`finish(): reason must be a string — got ${q(reason)}`));
      }
      settling = write(status, reason, phase);
      return settling;
    },
  });
}

/**
 * The run record of each concrete job in `jobs`, in input order (§3.4 R4):
 * its row count, newest settled and newest ok rows, and its running rows,
 * each marked live when its fence still names its holder and the advisory
 * lock is held. Read-only; takes no lock.
 */
export async function runsSnapshot(
  sql: Sql,
  slice: RunsSlice,
  jobs: readonly string[],
): Promise<RunsSnapshot> {
  const statements = statementsOf("runsSnapshot", slice);
  if (!Array.isArray(jobs)) {
    throw refusals.input(`runsSnapshot(): jobs must be an array of job names — got ${q(jobs)}`);
  }
  for (const job of jobs) jobDecl(slice, job);
  const out = new Map<string, JobSnapshot>();
  if (jobs.length === 0) return out;
  const rows = await notable(slice, () => sql.unsafe(statements.snapshot, [JSON.stringify(jobs)]));
  const one = (text: unknown): RunRow | null =>
    text === null || text === undefined ? null : parseRow(JSON.parse(String(text)) as Row);
  for (const r of rows) {
    const running =
      r.running === null || r.running === undefined
        ? []
        : (JSON.parse(String(r.running)) as Row[]).map((j) => ({
            ...parseRow(j),
            live: bool(j.live),
            heartbeatAt: date(j.heartbeatAtMs),
          }));
    out.set(String(r.job), {
      total: Number(r.total),
      newestSettled: one(r.newest_settled),
      newestOk: one(r.newest_ok),
      running,
    });
  }
  return out;
}

/**
 * Deletes settled rows older than `retention.keepDays`, keeping every running
 * row and each job's newest ok and newest settled rows (§3.4 R5). Returns how
 * many it deleted and emits `runs.pruned`.
 */
export async function pruneRuns(
  sql: Sql,
  slice: RunsSlice,
  deps?: Pick<RunsDeps, "onEvent">,
): Promise<number> {
  const statements = statementsOf("pruneRuns", slice);
  const [row] = await notable(slice, () =>
    sql.unsafe(statements.prune, [slice.retention.keepDays]),
  );
  const deleted = Number(row?.deleted ?? 0);
  emitter(deps?.onEvent)({ type: "runs.pruned", deleted });
  return deleted;
}
