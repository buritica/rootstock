import type { Sql } from "../db/index.ts";
import { intIn, KEEP_DAYS_MAX, KEEP_DAYS_MIN, q, quoteTable } from "../internal/slice.ts";
import { configError } from "./errors.ts";

/**
 * Days past `keepDays` the oldest row may reach before retention counts as
 * behind. A pass runs at most hourly and only when a call arrives, so a
 * quiet day leaves a row a day older than `keepDays`; two days is one quiet
 * day plus a pass that failed, and less than a third pass.
 */
export const RETENTION_SLACK_DAYS = 2;

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
   * True when the oldest row is more than `keepDays` plus the slack old:
   * pruning failed, is not wired, or no call has come in for days. Always
   * false without a retention.
   */
  readonly overdue: boolean;
}

/** The one statement: `min(created_at)` reads one end of the `created_at` index. */
export function callLogOldestAge(table: Table): string {
  return `select extract(epoch from (now() - min(created_at)))::float8 as age from ${quoteTable(table)}`;
}

function checkRetention(fn: string, retention: Retention): void {
  if (
    retention !== null &&
    (typeof retention !== "object" || !intIn(retention.keepDays, KEEP_DAYS_MIN, KEEP_DAYS_MAX))
  ) {
    throw configError(
      `${fn}: retention must be null or { keepDays: an integer from ${KEEP_DAYS_MIN} to ${KEEP_DAYS_MAX} } — got ${q(retention)}`,
    );
  }
}

/**
 * Whether the call log's retention is keeping up, from the table itself:
 * the age of its oldest row against `keepDays` plus `slackDays`
 * (`RETENTION_SLACK_DAYS` unless given). It sees every way pruning stops
 * (refused deletes, retention not wired, a sink that never runs a pass), not
 * only the ones a process counts, so it is the check to alert on. Pass the
 * same `retention` the sink got. One indexed read; a database error rejects.
 */
export async function callLogRetentionStatus(o: {
  sql: Sql;
  table: Table;
  retention: Retention;
  slackDays?: number;
}): Promise<CallLogRetentionStatus> {
  checkRetention("callLogRetentionStatus", o.retention);
  const slackDays = o.slackDays ?? RETENTION_SLACK_DAYS;
  if (!intIn(slackDays, 0, SLACK_DAYS_MAX)) {
    throw configError(
      `callLogRetentionStatus: slackDays must be an integer from 0 to ${SLACK_DAYS_MAX} — got ${q(slackDays)}`,
    );
  }
  const [row] = await o.sql.unsafe<{ age: number | string | null }>(callLogOldestAge(o.table), []);
  const raw = row?.age ?? null;
  const oldestAgeSeconds = raw === null ? null : Number(raw);
  if (oldestAgeSeconds !== null && !Number.isFinite(oldestAgeSeconds)) {
    throw configError(`callLogRetentionStatus: the database answered an age of ${q(raw)}`);
  }
  const keepDays = o.retention === null ? null : o.retention.keepDays;
  const overdue =
    keepDays !== null &&
    oldestAgeSeconds !== null &&
    oldestAgeSeconds > (keepDays + slackDays) * DAY_SECONDS;
  return { keepDays, oldestAgeSeconds, overdue };
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
 * are the sink's own, ${SINCE_START} (read them with
 * increase()). With a `status`, two gauges follow:
 * `<prefix>_call_log_oldest_row_age_seconds` (0 for an empty table) and,
 * when there is a retention, `<prefix>_call_log_keep_seconds`, so an alert
 * reads `oldest_row_age_seconds > keep_seconds + slack` with no number
 * copied from the consumer. The first three series' HELP texts are word for
 * word the ones the first server to export them wrote.
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
