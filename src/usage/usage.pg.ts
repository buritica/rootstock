import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import { openSecondClient, openTestClient, type TestClient } from "../db/test-client.pg-support.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import { PRUNE_BATCH, postgresCallLog } from "./call-log.ts";
import { callLogRetentionStatus } from "./call-log-health.ts";
import { callRecord, captureLog, manualClock } from "./fixtures.test-support.ts";
import { createSpendCeiling, postgresSpendStore, type SpendStore } from "./spend.ts";

// W5 contract §7.2 and §7.4 against a real server, once per transactor kind,
// on the raw driver client a consumer passes (the drizzle kind passes its
// postgres.js client): the batch insert and both spend store shapes.

let main: TestTransactor;
let raw: TestClient;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_us");

beforeAll(() => {
  main = openTestTransactor();
  raw = openTestClient();
  sql = (raw.kind === "drizzle" ? raw.client.$client : raw.client) as unknown as Sql;
});

afterAll(async () => {
  await dropAll(main.transactor.sql);
  await raw.close();
  await main.close();
});

async function migrated(): Promise<string> {
  const s = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
  return s;
}

class CeilingReached extends Error {}

describe("postgresCallLog", () => {
  test("rows land as written: jsonb nulls are NULL, NUL dropped, a lone surrogate replaced, cost kept exact", async () => {
    const s = await migrated();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql,
      table: { schema: s, name: "mcp_calls" },
      maxBuffered: 100,
      maxBatch: 100,
      log,
    });
    sink.record(
      callRecord({
        stage: "rejected",
        tool: "nope",
        args: {},
        ok: false,
        errorClass: "UnknownTool",
        errorMessage: "SECRET-MESSAGE",
        durationMs: 2.4,
      }),
    );
    sink.record(
      callRecord({
        args: { text: "a\u0000b", odd: "\ud800" },
        tokens: { "model-a": { input: 3, output: 4 } },
        costUsd: "0.000123",
        costNote: "estimated",
        outputText: "out\u0000put",
        resultIds: ["e1", "e2"],
        phases: { fts: 3 },
        extra: { k: 1 },
        turnId: "t:1",
        onBehalfOf: "someone",
        serverSha: "abc",
        clientUa: "ua/1",
        mcpProtocol: "2025-06-18",
      }),
    );
    await sink.idle();
    expect(events).toEqual([]);
    const rows = await sql.unsafe<Record<string, unknown>>(
      `SELECT tool, args::text AS args, duration_ms, ok, error_class, result_ids::text AS result_ids,
              result_ids IS NULL AS ids_null, phases::text AS phases, tokens::text AS tokens,
              cost_usd::text AS cost_usd, cost_note, output_text, extra::text AS extra, turn_id,
              on_behalf_of, server_sha, client_ua, mcp_protocol, caller,
              id IS NOT NULL AS has_id, created_at IS NOT NULL AS has_at
       FROM "${s}".mcp_calls ORDER BY tool`,
    );
    expect(rows).toEqual([
      {
        tool: "echo",
        args: '{"odd": "�", "text": "ab"}',
        duration_ms: 12,
        ok: true,
        error_class: null,
        result_ids: '["e1", "e2"]',
        ids_null: false,
        phases: '{"fts": 3}',
        tokens: '{"model-a": {"input": 3, "output": 4}}',
        cost_usd: "0.000123",
        cost_note: "estimated",
        output_text: "output",
        extra: '{"k": 1}',
        turn_id: "t:1",
        on_behalf_of: "someone",
        server_sha: "abc",
        client_ua: "ua/1",
        mcp_protocol: "2025-06-18",
        caller: "user-1",
        has_id: true,
        has_at: true,
      },
      {
        tool: "nope",
        args: "{}",
        duration_ms: 2,
        ok: false,
        error_class: "UnknownTool",
        result_ids: null,
        ids_null: true,
        phases: null,
        tokens: null,
        cost_usd: null,
        cost_note: null,
        output_text: null,
        extra: null,
        turn_id: null,
        on_behalf_of: null,
        server_sha: null,
        client_ua: null,
        mcp_protocol: null,
        caller: "user-1",
        has_id: true,
        has_at: true,
      },
    ]);
  });

  test("250 calls in batches of 100 all land", async () => {
    const s = await migrated();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql,
      table: { schema: s, name: "mcp_calls" },
      maxBuffered: 1000,
      maxBatch: 100,
      log,
    });
    for (let i = 0; i < 250; i++) sink.record(callRecord({ durationMs: i }));
    await sink.idle();
    expect(events).toEqual([]);
    const [r] = await sql.unsafe<{ n: number; total: number }>(
      `SELECT count(*)::int AS n, sum(duration_ms)::int AS total FROM "${s}".mcp_calls`,
    );
    expect(r).toEqual({ n: 250, total: (249 * 250) / 2 });
  });

  test("a blocked insert does not delay a call; its rows land once the lock goes", async () => {
    const s = await migrated();
    const second = openSecondClient();
    const other = (second.kind === "drizzle"
      ? second.client.$client
      : second.client) as unknown as {
      begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
    };
    let unlock = () => {};
    let held = () => {};
    const locked = new Promise<void>((r) => {
      held = r;
    });
    const holder = other
      .begin(async (tx) => {
        await tx.unsafe(`LOCK TABLE "${s}".mcp_calls IN ACCESS EXCLUSIVE MODE`);
        held();
        await new Promise<void>((r) => {
          unlock = r;
        });
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    try {
      await locked;
      const { log } = captureLog();
      const sink = postgresCallLog({
        retention: null,
        sql,
        table: { schema: s, name: "mcp_calls" },
        maxBuffered: 10,
        maxBatch: 10,
        log,
      });
      // record returns before the writer has even started.
      for (let i = 0; i < 5; i++) expect(sink.record(callRecord())).toBeUndefined();
      // The insert is sent and waits on the lock: a lock request on the table not granted.
      const waiting = async () =>
        (
          await main.transactor.sql.unsafe<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_locks WHERE relation = to_regclass($1) AND NOT granted",
            [`"${s}".mcp_calls`],
          )
        )[0]?.n ?? 0;
      let n = 0;
      for (let i = 0; i < 200 && n === 0; i++) {
        n = await waiting();
        if (n === 0) await Bun.sleep(10);
      }
      expect(n).toBe(1);
      let idle = false;
      const done = sink.idle().then(() => {
        idle = true;
      });
      expect(idle).toBe(false);
      unlock();
      await done;
      expect(await holder).toBeNull();
      const [r] = await sql.unsafe<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${s}".mcp_calls`,
      );
      expect(r?.n).toBe(5);
    } finally {
      unlock();
      await holder;
      await second.close();
    }
  });

  test("odd rows inside a batch of good ones: every row lands", async () => {
    const s = await migrated();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql,
      table: { schema: s, name: "mcp_calls" },
      maxBuffered: 100,
      maxBatch: 100,
      log,
    });
    sink.record(callRecord({ tool: "good-1" }));
    sink.record(callRecord({ tool: "nan", durationMs: Number.NaN }));
    sink.record(callRecord({ tool: "huge", durationMs: 1e15 }));
    sink.record(callRecord({ tool: "nul", outputText: "a\u0000b", args: { odd: "\ud800" } }));
    sink.record(callRecord({ tool: "t".repeat(300) }));
    sink.record(callRecord({ tool: "null-caller", caller: null as never, args: "x" as never }));
    sink.record(callRecord({ tool: "num-caller", caller: 7 as never, ok: undefined as never }));
    sink.record(callRecord({ tool: "good-2" }));
    await sink.idle();
    expect(events).toEqual([]);
    const rows = await sql.unsafe<{ tool: string; ms: number }>(
      `SELECT left(tool, 10) AS tool, duration_ms AS ms FROM "${s}".mcp_calls ORDER BY tool`,
    );
    expect(rows).toEqual([
      { tool: "good-1", ms: 12 },
      { tool: "good-2", ms: 12 },
      { tool: "huge", ms: 2_147_483_647 },
      { tool: "nan", ms: 0 },
      { tool: "nul", ms: 12 },
      { tool: "null-calle", ms: 12 },
      { tool: "num-caller", ms: 12 },
      { tool: "tttttttttt", ms: 12 },
    ]);
    const coerced = await sql.unsafe<{ caller: string; args: string; ok: boolean }>(
      `SELECT caller, args::text AS args, ok FROM "${s}".mcp_calls WHERE tool IN ('null-caller', 'num-caller') ORDER BY tool`,
    );
    expect(coerced).toEqual([
      { caller: "", args: "{}", ok: true },
      { caller: "7", args: '{"text": "hi"}', ok: false },
    ]);
    const [len] = await sql.unsafe<{ n: number }>(
      `SELECT max(length(tool))::int AS n FROM "${s}".mcp_calls`,
    );
    expect(len?.n).toBe(200);
  });

  test("a batch the server refuses is logged by class and the writer stops cleanly", async () => {
    const s = await migrated();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql,
      table: { schema: s, name: "no_such_table" },
      maxBuffered: 10,
      maxBatch: 10,
      log,
    });
    sink.record(callRecord({ tool: "boom" }));
    await sink.idle();
    expect(events).toEqual([
      {
        event: "usage.call_log_failed",
        fields: {
          stage: "insert",
          rows: 1,
          tools: ["boom"],
          errorClass: "42P01",
          failedBatches: 1,
        },
      },
    ]);
  });
  test("callLogRetentionStatus reads the lag and age by the server's clock", async () => {
    const s = await migrated();
    const table = { schema: s, name: "mcp_calls" };
    const retention = { keepDays: 30 };
    const insertAgo = (hours: number) =>
      sql.unsafe(
        `INSERT INTO "${s}".mcp_calls (created_at, caller, tool, args, duration_ms, ok)
         VALUES (now() - make_interval(hours => ${hours}), 'c', 't', '{}'::jsonb, 1, true)`,
      );
    expect(await callLogRetentionStatus({ sql, table, retention })).toEqual({
      keepDays: 30,
      oldestAgeSeconds: null,
      lagSeconds: null,
      overdue: false,
    });
    // Quiet: rows 40 and 39 days old and nothing since. Old, little lag.
    await insertAgo(40 * 24);
    await insertAgo(39 * 24);
    const quiet = await callLogRetentionStatus({ sql, table, retention });
    expect(quiet.overdue).toBe(false);
    expect(quiet.lagSeconds).toBeCloseTo(86_400, 0);
    expect(quiet.oldestAgeSeconds).toBeGreaterThanOrEqual(40 * 86_400);
    expect(quiet.oldestAgeSeconds).toBeLessThan(40 * 86_400 + 60);
    // The first call after the quiet spell, before its pass: not yet counted.
    await insertAgo(0);
    expect((await callLogRetentionStatus({ sql, table, retention })).overdue).toBe(false);
    // Nor is a row dated in the future.
    await insertAgo(-24 * 365);
    expect((await callLogRetentionStatus({ sql, table, retention })).overdue).toBe(false);
    // A call two hours ago that did not prune: the lag is 40 days, past 30 + 2.
    await insertAgo(2);
    const behind = await callLogRetentionStatus({ sql, table, retention });
    expect(behind.overdue).toBe(true);
    expect(behind.lagSeconds).toBeCloseTo(40 * 86_400 - 7_200, 0);
    expect((await callLogRetentionStatus({ sql, table, retention: null })).overdue).toBe(false);
    expect((await callLogRetentionStatus({ sql, table, retention, slackDays: 15 })).overdue).toBe(
      false,
    );
  });

  test("a sink's own pass clears overdue; a sink with deletes refused leaves it", async () => {
    const s = await migrated();
    const table = { schema: s, name: "mcp_calls" };
    const retention = { keepDays: 30 };
    // Calls kept arriving (one 2h ago) while nothing pruned a 400-day row.
    await sql.unsafe(
      `INSERT INTO "${s}".mcp_calls (created_at, caller, tool, args, duration_ms, ok)
       SELECT now() - make_interval(hours => h), 'c', 't', '{}'::jsonb, 1, true
       FROM unnest(ARRAY[400 * 24, 20 * 24, 2]) AS h`,
    );
    expect((await callLogRetentionStatus({ sql, table, retention })).overdue).toBe(true);
    const run = async (client: Sql) => {
      const { log, events } = captureLog();
      const sink = postgresCallLog({
        sql: client,
        table,
        maxBuffered: 10,
        maxBatch: 10,
        retention,
        clock: manualClock(),
        log,
      });
      sink.record(callRecord({ tool: "fresh" }));
      await eventually(() => events.length === 1);
      await sink.idle();
      return sink;
    };
    // Deletes refused: the pass fails and the table still reads overdue.
    const refusing = {
      unsafe: (statement: string, params?: unknown[]) =>
        /delete/i.test(statement)
          ? Promise.reject(new Error("permission denied"))
          : sql.unsafe(statement, params as never[]),
    } as unknown as Sql;
    expect((await run(refusing)).pruneFailures()).toBe(1);
    expect((await callLogRetentionStatus({ sql, table, retention })).overdue).toBe(true);
    // A working sink's pass deletes the old row and the verdict clears.
    expect((await run(sql)).pruned()).toBe(1);
    const after = await callLogRetentionStatus({ sql, table, retention });
    expect(after.overdue).toBe(false);
    expect(after.lagSeconds).toBeCloseTo(20 * 86_400 - 7_200, 0);
  });

  test("retention deletes rows older than keepDays and keeps the rest", async () => {
    const s = await migrated();
    // Ages in days: three past a 30-day cutoff, two inside it.
    await sql.unsafe(
      `INSERT INTO "${s}".mcp_calls (created_at, caller, tool, args, duration_ms, ok)
       SELECT now() - make_interval(days => d), 'c', 'aged-' || d, '{}'::jsonb, 1, true
       FROM unnest(ARRAY[400, 90, 31, 29, 1]) AS d`,
    );
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      sql,
      table: { schema: s, name: "mcp_calls" },
      maxBuffered: 10,
      maxBatch: 10,
      retention: { keepDays: 30 },
      clock: manualClock(),
      log,
    });
    sink.record(callRecord({ tool: "fresh" }));
    await eventually(() => events.length === 1);
    await sink.idle();
    const left = await sql.unsafe<{ tool: string }>(
      `SELECT tool FROM "${s}".mcp_calls ORDER BY tool`,
    );
    expect(left.map((r) => r.tool)).toEqual(["aged-1", "aged-29", "fresh"]);
    expect(events).toEqual([
      {
        event: "usage.call_log_pruned",
        fields: { deleted: 3, keepDays: 30, steps: 1, ms: 0, more: false, stopped: false },
      },
    ]);
  });
});

/** Waits (real time, at most 5 s) until `cond` holds, then asserts it. */
async function eventually(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
}

describe("postgresCallLog retention across steps and processes", () => {
  test("two sinks on one table work off a multi-step backlog oldest first, without failing or overlapping", async () => {
    const s = await migrated();
    const aged = PRUNE_BATCH * 3 + 7;
    await sql.unsafe(
      `INSERT INTO "${s}".mcp_calls (created_at, caller, tool, args, duration_ms, ok)
       SELECT now() - make_interval(days => 40, secs => i), 'c', 'aged', '{}'::jsonb, 1, true
       FROM generate_series(1, ${aged}) AS i`,
    );
    const second = openSecondClient();
    const secondSql = (second.kind === "drizzle"
      ? second.client.$client
      : second.client) as unknown as Sql;
    try {
      const sinks = [sql, secondSql].map((client) => {
        const { log, events } = captureLog();
        const sink = postgresCallLog({
          sql: client,
          table: { schema: s, name: "mcp_calls" },
          maxBuffered: 10,
          maxBatch: 10,
          retention: { keepDays: 30 },
          clock: manualClock(),
          log,
        });
        return { sink, events };
      });
      for (const { sink } of sinks) sink.record(callRecord({ tool: "fresh" }));
      const counted = () =>
        sinks.reduce(
          (n, { events }) => n + events.reduce((m, e) => m + Number(e.fields.deleted ?? 0), 0),
          0,
        );
      await eventually(() => counted() === aged);
      for (const { sink } of sinks) await sink.idle();
      const all = sinks.flatMap(({ events }) => events);
      expect(all.every((e) => e.event === "usage.call_log_pruned")).toBe(true);
      expect(sinks.reduce((n, { sink }) => n + sink.pruned(), 0)).toBe(aged);
      const left = await sql.unsafe<{ tool: string; n: number }>(
        `SELECT tool, count(*)::int AS n FROM "${s}".mcp_calls GROUP BY tool`,
      );
      expect(left).toEqual([{ tool: "fresh", n: 2 }]);
    } finally {
      await second.close();
    }
  });
});

/** Fifty concurrent adds of 1..50: fifty distinct totals, the largest the exact sum. */
async function concurrentAdds(store: SpendStore, caller: string): Promise<number[]> {
  const totals = await Promise.all(
    Array.from({ length: 50 }, (_, i) => store.add(caller, "tokens", i + 1)),
  );
  return totals.sort((a, b) => a - b);
}

function ceilingOn(store: SpendStore, ceiling: number) {
  return createSpendCeiling({
    store,
    unit: "tokens",
    ceiling,
    prices: null,
    refusal: (used, c) => `reached ${used}/${c}`,
    errorClass: CeilingReached,
    clock: manualClock(Date.now()),
    log: () => {},
  });
}

describe("postgresSpendStore", () => {
  test("rootstock shape: totals come back as numbers, per caller and unit, exact under concurrency", async () => {
    const s = await migrated();
    const store = postgresSpendStore({ sql, shape: { kind: "rootstock", schema: s } });
    expect(await store.load("user-1", "tokens")).toBe(0);
    const totals = await concurrentAdds(store, "user-1");
    expect(new Set(totals).size).toBe(50);
    expect(totals.at(-1)).toBe(1275);
    expect(await store.load("user-1", "tokens")).toBe(1275);
    expect(await store.add("user-1", "usd", "0.000123")).toBe(0.000123);
    expect(await store.add("user-1", "usd", "0.5")).toBe(0.500123);
    expect(await store.load("user-1", "usd")).toBe(0.500123);
    expect(await store.load("user-2", "tokens")).toBe(0);
    const [day] = await sql.unsafe<{ ok: boolean }>(
      `SELECT bool_and(window_start = (now() at time zone 'utc')::date) AS ok FROM "${s}".spend`,
    );
    expect(day?.ok).toBe(true);
  });

  test("day-user-tokens shape on a consumer's own table: same answers", async () => {
    const s = await migrated();
    await sql.unsafe(
      `CREATE TABLE "${s}".app_daily_spend (day date NOT NULL, user_id text NOT NULL,
         tokens_used bigint NOT NULL DEFAULT 0, PRIMARY KEY (day, user_id))`,
    );
    const store = postgresSpendStore({
      sql,
      shape: {
        kind: "day-user-tokens",
        schema: s,
        table: "app_daily_spend",
        day: "day",
        user: "user_id",
        used: "tokens_used",
      },
    });
    expect(store.units).toEqual(["tokens"]);
    expect(await store.load("user-1", "tokens")).toBe(0);
    const totals = await concurrentAdds(store, "user-1");
    expect(new Set(totals).size).toBe(50);
    expect(totals.at(-1)).toBe(1275);
    expect(await store.load("user-1", "tokens")).toBe(1275);
  });

  test("two ceilings on one store share the total, on both shapes", async () => {
    const s = await migrated();
    await sql.unsafe(
      `CREATE TABLE "${s}".app_daily_spend (day date NOT NULL, user_id text NOT NULL,
         tokens_used bigint NOT NULL DEFAULT 0, PRIMARY KEY (day, user_id))`,
    );
    const stores = [
      postgresSpendStore({ sql, shape: { kind: "rootstock", schema: s } }),
      postgresSpendStore({
        sql,
        shape: {
          kind: "day-user-tokens",
          schema: s,
          table: "app_daily_spend",
          day: "day",
          user: "user_id",
          used: "tokens_used",
        },
      }),
    ];
    for (const store of stores) {
      const a = ceilingOn(store, 100).forCaller("user-1");
      const b = ceilingOn(store, 100).forCaller("user-1");
      await a.assertWithin();
      await b.assertWithin();
      await a.record({ model: "model-a", input: 30, output: 30 });
      await b.record({ model: "model-a", input: 39, output: 0 }); // the store answers 99
      await b.assertWithin();
      await a.record({ model: "model-a", input: 1, output: 0 }); // 100: a learns b's spend
      await expect(a.assertWithin()).rejects.toThrow("reached 100/100");
      // A third process starting now reads the shared total.
      await expect(ceilingOn(store, 100).forCaller("user-1").assertWithin()).rejects.toThrow(
        CeilingReached,
      );
      await ceilingOn(store, 100).forCaller("user-2").assertWithin();
    }
  });
});
