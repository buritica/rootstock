import { pgCode, type Sql, type Transactor, type TxSql } from "../db/index.ts";
import {
  type Brand,
  bounded,
  identifier,
  isRecord,
  own,
  perSlice,
  q,
  quoteIdentifier,
  quoteTable,
  type SliceRefusals,
  sliceBrand,
  sliceRefusals,
  tableRef,
} from "../internal/slice.ts";
import { guarded, refusals, runsErrorCode } from "./errors.ts";
import { type Emit, emitter, failure, type RunsDeps } from "./events.ts";

export interface QuarantineTableInput {
  /** Default { <default schema>, "quarantine" }. */
  table?: { schema?: string; name?: string };
  /** Column names; defaults are rootstock's. `runId: null` = the table has no run column. */
  columns?: {
    job?: string;
    externalId?: string;
    payload?: string;
    reason?: string;
    status?: string;
    failedAt?: string;
    resolvedAt?: string;
    runId?: string | null;
  };
  /** 1 024 – 16 777 216. */
  maxPayloadBytes: number;
  /** 16 – 10 000. */
  maxReasonChars: number;
}

declare const quarantineTableBrand: unique symbol;
export interface QuarantineTable {
  readonly [quarantineTableBrand]: true;
  readonly table: { readonly schema: string; readonly name: string };
  readonly columns: {
    readonly job: string;
    readonly externalId: string;
    readonly payload: string;
    readonly reason: string;
    readonly status: string;
    readonly failedAt: string;
    readonly resolvedAt: string;
    /** null: the table has no run column (QU1′). */
    readonly runId: string | null;
  };
  readonly maxPayloadBytes: number;
  readonly maxReasonChars: number;
}

const KEYS: ReadonlySet<string> = new Set([
  "table",
  "columns",
  "maxPayloadBytes",
  "maxReasonChars",
]);
const REQUIRED = ["maxPayloadBytes", "maxReasonChars"] as const;
const COLUMN_DEFAULTS = {
  job: "job",
  externalId: "external_id",
  payload: "payload",
  reason: "reason",
  status: "status",
  failedAt: "failed_at",
  resolvedAt: "resolved_at",
  runId: "run_id",
} as const;
const COLUMN_KEYS: ReadonlySet<string> = new Set(Object.keys(COLUMN_DEFAULTS));

const quarantineRefuse = sliceRefusals("quarantineTable");
const brand: Brand<QuarantineTable> = sliceBrand("QuarantineTable", "quarantineTable");

/**
 * The quarantine table's fields, refused under `refuse` at path prefix `at`
 * (`""` standalone, `"quarantine."` inside the runs slice).
 */
export function parseQuarantine(
  refuse: SliceRefusals,
  input: unknown,
  at: string,
  schema: string,
): QuarantineTable {
  const fields = at === "" ? (isRecord(input) ? input : {}) : refuse.record(at.slice(0, -1), input);
  refuse.refuseUnknownKeys(fields, KEYS, at);
  for (const key of REQUIRED) {
    if (own(fields, key) === undefined) throw refuse.required(`${at}${key}`);
  }
  const table = tableRef(refuse, own(fields, "table"), at, schema, "quarantine");
  const rawColumns = own(fields, "columns");
  const given = rawColumns === undefined ? {} : refuse.record(`${at}columns`, rawColumns);
  refuse.refuseUnknownKeys(given, COLUMN_KEYS, `${at}columns.`);
  const column = (key: keyof typeof COLUMN_DEFAULTS): string => {
    const v = own(given, key);
    return identifier(refuse, `${at}columns.${key}`, v === undefined ? COLUMN_DEFAULTS[key] : v);
  };
  const rawRunId = own(given, "runId");
  const columns = Object.freeze({
    job: column("job"),
    externalId: column("externalId"),
    payload: column("payload"),
    reason: column("reason"),
    status: column("status"),
    failedAt: column("failedAt"),
    resolvedAt: column("resolvedAt"),
    runId: rawRunId === null ? null : column("runId"),
  });
  const maxPayloadBytes = bounded(
    refuse,
    `${at}maxPayloadBytes`,
    own(fields, "maxPayloadBytes"),
    1_024,
    16_777_216,
  );
  const maxReasonChars = bounded(
    refuse,
    `${at}maxReasonChars`,
    own(fields, "maxReasonChars"),
    16,
    10_000,
  );
  return brand.mark(
    Object.freeze({
      table,
      columns,
      maxPayloadBytes,
      maxReasonChars,
    }) as unknown as QuarantineTable,
  );
}

/**
 * Parses a quarantine table into a frozen, branded object: where a job's
 * unloadable records live and what its columns are called. The table must
 * have a unique index on (job, externalId), a status column taking
 * 'pending' / 'resolved', and NOT NULL reason and failure-time columns
 * (pendingQuarantine reads them as values); that is not checked here.
 */
export function quarantineTable(
  input: QuarantineTableInput,
  defaults?: { schema?: string },
): QuarantineTable {
  return parseQuarantine(quarantineRefuse, input, "", defaults?.schema ?? "rootstock");
}

export function assertQuarantineTable(
  fn: string,
  value: unknown,
): asserts value is QuarantineTable {
  brand.assert(fn, value);
}

/** The quarantine statements (contract §4.3), frozen text, built once per table. */
export interface QuarantineStatements {
  /**
   * QU1, params [job, externalId, payloadJson, reason, runId], or QU1′ (the
   * table has no run column), params [job, externalId, payloadJson, reason].
   */
  readonly put: string;
  /** True for QU1, false for QU1′. */
  readonly putTakesRunId: boolean;
  /** QU2, params [job, JSON.stringify(externalIds)]. */
  readonly resolve: string;
  /** QU3, params [job, externalIds === undefined ? null : JSON.stringify(externalIds)]. */
  readonly pending: string;
}

export function quarantineStatements(t: QuarantineTable): QuarantineStatements {
  const Q = quoteTable(t.table);
  const c = t.columns;
  const job = quoteIdentifier(c.job);
  const ext = quoteIdentifier(c.externalId);
  const payload = quoteIdentifier(c.payload);
  const reason = quoteIdentifier(c.reason);
  const status = quoteIdentifier(c.status);
  const failedAt = quoteIdentifier(c.failedAt);
  const resolvedAt = quoteIdentifier(c.resolvedAt);
  const run = c.runId === null ? null : quoteIdentifier(c.runId);
  const put =
    run === null
      ? `INSERT INTO ${Q} (${job}, ${ext}, ${payload}, ${reason}, ${status}, ${failedAt}, ${resolvedAt})
VALUES ($1::text, $2::text, $3::text::jsonb, $4::text, 'pending', clock_timestamp(), NULL)
ON CONFLICT (${job}, ${ext}) DO UPDATE SET
  ${payload} = excluded.${payload}, ${reason} = excluded.${reason},
  ${status} = 'pending', ${failedAt} = excluded.${failedAt}, ${resolvedAt} = NULL`
      : `INSERT INTO ${Q} (${job}, ${ext}, ${payload}, ${reason}, ${status}, ${failedAt}, ${resolvedAt}, ${run})
VALUES ($1::text, $2::text, $3::text::jsonb, $4::text, 'pending', clock_timestamp(), NULL, $5::uuid)
ON CONFLICT (${job}, ${ext}) DO UPDATE SET
  ${payload} = excluded.${payload}, ${reason} = excluded.${reason},
  ${status} = 'pending', ${failedAt} = excluded.${failedAt}, ${resolvedAt} = NULL,
  ${run} = excluded.${run}`;
  return Object.freeze({
    put,
    putTakesRunId: run !== null,
    resolve: `WITH r AS (
  UPDATE ${Q} SET ${status} = 'resolved', ${resolvedAt} = clock_timestamp()
  WHERE ${job} = $1::text AND ${status} = 'pending'
    AND ${ext} IN (SELECT jsonb_array_elements_text($2::text::jsonb))
  RETURNING 1
)
SELECT count(*)::text AS n FROM r`,
    pending: `SELECT ${ext} AS external_id, ${reason} AS reason,
       floor(extract(epoch FROM ${failedAt}) * 1000)::text AS failed_at_ms
FROM ${Q}
WHERE ${job} = $1::text AND ${status} = 'pending'
  AND ($2::text IS NULL OR ${ext} IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
ORDER BY ${failedAt}, ${ext}`,
  });
}

/** The table's statements, after the brand check, built once per table. */
const statementsOf = perSlice(assertQuarantineTable, quarantineStatements);

/** One pending quarantine row (QU3). */
export interface PendingRow {
  readonly externalId: string;
  readonly reason: string;
  readonly failedAt: Date;
}

/** What `quarantine` and `quarantineSafe` take. */
interface PutInput {
  job: string;
  externalId: string;
  payload: unknown;
  reason: string;
  runId?: string | null;
}

/** A put's parameters other than the payload, checked before any query. */
interface PutArgs {
  readonly job: string;
  readonly externalId: string;
  readonly reason: string;
  readonly runId: string | null;
}

const utf8 = new TextEncoder();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A string the server can store: Postgres text refuses NUL, on both attempts of a safe put. */
function text(fn: string, field: string, value: unknown, job?: string): string {
  if (typeof value === "string" && !value.includes("\u0000")) return value;
  throw refusals.input(`${fn}(): ${field} must be a string without NUL — got ${q(value)}`, job);
}

function putArgs(fn: string, t: QuarantineTable, a: PutInput): PutArgs {
  const job = text(fn, "job", a.job);
  const externalId = text(fn, "externalId", a.externalId, job);
  if (typeof a.reason !== "string") {
    throw refusals.input(`${fn}(): reason must be a string — got ${q(a.reason)}`, job);
  }
  // A reason is usually upstream error text, where a stray NUL lands; the
  // server refuses NUL in text, so it becomes U+FFFD rather than losing the row.
  const full = a.reason.replaceAll("\u0000", "\ufffd");
  const runId = a.runId ?? null;
  if (runId !== null && (typeof runId !== "string" || !UUID.test(runId))) {
    throw refusals.input(`${fn}(): runId must be a uuid or null — got ${q(runId)}`, job);
  }
  let reason = full.slice(0, t.maxReasonChars);
  // A cut never leaves half a surrogate pair behind.
  const last = reason.charCodeAt(reason.length - 1);
  if (reason.length < full.length && last >= 0xd800 && last <= 0xdbff) {
    reason = reason.slice(0, -1);
  }
  return { job, externalId, reason, runId };
}

/** The payload's JSON text; INPUT when it does not serialize or is over the cap. */
function payloadJson(fn: string, t: QuarantineTable, args: PutArgs, payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    json = undefined;
  }
  if (typeof json !== "string") {
    throw refusals.input(`${fn}(${q(args.externalId)}): payload must serialize to JSON`, args.job);
  }
  const bytes = utf8.encode(json).length;
  if (bytes > t.maxPayloadBytes) {
    throw refusals.input(
      `${fn}(${q(args.externalId)}): payload is ${bytes} bytes, over the ${t.maxPayloadBytes} cap`,
      args.job,
    );
  }
  return json;
}

async function put(
  tx: Sql,
  t: QuarantineTable,
  st: QuarantineStatements,
  args: PutArgs,
  json: string,
): Promise<void> {
  const params: (string | null)[] = [args.job, args.externalId, json, args.reason];
  if (st.putTakesRunId) params.push(args.runId);
  await guarded(t.table, () => tx.unsafe(st.put, params), args.job);
}

/** `runs.quarantined`, sent once the write (and its savepoint, if any) settled. */
function quarantined(
  emit: Emit,
  st: QuarantineStatements,
  args: PutArgs,
  truncated: boolean,
): void {
  // The run id the row stores: none on a table without a run column.
  const runId = st.putTakesRunId ? args.runId : null;
  emit({ type: "runs.quarantined", job: args.job, externalId: args.externalId, runId, truncated });
}

// The failures a smaller payload can cure (§20 A4): rootstock's own INPUT
// refusal of the payload, and the server refusing its bytes or size.
const PAYLOAD_CODES: ReadonlySet<string> = new Set(["22P05", "22P02", "22021", "54000"]);
function payloadShaped(err: unknown): boolean {
  if (runsErrorCode(err) === "ERR_ROOTSTOCK_RUNS_INPUT") return true;
  const code = pgCode(err);
  return code !== undefined && PAYLOAD_CODES.has(code);
}

/**
 * QU1 (QU1′ on a table without a run column). Writes the record a run could
 * not load, or resets its row to pending with the new payload and reason.
 * `tx` is the caller's transaction or savepoint handle, so the row commits or
 * rolls back with the batch. The payload is refused (INPUT) before any query
 * when it does not serialize or is over `maxPayloadBytes`; the reason is cut
 * to `maxReasonChars`. A rejection propagates.
 */
export async function quarantine(
  tx: Sql,
  t: QuarantineTable,
  a: PutInput,
  deps?: Pick<RunsDeps, "onEvent">,
): Promise<void> {
  const st = statementsOf("quarantine", t);
  const args = putArgs("quarantine", t, a);
  const json = payloadJson("quarantine", t, args, a.payload);
  await put(tx, t, st, args, json);
  quarantined(emitter(deps?.onEvent), st, args, false);
}

const isNoTable = (err: unknown): boolean => runsErrorCode(err) === "ERR_ROOTSTOCK_RUNS_NOTABLE";

/**
 * `quarantine`, then once more with the minimal payload `{ externalId,
 * truncated: true }` when the first attempt fails in a way a smaller payload
 * can cure: rootstock's INPUT refusal of the payload, or the server refusing
 * its bytes or size (22P05, 22P02, 22021, 54000). Any other failure (a missing
 * table, a grant, a timeout, a misused transaction) is rethrown with no
 * fallback (§20 A4). True when either landed (`runs.quarantined` says which
 * through `truncated`); false when the fallback failed too, reported as
 * `runs.record_failed` with the external id. Given a transaction handle
 * (`TxSql`) each attempt runs in its own savepoint, so a refused first attempt
 * rolls back alone and the transaction stays usable; given a `Transactor` it
 * writes autocommit on the root client (§20 A1). Calls on one `TxSql` must be
 * sequential: a concurrent call's savepoint refusal is rethrown.
 */
export async function quarantineSafe(
  scope: Transactor | TxSql,
  t: QuarantineTable,
  a: PutInput,
  deps?: Pick<RunsDeps, "onEvent">,
): Promise<boolean> {
  const st = statementsOf("quarantineSafe", t);
  const args = putArgs("quarantineSafe", t, a);
  const emit = emitter(deps?.onEvent);
  const attempt = (payload: string): Promise<void> =>
    "savepoint" in scope
      ? scope.savepoint((sp) => put(sp, t, st, args, payload))
      : put(scope.sql, t, st, args, payload);
  try {
    await attempt(payloadJson("quarantineSafe", t, args, a.payload));
    quarantined(emit, st, args, false);
    return true;
  } catch (err) {
    if (!payloadShaped(err)) throw err;
  }
  try {
    // The fallback holds to the same cap (a long external id could break it).
    await attempt(
      payloadJson("quarantineSafe", t, args, { externalId: args.externalId, truncated: true }),
    );
    quarantined(emit, st, args, true);
    return true;
  } catch (err) {
    if (isNoTable(err)) throw err;
    emit({
      type: "runs.record_failed",
      operation: "quarantine",
      job: args.job,
      externalId: args.externalId,
      ...failure(err),
    });
    return false;
  }
}

function idList(fn: string, job: string, value: unknown): string {
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return JSON.stringify(value);
  }
  throw refusals.input(`${fn}(): externalIds must be an array of strings — got ${q(value)}`, job);
}

/**
 * QU2. Marks the job's pending rows for `externalIds` resolved and returns how
 * many it moved. An empty list returns 0 without a query.
 */
export async function resolveQuarantine(
  tx: Sql,
  t: QuarantineTable,
  a: { job: string; externalIds: readonly string[] },
  deps?: Pick<RunsDeps, "onEvent">,
): Promise<number> {
  const st = statementsOf("resolveQuarantine", t);
  const job = text("resolveQuarantine", "job", a.job);
  const ids = idList("resolveQuarantine", job, a.externalIds);
  if (a.externalIds.length === 0) return 0;
  const [row] = await guarded(t.table, () => tx.unsafe<{ n: string }>(st.resolve, [job, ids]), job);
  const count = Number(row?.n ?? 0);
  if (count > 0) emitter(deps?.onEvent)({ type: "runs.resolved", job, count });
  return count;
}

/**
 * QU3. The job's pending rows, oldest failure first; only those for
 * `externalIds` when it is given.
 */
export async function pendingQuarantine(
  sql: Sql,
  t: QuarantineTable,
  a: { job: string; externalIds?: readonly string[] },
): Promise<readonly PendingRow[]> {
  const st = statementsOf("pendingQuarantine", t);
  const job = text("pendingQuarantine", "job", a.job);
  const ids = a.externalIds === undefined ? null : idList("pendingQuarantine", job, a.externalIds);
  const rows = await guarded(
    t.table,
    () =>
      sql.unsafe<{ external_id: string; reason: string; failed_at_ms: string }>(st.pending, [
        job,
        ids,
      ]),
    job,
  );
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        externalId: String(r.external_id),
        reason: String(r.reason),
        failedAt: new Date(Number(r.failed_at_ms)),
      }),
    ),
  );
}
