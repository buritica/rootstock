import type { Sql } from "../db/index.ts";
import { cut, INT4_MAX, intIn, q, quoteTable } from "../internal/slice.ts";
import type { CallRecord, CallSink, LogEvent } from "../serve/types.ts";
import { errorClassOf } from "./error-class.ts";
import { configError } from "./errors.ts";
import { guardedLog } from "./log.ts";
import { MAX_BUFFERED } from "./slice.ts";

/** Column → the type `jsonb_to_recordset` reads it as. Fixed names, no column map. */
const COLUMNS: readonly (readonly [string, string])[] = [
  ["caller", "text"],
  ["on_behalf_of", "text"],
  ["turn_id", "text"],
  ["tool", "text"],
  ["args", "jsonb"],
  ["duration_ms", "integer"],
  ["ok", "boolean"],
  ["error_class", "text"],
  ["result_ids", "jsonb"],
  ["phases", "jsonb"],
  ["tokens", "jsonb"],
  ["cost_usd", "numeric"],
  ["cost_note", "text"],
  ["output_text", "text"],
  ["extra", "jsonb"],
  ["server_sha", "text"],
  ["client_ua", "text"],
  ["mcp_protocol", "text"],
];

/**
 * The one batch statement: rows travel as one JSON text. `$1::text::jsonb`,
 * not `$1::jsonb`: given the latter, postgres.js serializes the string a
 * second time and the server sees a JSON string, not an array. `id` and
 * `created_at` take their defaults.
 */
export function callLogInsert(table: { schema: string; name: string }): string {
  const cols = COLUMNS.map(([c]) => c).join(", ");
  const typed = COLUMNS.map(([c, t]) => `${c} ${t}`).join(", ");
  return `insert into ${quoteTable(table)} (${cols}) select ${cols} from jsonb_to_recordset($1::text::jsonb) as x(${typed})`;
}

/** A tool name as stored and logged: the client names it on a rejected call, so it is capped. */
const TOOL_MAX = 200;
const toolName = (tool: unknown): string => cut(notNullText(tool), TOOL_MAX);

/** A NOT NULL text column: absent is "", anything else its string. */
function notNullText(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Whole milliseconds from 0 to the int4 maximum; anything not a finite number is 0. */
function durationMs(ms: unknown): number {
  return typeof ms === "number" && Number.isFinite(ms)
    ? Math.min(INT4_MAX, Math.max(0, Math.round(ms)))
    : 0;
}

/**
 * One record as its row's JSON text. `errorMessage` and `stage` are never
 * stored. Every NOT NULL column is coerced so one odd record cannot fail its
 * whole batch: `caller` and `tool` are text ("" when absent), `args` is an
 * object or array (`{}` otherwise), the duration is clamped and `ok` is a
 * boolean. `resultIds ?? null` is deliberate too: absent reads as not extracted.
 */
function rowJson(r: CallRecord): string {
  return JSON.stringify({
    caller: notNullText(r.caller),
    on_behalf_of: r.onBehalfOf,
    turn_id: r.turnId,
    tool: toolName(r.tool),
    args: typeof r.args === "object" && r.args !== null ? r.args : {},
    duration_ms: durationMs(r.durationMs),
    ok: r.ok === true,
    error_class: r.errorClass,
    result_ids: r.resultIds ?? null,
    phases: r.phases,
    tokens: r.tokens,
    cost_usd: r.costUsd,
    cost_note: r.costNote,
    output_text: r.outputText,
    extra: r.extra,
    server_sha: r.serverSha,
    client_ua: r.clientUa,
    mcp_protocol: r.mcpProtocol,
  });
}

/**
 * An escape jsonb refuses (NUL, or a lone surrogate, which JSON.stringify
 * writes escaped), when it starts an odd run of backslashes: `\\u0000` is a
 * literal backslash followed by text.
 */
const UNSTORABLE = /(?<!\\)((?:\\\\)*)\\u(0000|d[89a-f][0-9a-f]{2})/gi;

/** `json` with NUL escapes dropped and lone surrogates made U+FFFD, so one row cannot fail its batch. */
export function storableJson(json: string): string {
  return json.replace(UNSTORABLE, (_m, run: string, hex: string) =>
    hex === "0000" ? run : `${run}\\ufffd`,
  );
}

export interface PostgresCallLogOptions {
  /** The tagged-template subset postgres.js and `Bun.SQL` share. */
  readonly sql: Sql;
  readonly table: { readonly schema: string; readonly name: string };
  /**
   * Rows waiting to be written, past which new ones are dropped and counted.
   * The batch in flight is not counted, so up to `maxBuffered + maxBatch`
   * rows can be held at once.
   */
  readonly maxBuffered: number;
  /** Rows per INSERT. */
  readonly maxBatch: number;
  readonly log: LogEvent;
}

export type PostgresCallLog = CallSink & {
  /**
   * Resolves once the buffer is empty and the writer has stopped, so only
   * once intake has stopped: rows recorded meanwhile are written first. A
   * hung insert hangs it too: shutdown bounds the wait (serve's `flushMs`).
   */
  idle(): Promise<void>;
  /** Rows dropped on a full buffer since this sink was made. */
  dropped(): number;
  /** Batches the server refused since this sink was made. */
  failedBatches(): number;
};

/**
 * The call log sink. `record` never waits on the database: it serializes the
 * row, pushes it on a bounded buffer and wakes the one background writer,
 * which inserts up to `maxBatch` rows per statement, so the log holds at most
 * one connection however many calls land at once. A full buffer drops the
 * row (`usage.call_log_dropped` when a streak starts and every 100th after;
 * `usage.call_log_recovered` with the streak's count once a row fits again).
 * A row that cannot be serialized is logged (`usage.call_log_failed`
 * {stage: "build", rows, tools, errorClass}) and lost. A batch the server
 * refuses is lost too and logged the same way (stage "insert", with
 * `failedBatches`, the streak's count) when a streak of refused batches
 * starts and every 100th after; the first batch written after a streak logs
 * `usage.call_log_recovered_insert` {failedBatches, rows}. Neither `record`
 * nor the writer ever throws or rejects: a throwing `log` is swallowed.
 *
 * The sink sets no timeout on an insert (the driver's or the server's
 * statement timeout applies); serve's `flushMs` bounds the wait at shutdown.
 * The table keeps every row: pruning old ones is the consumer's job.
 */
export function postgresCallLog(o: PostgresCallLogOptions): PostgresCallLog {
  if (!intIn(o.maxBuffered, 1, MAX_BUFFERED)) {
    throw configError(
      `postgresCallLog: maxBuffered must be an integer from 1 to ${MAX_BUFFERED} — got ${q(o.maxBuffered)}`,
    );
  }
  if (!intIn(o.maxBatch, 1, o.maxBuffered)) {
    throw configError(
      `postgresCallLog: maxBatch must be an integer from 1 to maxBuffered — got ${q(o.maxBatch)}`,
    );
  }
  const { sql, maxBuffered, maxBatch } = o;
  const log = guardedLog(o.log);
  const statement = callLogInsert(o.table);
  const buffer: { tool: string; json: string }[] = [];
  let writer: Promise<void> | null = null;
  let streak = 0;
  let droppedTotal = 0;
  // The current streak of refused batches, the rows they held, and the total.
  let failStreak = 0;
  let failStreakRows = 0;
  let failedTotal = 0;

  // Clears `writer` in the same synchronous step that sees the buffer empty,
  // so no row is stranded between "nothing left" and "writer gone"; the
  // `finally` clears it on any other way out too, so a later record starts a
  // fresh writer. Every insert error is caught inside.
  const drain = async (): Promise<void> => {
    try {
      while (buffer.length > 0) {
        const batch = buffer.splice(0, maxBatch);
        try {
          await sql.unsafe(statement, [`[${batch.map((r) => r.json).join(",")}]`]);
          if (failStreak > 0) {
            log("usage.call_log_recovered_insert", {
              failedBatches: failStreak,
              rows: failStreakRows,
            });
            failStreak = 0;
            failStreakRows = 0;
          }
        } catch (err) {
          failStreak += 1;
          failStreakRows += batch.length;
          failedTotal += 1;
          if (failStreak === 1 || failStreak % 100 === 0) {
            log("usage.call_log_failed", {
              stage: "insert",
              rows: batch.length,
              tools: [...new Set(batch.map((r) => r.tool))],
              errorClass: errorClassOf(err),
              failedBatches: failStreak,
            });
          }
        }
      }
    } finally {
      writer = null;
    }
  };

  return {
    record(r) {
      let tool = "";
      let json: string;
      try {
        tool = toolName(r.tool);
        if (buffer.length >= maxBuffered) {
          streak += 1;
          droppedTotal += 1;
          if (streak === 1 || streak % 100 === 0) {
            log("usage.call_log_dropped", { tool, dropped: streak, droppedTotal });
          }
          return;
        }
        json = storableJson(rowJson(r));
      } catch (err) {
        log("usage.call_log_failed", {
          stage: "build",
          rows: 1,
          tools: [tool],
          errorClass: errorClassOf(err),
        });
        return;
      }
      if (streak > 0) {
        log("usage.call_log_recovered", { dropped: streak });
        streak = 0;
      }
      buffer.push({ tool, json });
      // Started on a later microtask, so calls that finish together share an INSERT.
      writer ??= Promise.resolve()
        .then(drain)
        .then(undefined, () => undefined);
    },
    async idle() {
      while (writer) await writer;
    },
    dropped: () => droppedTotal,
    failedBatches: () => failedTotal,
  };
}
