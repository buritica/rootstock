import { describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import {
  callLogInsert,
  callLogPrune,
  PRUNE_BATCH,
  PRUNE_EVERY_MS,
  PRUNE_SOON_MS,
  PRUNE_STEPS,
  postgresCallLog,
  storableJson,
} from "./call-log.ts";
import { usageErrorCode } from "./errors.ts";
import { callRecord, captureLog, manualClock } from "./fixtures.test-support.ts";

const TABLE = { schema: "rootstock", name: "mcp_calls" };

/** A fake client whose inserts wait until the test releases them. */
function gatedSql() {
  const sent: { text: string; rows: Record<string, unknown>[] }[] = [];
  const waiting: (() => void)[] = [];
  let fail: unknown = null;
  const unsafe = (text: string, params?: readonly unknown[]) => {
    sent.push({ text, rows: JSON.parse(String(params?.[0])) });
    return new Promise<never[]>((resolve, reject) => {
      waiting.push(() => (fail === null ? resolve([]) : reject(fail)));
    });
  };
  const sql = Object.assign(() => Promise.resolve([]), { unsafe }) as unknown as Sql;
  return {
    sql,
    sent,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
    failWith: (err: unknown) => {
      fail = err;
    },
  };
}

/** Lets queued microtasks run (the writer starts on one). */
const tick = () => new Promise<void>((r) => queueMicrotask(r));

/** Ticks until `cond` holds, at most 1000 times, then asserts it. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

/** Releases inserts until the sink is idle, a bounded number of times. */
async function drained(
  db: { release: () => void },
  sink: { idle(): Promise<void> },
): Promise<void> {
  let done = false;
  const idle = sink.idle().then(() => {
    done = true;
  });
  for (let i = 0; i < 1000 && !done; i++) {
    db.release();
    await tick();
  }
  expect(done).toBe(true);
  await idle;
}

describe("postgresCallLog", () => {
  test("the batch statement: fixed columns, spliced table, $1::text::jsonb", () => {
    expect(callLogInsert(TABLE)).toBe(
      'insert into "rootstock"."mcp_calls" (caller, on_behalf_of, turn_id, tool, args, duration_ms, ok, error_class, result_ids, phases, tokens, cost_usd, cost_note, output_text, extra, server_sha, client_ua, mcp_protocol) select caller, on_behalf_of, turn_id, tool, args, duration_ms, ok, error_class, result_ids, phases, tokens, cost_usd, cost_note, output_text, extra, server_sha, client_ua, mcp_protocol from jsonb_to_recordset($1::text::jsonb) as x(caller text, on_behalf_of text, turn_id text, tool text, args jsonb, duration_ms integer, ok boolean, error_class text, result_ids jsonb, phases jsonb, tokens jsonb, cost_usd numeric, cost_note text, output_text text, extra jsonb, server_sha text, client_ua text, mcp_protocol text)',
    );
    expect(() => callLogInsert({ schema: 'x"; drop', name: "t" })).toThrow(/identifier/);
  });

  test("a blocked insert does not delay a call: record returns at once and later rows wait their turn", async () => {
    const db = gatedSql();
    const { log } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 10,
      maxBatch: 10,
      log,
    });
    sink.record(callRecord({ tool: "slow" }));
    await until(() => db.sent.length === 1);
    // The insert never answers; every further record still returns synchronously.
    let returned = 0;
    for (let i = 0; i < 5; i++) {
      expect(sink.record(callRecord({ tool: "echo" }))).toBeUndefined();
      returned++;
    }
    expect(returned).toBe(5);
    for (let i = 0; i < 20; i++) await tick();
    expect(db.sent).toHaveLength(1); // one writer, so one statement in flight
    let idle = false;
    const done = sink.idle().then(() => {
      idle = true;
    });
    for (let i = 0; i < 20; i++) await tick();
    expect(idle).toBe(false);
    await drained(db, sink);
    await done;
    expect(db.sent.map((s) => s.rows.length)).toEqual([1, 5]);
  });

  test("calls that finish together share one INSERT, in batches of at most maxBatch", async () => {
    const db = gatedSql();
    const { log } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 100,
      maxBatch: 3,
      log,
    });
    for (let i = 0; i < 7; i++) sink.record(callRecord({ durationMs: i }));
    await drained(db, sink);
    expect(db.sent.map((s) => s.rows.length)).toEqual([3, 3, 1]);
    expect(db.sent.flatMap((s) => s.rows.map((r) => r.duration_ms))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("overflow is dropped and counted: logged when a streak starts, every 100th, and on recovery", async () => {
    const db = gatedSql();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 2,
      maxBatch: 2,
      log,
    });
    sink.record(callRecord());
    await until(() => db.sent.length === 1); // the writer took the first row: the buffer is empty again
    sink.record(callRecord());
    sink.record(callRecord());
    for (let i = 0; i < 100; i++) sink.record(callRecord({ tool: "boom" }));
    expect(sink.dropped()).toBe(100);
    expect(events.map((e) => [e.event, e.fields.dropped])).toEqual([
      ["usage.call_log_dropped", 1],
      ["usage.call_log_dropped", 100],
    ]);
    expect(events[0]?.fields).toEqual({ tool: "boom", dropped: 1, droppedTotal: 1 });
    db.release();
    await until(() => db.sent.length === 2); // the writer took the buffered rows
    sink.record(callRecord());
    expect(events.at(-1)).toEqual({ event: "usage.call_log_recovered", fields: { dropped: 100 } });
    expect(sink.dropped()).toBe(100);
    await drained(db, sink);
  });

  test("the row: every column, args never null, no message, no stage, whole milliseconds", async () => {
    const db = gatedSql();
    const { log } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 10,
      maxBatch: 10,
      log,
    });
    sink.record(
      callRecord({
        stage: "rejected",
        tool: "nope",
        args: undefined as never,
        durationMs: 3.6,
        ok: false,
        errorClass: "UnknownTool",
        errorMessage: "SECRET-MESSAGE",
      }),
    );
    sink.record(
      callRecord({
        onBehalfOf: "someone",
        turnId: "t:1",
        resultIds: ["e1"],
        phases: { fts: 3 },
        tokens: { "model-a": { input: 1, output: 2 } },
        costUsd: "0.000001",
        costNote: "estimated",
        outputText: "out",
        extra: { k: 1 },
        serverSha: "abc",
        clientUa: "ua/1",
        mcpProtocol: "2025-06-18",
        durationMs: -4,
      }),
    );
    await drained(db, sink);
    const [rejected, full] = db.sent[0]?.rows ?? [];
    expect(rejected).toEqual({
      caller: "user-1",
      on_behalf_of: null,
      turn_id: null,
      tool: "nope",
      args: {},
      duration_ms: 4,
      ok: false,
      error_class: "UnknownTool",
      result_ids: null,
      phases: null,
      tokens: null,
      cost_usd: null,
      cost_note: null,
      output_text: null,
      extra: null,
      server_sha: null,
      client_ua: null,
      mcp_protocol: null,
    });
    expect(JSON.stringify(db.sent)).not.toContain("SECRET-MESSAGE");
    expect(full).toMatchObject({
      on_behalf_of: "someone",
      turn_id: "t:1",
      result_ids: ["e1"],
      phases: { fts: 3 },
      tokens: { "model-a": { input: 1, output: 2 } },
      cost_usd: "0.000001",
      cost_note: "estimated",
      output_text: "out",
      extra: { k: 1 },
      server_sha: "abc",
      client_ua: "ua/1",
      mcp_protocol: "2025-06-18",
      duration_ms: 0,
    });
  });

  test("refused batches: logged when a streak starts and every 100th, counted, and the recovery logged", async () => {
    const db = gatedSql();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 300,
      maxBatch: 1,
      log,
    });
    db.failWith(Object.assign(new Error("relation does not exist: SECRET"), { code: "42P01" }));
    sink.record(callRecord({ tool: "echo" }));
    sink.record(callRecord({ tool: "slow" }));
    for (let i = 0; i < 98; i++) sink.record(callRecord({ tool: "echo" }));
    await drained(db, sink);
    expect(sink.failedBatches()).toBe(100);
    expect(events).toEqual([
      {
        event: "usage.call_log_failed",
        fields: {
          stage: "insert",
          rows: 1,
          tools: ["echo"],
          errorClass: "42P01",
          failedBatches: 1,
        },
      },
      {
        event: "usage.call_log_failed",
        fields: {
          stage: "insert",
          rows: 1,
          tools: ["echo"],
          errorClass: "42P01",
          failedBatches: 100,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
    db.failWith(null);
    sink.record(callRecord());
    sink.record(callRecord());
    await drained(db, sink);
    expect(events.slice(2)).toEqual([
      { event: "usage.call_log_recovered_insert", fields: { failedBatches: 100, rows: 100 } },
    ]);
    expect(sink.failedBatches()).toBe(100);
    expect(db.sent).toHaveLength(102);
  });

  test("a row that cannot serialize is logged and dropped alone", async () => {
    const db = gatedSql();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 10,
      maxBatch: 10,
      log,
    });
    sink.record(callRecord({ tool: "boom", extra: { n: 1n } }));
    sink.record(callRecord());
    await drained(db, sink);
    expect(events).toEqual([
      {
        event: "usage.call_log_failed",
        fields: { stage: "build", rows: 1, tools: ["boom"], errorClass: "TypeError" },
      },
    ]);
    expect(db.sent.map((s) => s.rows.map((r) => r.tool))).toEqual([["echo"]]);
  });

  test("every NOT NULL column is coerced: a non-finite duration is 0, a huge one is capped, ok is a boolean", async () => {
    const db = gatedSql();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 10,
      maxBatch: 10,
      log: () => {},
    });
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1e12, 7.5]) {
      sink.record(callRecord({ durationMs: durationMs as number }));
    }
    sink.record(callRecord({ ok: "yes" as never }));
    sink.record(
      callRecord({ caller: null as never, tool: undefined as never, args: "x" as never }),
    );
    sink.record(callRecord({ caller: 42 as never, args: [1, 2] as never }));
    await drained(db, sink);
    const rows = db.sent.flatMap((x) => x.rows);
    expect(rows.map((r) => r.duration_ms)).toEqual([0, 0, 0, 2_147_483_647, 8, 12, 12, 12]);
    expect(rows.map((r) => r.ok)).toEqual([true, true, true, true, true, false, true, true]);
    expect(rows.slice(6).map((r) => [r.caller, r.tool, r.args])).toEqual([
      ["", "", {}],
      ["42", "echo", [1, 2]],
    ]);
  });

  test("a throwing logger changes nothing: record does not throw and later rows still drain", async () => {
    const db = gatedSql();
    const log = () => {
      throw new Error("logger down");
    };
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 1,
      maxBatch: 1,
      log,
    });
    db.failWith(new Error("refused"));
    sink.record(callRecord({ tool: "first" }));
    expect(() => sink.record(callRecord({ tool: "dropped" }))).not.toThrow(); // full: logs a drop
    expect(() => sink.record(callRecord({ tool: "dropped" }))).not.toThrow();
    await drained(db, sink); // the failed insert logs, and the writer still ends
    db.failWith(null);
    expect(() => sink.record(callRecord({ extra: { n: 1n } }))).not.toThrow(); // logs a build failure
    sink.record(callRecord({ tool: "later" }));
    await drained(db, sink);
    expect(db.sent.map((x) => x.rows.map((r) => r.tool))).toEqual([["first"], ["later"]]);
  });

  test("the tool name is cut at 200 characters in the row and in the drop log", async () => {
    const db = gatedSql();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 1,
      maxBatch: 1,
      log,
    });
    const long = "t".repeat(500);
    sink.record(callRecord({ tool: long }));
    sink.record(callRecord({ tool: long }));
    expect(events[0]?.fields.tool).toBe("t".repeat(200));
    await drained(db, sink);
    expect(db.sent[0]?.rows[0]?.tool).toBe("t".repeat(200));
  });

  test("idle resolves at once when nothing is buffered", async () => {
    const db = gatedSql();
    const sink = postgresCallLog({
      retention: null,
      sql: db.sql,
      table: TABLE,
      maxBuffered: 1,
      maxBatch: 1,
      log: () => {},
    });
    await sink.idle();
    expect(db.sent).toEqual([]);
  });

  test("refuses buffer numbers out of range", () => {
    const db = gatedSql();
    const make = (maxBuffered: number, maxBatch: number) => () =>
      postgresCallLog({
        retention: null,
        sql: db.sql,
        table: TABLE,
        maxBuffered,
        maxBatch,
        log: () => {},
      });
    for (const [b, n] of [
      [0, 1],
      [1.5, 1],
      [10, 0],
      [10, 11],
    ] as const) {
      let caught: unknown;
      try {
        make(b, n)();
      } catch (err) {
        caught = err;
      }
      expect(usageErrorCode(caught)).toBe("ERR_ROOTSTOCK_USAGE_CONFIG");
    }
  });
});

describe("storableJson", () => {
  test("drops NUL escapes and makes lone surrogates U+FFFD, leaving escaped backslashes and pairs alone", () => {
    const text = JSON.stringify({
      a: "x\u0000y",
      b: "\\u0000",
      c: "\ud800",
      d: "😀",
      e: "\\\u0000",
    });
    const out = storableJson(text);
    expect(JSON.parse(out)).toEqual({ a: "xy", b: "\\u0000", c: "�", d: "😀", e: "\\" });
  });
});

/**
 * A fake client for retention. Inserts answer with no rows; each prune step
 * takes the next entry of `steps` (a count, or an error to throw; 0 once
 * empty). With `gate`, every statement waits until `release()`.
 */
function pruneSql(steps: (number | Error)[] = [], gate = false) {
  const sent: { kind: "insert" | "prune"; params: readonly unknown[] }[] = [];
  const waiting: (() => void)[] = [];
  const unsafe = (text: string, params: readonly unknown[] = []) => {
    const kind = text.startsWith("insert") ? "insert" : "prune";
    sent.push({ kind, params });
    const answer = () => {
      if (kind === "insert") return [];
      const next = steps.shift() ?? 0;
      if (next instanceof Error) throw next;
      return [{ deleted: next }];
    };
    if (!gate) return Promise.resolve().then(answer);
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        try {
          resolve(answer());
        } catch (err) {
          reject(err);
        }
      });
    });
  };
  const sql = Object.assign(() => Promise.resolve([]), { unsafe }) as unknown as Sql;
  return {
    sql,
    sent,
    kinds: () => sent.map((x) => x.kind).join(","),
    prunes: () => sent.filter((x) => x.kind === "prune").length,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

const refused = (code: string) => Object.assign(new Error("SECRET-MESSAGE"), { code });

describe("postgresCallLog retention", () => {
  const make = (db: { sql: Sql }, clock = manualClock(), keepDays = 90) => {
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      sql: db.sql,
      table: TABLE,
      maxBuffered: 100,
      maxBatch: 100,
      retention: { keepDays },
      clock,
      log,
    });
    return { sink, events, clock };
  };
  const pruned = (deleted: number, more: boolean, keepDays = 90) => ({
    event: "usage.call_log_pruned",
    fields: { deleted, keepDays, more },
  });

  test("the prune statement: one bounded batch of the oldest rows past the cutoff, skipping locked rows, counted", () => {
    expect(callLogPrune(TABLE)).toBe(
      'with d as (delete from "rootstock"."mcp_calls" where id in (select id from "rootstock"."mcp_calls" where created_at < now() - make_interval(days => $1::int) order by created_at limit $2::int for update skip locked) returning 1) select count(*)::int as deleted from d',
    );
    expect(() => callLogPrune({ schema: 'x"; drop', name: "t" })).toThrow(/identifier/);
  });

  test("the first record prunes after its insert; not again within the hour; again after it", async () => {
    const db = pruneSql([3]);
    const { sink, events, clock } = make(db);
    sink.record(callRecord());
    await until(() => events.length === 1);
    await sink.idle();
    expect(db.kinds()).toBe("insert,prune");
    expect(db.sent[1]?.params).toEqual([90, PRUNE_BATCH]);
    expect(events).toEqual([pruned(3, false)]);
    clock.set(clock.monotonic() + PRUNE_EVERY_MS - 1);
    sink.record(callRecord());
    await sink.idle();
    expect(db.kinds()).toBe("insert,prune,insert");
    clock.set(clock.monotonic() + 1);
    sink.record(callRecord());
    await until(() => db.prunes() === 2);
    await sink.idle();
    expect(db.kinds()).toBe("insert,prune,insert,insert,prune");
    // A pass that deleted nothing logs nothing.
    expect(events.length).toBe(1);
  });

  test("a full batch takes another step; a pass stops at PRUNE_STEPS and the next is due PRUNE_SOON_MS later", async () => {
    const db = pruneSql(Array(PRUNE_STEPS + 1).fill(PRUNE_BATCH));
    const { sink, events, clock } = make(db);
    sink.record(callRecord());
    await until(() => events.length === 1);
    expect(db.prunes()).toBe(PRUNE_STEPS);
    expect(events).toEqual([pruned(PRUNE_BATCH * PRUNE_STEPS, true)]);
    // Not back to back: a record at once queues nothing.
    sink.record(callRecord());
    await sink.idle();
    expect(db.prunes()).toBe(PRUNE_STEPS);
    clock.set(clock.monotonic() + PRUNE_SOON_MS);
    sink.record(callRecord());
    await until(() => events.length === 2);
    expect(db.prunes()).toBe(PRUNE_STEPS + 2);
    expect(events[1]).toEqual(pruned(PRUNE_BATCH, false));
  });

  test("steady traffic cannot starve a pass: inserts and steps take turns", async () => {
    const db = pruneSql([PRUNE_BATCH, PRUNE_BATCH, PRUNE_BATCH, 0], true);
    const { sink, events } = make(db);
    sink.record(callRecord());
    // A row lands during every statement, so the buffer is never empty.
    for (let i = 0; i < 8; i++) {
      await until(() => db.sent.length === i + 1);
      sink.record(callRecord());
      db.release();
    }
    expect(db.kinds()).toBe("insert,prune,insert,prune,insert,prune,insert,prune");
    await until(() => events.length === 1);
    expect(events).toEqual([pruned(PRUNE_BATCH * 3, false)]);
  });

  test("idle drops a pending pass after its step in flight, and writes rows recorded meanwhile", async () => {
    const db = pruneSql([PRUNE_BATCH, PRUNE_BATCH], true);
    const { sink, events } = make(db);
    sink.record(callRecord());
    await until(() => db.sent.length === 1);
    db.release();
    await until(() => db.kinds() === "insert,prune");
    let done = false;
    const idle = sink.idle().then(() => {
      done = true;
    });
    sink.record(callRecord());
    await tick();
    expect(done).toBe(false);
    db.release();
    await until(() => db.sent.length === 3);
    db.release();
    await idle;
    expect(db.kinds()).toBe("insert,prune,insert");
    expect(events).toEqual([pruned(PRUNE_BATCH, true)]);
  });

  test("a refused step ends its pass with what it deleted, never throws, and the next pass waits the hour", async () => {
    const db = pruneSql([PRUNE_BATCH, refused("57014")]);
    const { sink, events, clock } = make(db);
    sink.record(callRecord());
    await until(() => events.length === 1);
    expect(events).toEqual([
      {
        event: "usage.call_log_prune_failed",
        fields: { keepDays: 90, deleted: PRUNE_BATCH, errorClass: "57014" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
    sink.record(callRecord());
    await sink.idle();
    expect(db.kinds()).toBe("insert,prune,prune,insert");
    expect(sink.failedBatches()).toBe(0);
    clock.set(clock.monotonic() + PRUNE_EVERY_MS - 1);
    sink.record(callRecord());
    await sink.idle();
    expect(db.prunes()).toBe(2);
    clock.set(clock.monotonic() + 1);
    sink.record(callRecord());
    await until(() => db.prunes() === 3);
  });

  test("a throwing clock is logged, record does not throw, and the row is still written", async () => {
    const db = pruneSql();
    const { log, events } = captureLog();
    const sink = postgresCallLog({
      sql: db.sql,
      table: TABLE,
      maxBuffered: 10,
      maxBatch: 10,
      retention: { keepDays: 30 },
      clock: {
        monotonic: () => {
          throw refused("clock");
        },
      },
      log,
    });
    expect(sink.record(callRecord())).toBeUndefined();
    await sink.idle();
    expect(db.kinds()).toBe("insert");
    expect(events.map((e) => e.event)).toEqual(["usage.call_log_prune_failed"]);
  });

  test("retention null never prunes", async () => {
    const db = pruneSql();
    const { log } = captureLog();
    const sink = postgresCallLog({
      sql: db.sql,
      table: TABLE,
      maxBuffered: 10,
      maxBatch: 10,
      retention: null,
      log,
    });
    sink.record(callRecord());
    await sink.idle();
    expect(db.kinds()).toBe("insert");
  });

  test("refuses retention out of range or without a clock", () => {
    const db = pruneSql();
    const make = (retention: unknown, clock: unknown) => () =>
      postgresCallLog({
        sql: db.sql,
        table: TABLE,
        maxBuffered: 10,
        maxBatch: 10,
        retention: retention as { keepDays: number },
        clock: clock as ReturnType<typeof manualClock>,
        log: () => {},
      });
    for (const [r, c] of [
      [{ keepDays: 6 }, manualClock()],
      [{ keepDays: 3651 }, manualClock()],
      [{ keepDays: 1.5 }, manualClock()],
      [{ keepDays: 30 }, undefined],
      [undefined, manualClock()],
    ] as const) {
      let caught: unknown;
      try {
        make(r, c)();
      } catch (err) {
        caught = err;
      }
      expect(usageErrorCode(caught)).toBe("ERR_ROOTSTOCK_USAGE_CONFIG");
    }
  });
});
