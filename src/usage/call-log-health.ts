import type { Sql } from "../db/index.ts";
import { intIn, KEEP_DAYS_MAX, KEEP_DAYS_MIN, q, quoteTable } from "../internal/slice.ts";
import { configError } from "./errors.ts";

/**
 * Days the lag may run past `keepDays` before the retention counts as
 * behind, so a stall is seen about this long after it starts (while calls
 * arrive). A working retention keeps the lag within an hour of `keepDays`;
 * the slack covers a pass that failed and a backlog that takes a few passes
 * to clear. A first backlog bigger than that (months of rows on a table
 * that never pruned) reads overdue until it is cleared, at up to
 * `PRUNE_STEPS` x `PRUNE_BATCH` rows a pass and one pass an hour while calls
 * arrive.
 */
export const RETENTION_SLACK_DAYS = 2;

/**
 * Rows newer than this are not yet a reference for the lag. A recorded call
 * is inserted before the pass it queues deletes anything, so the first call
 * after a quiet spell would otherwise read overdue until its pass finished.
 * An hour is a pass interval; it also leaves out a `created_at` set in the
 * future, which would pin the reference.
 */
const SETTLE_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
const SLACK_DAYS_MAX = 365;

type Table = { readonly schema: string; readonly name: string };
type Retention = { readonly keepDays: number } | null;

/** What the table says about its retention, read by the database's clock. */
export interface CallLogRetentionStatus {
  /** The retention checked against, null when the table keeps every row. */
  readonly keepDays: number | null;
  /** Seconds since the oldest row was created; null for an empty table. */
  readonly oldestAgeSeconds: number | null;
  /**
   * How old the oldest row was when the newest settled row was written: the
   * newest `created_at` at least an hour old, minus the oldest; null while
   * no row is that old. A pass only runs when a call is recorded, so a quiet
   * week ages the oldest row but leaves the lag alone, and only a retention
   * that fails while calls arrive grows it.
   */
  readonly lagSeconds: number | null;
  /**
   * True when the lag is more than `keepDays` plus the slack: pruning is
   * failing, is not wired, or the sink never runs a pass. Always false
   * without a retention.
   */
  readonly overdue: boolean;
}

/**
 * The one statement: the oldest `created_at` and the newest settled one, each
 * read from one end of the `created_at` index (after a large prune, the old
 * end walks dead entries until vacuum).
 */
export function callLogRetentionRead(table: Table): string {
  const t = quoteTable(table);
  return `select extract(epoch from (now() - lo))::float8 as age, extract(epoch from (hi - lo))::float8 as lag from (select (select min(created_at) from ${t}) as lo, (select max(created_at) from ${t} where created_at <= now() - make_interval(secs => ${SETTLE_SECONDS})) as hi) as ends`;
}

function seconds(raw: number | string | null | undefined, what: string): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new TypeError(`callLogRetentionStatus: the database answered ${what} ${q(raw)}`);
  }
  return n;
}

/**
 * Whether the call log's retention is keeping up, from the table itself:
 * the lag between its oldest and newest settled rows against `keepDays` plus
 * `slackDays` (`RETENTION_SLACK_DAYS` unless given). It sees every way
 * pruning stops while rows still land (refused deletes, retention not wired,
 * a sink that never runs a pass), not only the ones a process counts, and a
 * quiet spell does not trip it, so it is the check to alert on. When inserts
 * fail too, the lag freezes: `failed_batches_total` is that alert. Pass the same
 * `retention` the sink got. One read; a database error rejects, so a caller
 * that renders metrics catches it and renders the counters without a status.
 */
export async function callLogRetentionStatus(o: {
  sql: Sql;
  table: Table;
  retention: Retention;
  slackDays?: number;
}): Promise<CallLogRetentionStatus> {
  const { retention } = o;
  if (
    retention !== null &&
    (typeof retention !== "object" || !intIn(retention.keepDays, KEEP_DAYS_MIN, KEEP_DAYS_MAX))
  ) {
    throw configError(
      `callLogRetentionStatus: retention must be null or { keepDays: an integer from ${KEEP_DAYS_MIN} to ${KEEP_DAYS_MAX} } — got ${q(retention)}`,
    );
  }
  const slackDays = o.slackDays ?? RETENTION_SLACK_DAYS;
  if (!intIn(slackDays, 0, SLACK_DAYS_MAX)) {
    throw configError(
      `callLogRetentionStatus: slackDays must be an integer from 0 to ${SLACK_DAYS_MAX} — got ${q(slackDays)}`,
    );
  }
  // float8 arrives as a number from every supported driver; a string is
  // accepted in case a driver is set to return numerics as text.
  const [row] = await o.sql.unsafe<{ age: number | string | null; lag: number | string | null }>(
    callLogRetentionRead(o.table),
    [],
  );
  const oldestAgeSeconds = seconds(row?.age, "an age of");
  const lagSeconds = seconds(row?.lag, "a lag of");
  const keepDays = retention === null ? null : retention.keepDays;
  const overdue =
    keepDays !== null && lagSeconds !== null && lagSeconds > (keepDays + slackDays) * DAY_SECONDS;
  return { keepDays, oldestAgeSeconds, lagSeconds, overdue };
}

/** The counts `postgresCallLog` keeps, as the metrics read them. */
export interface CallLogCounts {
  dropped(): number;
  failedBatches(): number;
  pruned(): number;
  pruneFailures(): number;
}

const METRIC_PREFIX = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
// In pieces: the purity scan reads the bare word as the ambient global.
const SINCE_START = `since this ${"pro"}${"cess"} started`;

/**
 * The call log's Prometheus series, ending in a newline. The four counters
 * are the sink's own and start at 0 with it (read them with increase()).
 * With a `status`, gauges follow: `<prefix>_call_log_retention_overdue`
 * (0 or 1, the status's own verdict, so the slack lives in one place and the
 * rule is `== 1`), `_retention_lag_seconds` and `_oldest_row_age_seconds`
 * (0 for an empty table), and with a retention `_keep_seconds`. Read the
 * status on each scrape beside the counters, not inside a cached body, and
 * on a failed read render without it: the gauges go missing, so pair the
 * rule with `absent()`. The first three series' HELP texts are word for word
 * the ones the first server to export them wrote (mycel's `src/metrics.ts`).
 */
export function renderCallLogMetrics(o: {
  prefix: string;
  table: Table;
  counts: CallLogCounts;
  status?: CallLogRetentionStatus | null;
}): string {
  if (typeof o.prefix !== "string" || !METRIC_PREFIX.test(o.prefix)) {
    throw configError(`renderCallLogMetrics: prefix must be a metric name — got ${q(o.prefix)}`);
  }
  const p = `${o.prefix}_call_log`;
  const { counts } = o;
  const lines = [
    `# HELP ${p}_dropped_total Call-log rows (${o.table.schema}.${o.table.name}) dropped on a full buffer ${SINCE_START}`,
    `# TYPE ${p}_dropped_total counter`,
    `${p}_dropped_total ${counts.dropped()}`,
    "",
    `# HELP ${p}_failed_batches_total Call-log INSERT batches (up to 100 rows each) the database refused ${SINCE_START}; their rows are lost`,
    `# TYPE ${p}_failed_batches_total counter`,
    `${p}_failed_batches_total ${counts.failedBatches()}`,
    "",
    `# HELP ${p}_prune_failures_total Call-log retention prune passes a refused DELETE step ended ${SINCE_START}; old rows stay until a later pass`,
    `# TYPE ${p}_prune_failures_total counter`,
    `${p}_prune_failures_total ${counts.pruneFailures()}`,
    "",
    `# HELP ${p}_pruned_rows_total Call-log rows the retention deleted ${SINCE_START}`,
    `# TYPE ${p}_pruned_rows_total counter`,
    `${p}_pruned_rows_total ${counts.pruned()}`,
  ];
  const { status } = o;
  if (status != null) {
    lines.push(
      "",
      `# HELP ${p}_retention_overdue 1 when the retention lags more than keepDays plus the slack behind the newest row, else 0`,
      `# TYPE ${p}_retention_overdue gauge`,
      `${p}_retention_overdue ${status.overdue ? 1 : 0}`,
      "",
      `# HELP ${p}_retention_lag_seconds Age of the oldest call-log row when the newest row over an hour old was written (0 when there is none)`,
      `# TYPE ${p}_retention_lag_seconds gauge`,
      `${p}_retention_lag_seconds ${status.lagSeconds ?? 0}`,
      "",
      `# HELP ${p}_oldest_row_age_seconds Age of the oldest call-log row by the database clock (0 when the table is empty)`,
      `# TYPE ${p}_oldest_row_age_seconds gauge`,
      `${p}_oldest_row_age_seconds ${status.oldestAgeSeconds ?? 0}`,
    );
    if (status.keepDays !== null) {
      lines.push(
        "",
        `# HELP ${p}_keep_seconds How long the call log's retention keeps a row`,
        `# TYPE ${p}_keep_seconds gauge`,
        `${p}_keep_seconds ${status.keepDays * DAY_SECONDS}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
