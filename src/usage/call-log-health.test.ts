import { describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import {
  type CallLogCounts,
  callLogOldestAge,
  callLogRetentionStatus,
  RETENTION_SLACK_DAYS,
  renderCallLogMetrics,
} from "./call-log-health.ts";

const table = { schema: "rootstock", name: "mcp_calls" };
const DAY = 86_400;

/** A client that answers the one statement with `age` and keeps what it was sent. */
function fakeSql(age: unknown) {
  const sent: { statement: string; params: unknown[] }[] = [];
  const sql = {
    unsafe: async (statement: string, params: unknown[]) => {
      sent.push({ statement, params });
      return [{ age }];
    },
  } as unknown as Sql;
  return { sql, sent };
}

const counts = (n: Partial<Record<keyof CallLogCounts, number>> = {}): CallLogCounts => ({
  dropped: () => n.dropped ?? 0,
  failedBatches: () => n.failedBatches ?? 0,
  pruned: () => n.pruned ?? 0,
  pruneFailures: () => n.pruneFailures ?? 0,
});

describe("callLogRetentionStatus", () => {
  test("reads min(created_at) of the quoted table, with no parameters", async () => {
    const { sql, sent } = fakeSql(10);
    await callLogRetentionStatus({ sql, table, retention: { keepDays: 90 } });
    expect(sent).toEqual([{ statement: callLogOldestAge(table), params: [] }]);
    expect(callLogOldestAge(table)).toBe(
      'select extract(epoch from (now() - min(created_at)))::float8 as age from "rootstock"."mcp_calls"',
    );
  });

  test("overdue only past keepDays plus the slack", async () => {
    const at = async (age: unknown, slackDays?: number) =>
      callLogRetentionStatus({
        sql: fakeSql(age).sql,
        table,
        retention: { keepDays: 90 },
        slackDays,
      });
    const edge = (90 + RETENTION_SLACK_DAYS) * DAY;
    expect(await at(edge)).toEqual({ keepDays: 90, oldestAgeSeconds: edge, overdue: false });
    expect((await at(edge + 1)).overdue).toBe(true);
    expect((await at(String(edge + 1))).oldestAgeSeconds).toBe(edge + 1);
    expect((await at(91 * DAY, 0)).overdue).toBe(true);
    expect(await at(null)).toEqual({ keepDays: 90, oldestAgeSeconds: null, overdue: false });
  });

  test("without a retention nothing is overdue", async () => {
    expect(
      await callLogRetentionStatus({ sql: fakeSql(10_000 * DAY).sql, table, retention: null }),
    ).toEqual({ keepDays: null, oldestAgeSeconds: 10_000 * DAY, overdue: false });
  });

  test("refuses a bad retention or slack, and an age that is not a number", async () => {
    const { sql } = fakeSql(1);
    for (const retention of [{ keepDays: 6 }, { keepDays: 3651 }, { keepDays: 1.5 }]) {
      await expect(callLogRetentionStatus({ sql, table, retention })).rejects.toThrow(
        /retention must be null or/,
      );
    }
    for (const slackDays of [-1, 366, 0.5]) {
      await expect(
        callLogRetentionStatus({ sql, table, retention: { keepDays: 90 }, slackDays }),
      ).rejects.toThrow(/slackDays must be an integer/);
    }
    await expect(
      callLogRetentionStatus({ sql: fakeSql("NaN").sql, table, retention: { keepDays: 90 } }),
    ).rejects.toThrow(/answered an age/);
  });
});

describe("renderCallLogMetrics", () => {
  test("the four counters, with the first exporter's HELP texts", () => {
    expect(
      renderCallLogMetrics({
        prefix: "app",
        table,
        counts: counts({ dropped: 1, failedBatches: 2, pruneFailures: 3, pruned: 4 }),
      }),
    ).toBe(
      [
        "# HELP app_call_log_dropped_total Call-log rows (rootstock.mcp_calls) dropped on a full buffer since this process started",
        "# TYPE app_call_log_dropped_total counter",
        "app_call_log_dropped_total 1",
        "",
        "# HELP app_call_log_failed_batches_total Call-log INSERT batches (up to 100 rows each) the database refused since this process started; their rows are lost",
        "# TYPE app_call_log_failed_batches_total counter",
        "app_call_log_failed_batches_total 2",
        "",
        "# HELP app_call_log_prune_failures_total Call-log retention prune passes a refused DELETE step ended since this process started; old rows stay until a later pass",
        "# TYPE app_call_log_prune_failures_total counter",
        "app_call_log_prune_failures_total 3",
        "",
        "# HELP app_call_log_pruned_rows_total Call-log rows the retention deleted since this process started",
        "# TYPE app_call_log_pruned_rows_total counter",
        "app_call_log_pruned_rows_total 4",
        "",
      ].join("\n"),
    );
  });

  test("a status adds the age and keep gauges; an empty table reads 0, no retention no keep", () => {
    const out = renderCallLogMetrics({
      prefix: "x",
      table,
      counts: counts(),
      status: { keepDays: 90, oldestAgeSeconds: 12.5, overdue: false },
    });
    expect(out).toContain("\nx_call_log_oldest_row_age_seconds 12.5\n");
    expect(out).toContain(
      "# TYPE x_call_log_keep_seconds gauge\nx_call_log_keep_seconds 7776000\n",
    );
    const bare = renderCallLogMetrics({
      prefix: "x",
      table,
      counts: counts(),
      status: { keepDays: null, oldestAgeSeconds: null, overdue: false },
    });
    expect(bare).toContain("\nx_call_log_oldest_row_age_seconds 0\n");
    expect(bare).not.toContain("keep_seconds");
    expect(
      renderCallLogMetrics({ prefix: "x", table, counts: counts(), status: null }),
    ).not.toContain("oldest_row_age");
  });

  test("refuses a prefix that is not a metric name", () => {
    expect(() => renderCallLogMetrics({ prefix: "1x", table, counts: counts() })).toThrow(
      /prefix must be a metric name/,
    );
  });
});
