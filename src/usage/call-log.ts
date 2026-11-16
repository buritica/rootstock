import { quoteIdentifier, type Sql } from "../db/index.ts";
import { intIn, q } from "../internal/slice.ts";
import type { CallRecord, CallSink, LogEvent } from "../serve/types.ts";
import { errorClassOf } from "./error-class.ts";
import { configError } from "./errors.ts";

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
  const target = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
  return `insert into ${target} (${cols}) select ${cols} from jsonb_to_recordset($1::text::jsonb) as x(${typed})`;
}

const INT_MAX = 2_147_483_647;

/** One record as its row's JSON text. `errorMessage` and `stage` are never stored. */
function rowJson(r: CallRecord): string {
  return JSON.stringify({
    caller: r.caller,
    on_behalf_of: r.onBehalfOf,
    turn_id: r.turnId,
    tool: r.tool,
    args: r.args ?? {},
    duration_ms: Math.min(INT_MAX, Math.max(0, Math.round(r.durationMs))),
    ok: r.ok,
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
  sql: Sql;
  table: { schema: string; name: string };
  /** Rows waiting to be written, past which new ones are dropped and counted. */
  maxBuffered: number;
  /** Rows per INSERT. */
  maxBatch: number;
  log: LogEvent;
}

export type PostgresCallLog = CallSink & {
  /** Resolves once the buffer is empty and the writer has stopped. */
  idle(): Promise<void>;
  /** Rows dropped on a full buffer since this sink was made. */
  dropped(): number;
};

/**
 * The call log sink. `record` never waits on the database: it serializes the
 * row, pushes it on a bounded buffer and wakes the one background writer,
 * which inserts up to `maxBatch` rows per statement, so the log holds at most
 * one connection however many calls land at once. A full buffer drops the
 * row (`usage.call_log_dropped` when a streak starts and every 100th after;
 * `usage.call_log_recovered` with the streak's count once a row fits again).
 * A row that cannot be serialized, or a batch the server refuses, is logged
 * (`usage.call_log_failed` {stage, rows, tools, errorClass}) and lost.
 */
export function postgresCallLog(o: PostgresCallLogOptions): PostgresCallLog {
  if (!intIn(o.maxBuffered, 1, 1_000_000)) {
    throw configError(
      `postgresCallLog: maxBuffered must be an integer from 1 to 1000000 — got ${q(o.maxBuffered)}`,
    );
  }
  if (!intIn(o.maxBatch, 1, o.maxBuffered)) {
    throw configError(
      `postgresCallLog: maxBatch must be an integer from 1 to maxBuffered — got ${q(o.maxBatch)}`,
    );
  }
  const { sql, log, maxBuffered, maxBatch } = o;
  const statement = callLogInsert(o.table);
  const buffer: { tool: string; json: string }[] = [];
  let writer: Promise<void> | null = null;
  let streak = 0;
  let droppedTotal = 0;

  // Clears `writer` in the same synchronous step that sees the buffer empty,
  // so no row is stranded between "nothing left" and "writer gone". Every
  // insert error is caught inside, so this never rejects.
  const drain = async (): Promise<void> => {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, maxBatch);
      try {
        await sql.unsafe(statement, [`[${batch.map((r) => r.json).join(",")}]`]);
      } catch (err) {
        log("usage.call_log_failed", {
          stage: "insert",
          rows: batch.length,
          tools: [...new Set(batch.map((r) => r.tool))],
          errorClass: errorClassOf(err),
        });
      }
    }
    writer = null;
  };

  return {
    record(r) {
      if (buffer.length >= maxBuffered) {
        streak += 1;
        droppedTotal += 1;
        if (streak === 1 || streak % 100 === 0) {
          log("usage.call_log_dropped", { tool: r.tool, buffered: buffer.length, dropped: streak });
        }
        return;
      }
      let json: string;
      try {
        json = storableJson(rowJson(r));
      } catch (err) {
        log("usage.call_log_failed", {
          stage: "build",
          rows: 1,
          tools: [r.tool],
          errorClass: errorClassOf(err),
        });
        return;
      }
      if (streak > 0) {
        log("usage.call_log_recovered", { dropped: streak });
        streak = 0;
      }
      buffer.push({ tool: r.tool, json });
      // Started on a later microtask, so calls that finish together share an INSERT.
      writer ??= Promise.resolve().then(drain);
    },
    async idle() {
      while (writer) await writer;
    },
    dropped: () => droppedTotal,
  };
}
