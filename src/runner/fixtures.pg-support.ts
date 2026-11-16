import { sql as drizzleSql } from "drizzle-orm";
import type { Sql, Transactor } from "../db/index.ts";
import { lockDriver, openBunSqlClient, openPostgresJsClient } from "../lock/fixtures.pg-support.ts";
import {
  acquireRunLock,
  bunSqlLockSession,
  type LockDeps,
  type LockSlice,
  lockSlice,
  postgresJsLockSession,
  type RunLock,
} from "../lock/index.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { migrateSlice } from "../migrate/slice.ts";
import { type CursorTable, cursorTable, type QueueEvent } from "../queue/index.ts";
import { runsInput } from "../runs/fixtures.test-support.ts";
import {
  type QuarantineTable,
  quarantineTable,
  type RunsEvent,
  type RunsSlice,
  runsSlice,
} from "../runs/index.ts";
import type { PullDeps, PullDoc, PullRef, PullSource, RunnerEvent } from "./types.ts";

/** The runner suites' synthetic world (contract §0.3, §9): one schema per case. */
export interface RunnerEnv {
  sc: string;
  lock: LockSlice;
  runs: RunsSlice;
  quarantine: QuarantineTable;
  cursors: CursorTable;
  /** `"<sc>".pull_docs`: what the memory source's load writes. */
  D: string;
  R: string;
  Q: string;
  C: string;
  events: (RunnerEvent | RunsEvent | QueueEvent)[];
  deps: PullDeps;
  acquire: (name: string) => Promise<RunLock>;
}

export const lockDeps: LockDeps = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  randomUUID: () => crypto.randomUUID(),
  sleep: (ms) => Bun.sleep(ms),
};

export function runnerLockSlice(sc: string): LockSlice {
  return lockSlice({
    table: { schema: sc },
    profile: "lock",
    names: ["alpha-sync", "beta-sync", "shared-write", "delta:*"],
    heartbeatSeconds: 5,
    probeStallSeconds: 10,
    maxRecoveries: 3,
    endTimeoutSeconds: 1,
    wait: { maxMs: 0, pollIntervalMs: 10 },
  });
}

export function takeLock(lock: LockSlice, name: string): Promise<RunLock> {
  return acquireRunLock(
    () =>
      lockDriver() === "bun-sql"
        ? bunSqlLockSession(openBunSqlClient(), lock)
        : postgresJsLockSession(openPostgresJsClient(), lock),
    lock,
    name,
    lockDeps,
  );
}

/** Rootstock's tables in a fresh schema, plus the test's own doc table. */
export async function runnerEnv(tx: Transactor, sc: string, held: RunLock[]): Promise<RunnerEnv> {
  await applyRootstockMigrations(tx, migrateSlice({ schema: sc }));
  await tx.sql.unsafe(
    `CREATE TABLE "${sc}".pull_docs (external_id text PRIMARY KEY, content_hash text NOT NULL, body text)`,
  );
  return runnerEnvOf(sc, held);
}

/** The slices and helpers over an already-built schema (a child process's view). */
export function runnerEnvOf(sc: string, held: RunLock[]): RunnerEnv {
  const lock = runnerLockSlice(sc);
  const events: RunnerEnv["events"] = [];
  return {
    sc,
    lock,
    runs: runsSlice(runsInput(), { schema: sc }),
    quarantine: quarantineTable({
      table: { schema: sc },
      maxPayloadBytes: 65_536,
      maxReasonChars: 500,
    }),
    cursors: cursorTable({
      table: { schema: sc },
      value: "jsonb",
      maxNameChars: 200,
      maxValueChars: 10_000,
    }),
    D: `"${sc}".pull_docs`,
    R: `"${sc}".runs`,
    Q: `"${sc}".quarantine`,
    C: `"${sc}".cursors`,
    events,
    deps: {
      runs: {
        now: () => Date.now(),
        randomUUID: () => crypto.randomUUID(),
        onEvent: (e) => events.push(e),
      },
      queueHooks: { onEvent: (e) => events.push(e) },
      onEvent: (e) => events.push(e),
    },
    acquire: async (name) => {
      const l = await takeLock(lock, name);
      held.push(l);
      return l;
    },
  };
}

/** One record of the memory source, with its failure switches. */
export interface Rec {
  id: string;
  hash: string;
  /** Withhold the hash from the listing (only fetch knows it). */
  hashAfterFetch?: boolean;
  failFetch?: boolean;
  wrongId?: boolean;
  failLoad?: boolean;
  /** The load throws a quota error. */
  quota?: boolean;
  /** The load reports a quota hit through its context and still writes. */
  quotaHit?: boolean;
  /** The load meters 10 in / 20 out tokens of model-a and counts one "calls". */
  meter?: boolean;
  /** Overrides the ref's cursor (default: its 1-based position). */
  cursor?: unknown;
}

export interface MemRef extends PullRef {
  cursor: unknown;
}
export interface MemDoc extends PullDoc {
  body: string;
}

export class QuotaError extends Error {
  override name = "QuotaError";
}

/** A write through the driver's own transaction object, in that driver's own API. */
export async function nativeExec(
  id: Transactor["id"],
  native: unknown,
  text: string,
  params: unknown[],
): Promise<void> {
  if (id === "drizzle") {
    // drizzle has no positional parameters: inline the two text values safely.
    const tx = native as { execute(q: unknown): Promise<unknown> };
    const [a, b] = params as [string, string];
    await tx.execute(
      drizzleSql`${drizzleSql.raw(text.split("$1")[0] as string)}${a}${drizzleSql.raw(
        (text.split("$1")[1] as string).split("$2")[0] as string,
      )}${b}${drizzleSql.raw((text.split("$2")[1] as string) ?? "")}`,
    );
    return;
  }
  await (native as { unsafe(q: string, p: unknown[]): Promise<unknown> }).unsafe(text, params);
}

export interface MemSource extends PullSource<MemRef, MemDoc, unknown> {
  fetches: string[];
  /** Called inside the batch transaction, before each load. */
  beforeLoad?: (id: string) => Promise<void>;
  /** Resolves each fetch only after this; default immediately. */
  fetchGate?: (id: string) => Promise<void>;
  /** Called during each fetch. */
  duringFetch?: (id: string) => Promise<void>;
}

/** An in-memory source over `recs`, loading into `env.D` through `native`. */
export function memSource(
  env: RunnerEnv,
  tx: Transactor,
  recs: Rec[],
  opts: {
    job?: string;
    boundedBackfill?: boolean;
    excluded?: { reason: string; count: number }[];
    nextCursor?: unknown;
    listCalls?: { cursor: unknown; since: Date | undefined }[];
    repoint?: (id: string) => boolean | "throw";
    planLoad?: boolean;
    /** List only the refs after (exclusive) or from (inclusive) a stored numeric cursor. */
    fromCursor?: "exclusive" | "inclusive";
  } = {},
): MemSource {
  const byId = new Map<string, Rec>();
  for (const r of recs) byId.set(r.id, r);
  const src: MemSource = {
    job: opts.job ?? "alpha-sync",
    ...(opts.boundedBackfill ? { boundedBackfill: true } : {}),
    fetches: [],
    cursorOf: (ref) => ref.cursor,
    async list(cursor, since) {
      opts.listCalls?.push({ cursor, since });
      const all = recs.map((r, i) => ({
        externalId: r.id,
        ...(r.hashAfterFetch ? {} : { contentHash: r.hash }),
        cursor: r.cursor ?? i + 1,
      }));
      const from = opts.fromCursor;
      const refs =
        from === undefined || typeof cursor !== "number"
          ? all
          : all.filter((r) =>
              from === "inclusive" ? (r.cursor as number) >= cursor : (r.cursor as number) > cursor,
            );
      return {
        refs,
        ...(opts.excluded ? { excluded: opts.excluded } : {}),
        ...(opts.nextCursor !== undefined ? { nextCursor: opts.nextCursor } : {}),
      };
    },
    fetch: async (ref) => {
      src.fetches.push(ref.externalId);
      await src.duringFetch?.(ref.externalId);
      await src.fetchGate?.(ref.externalId);
      const r = byId.get(ref.externalId) as Rec;
      if (r.failFetch) throw new Error(`fetch failed for ${r.id}`);
      return {
        externalId: r.wrongId ? `${r.id}-other` : r.id,
        contentHash: r.hash,
        body: `body ${r.id}`,
      };
    },
    async existing(ids) {
      if (ids.length === 0) return new Map();
      const rows = await tx.sql.unsafe<{ external_id: string; content_hash: string }>(
        `SELECT external_id, content_hash FROM ${env.D} WHERE external_id IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
        [JSON.stringify(ids)],
      );
      return new Map(rows.map((r) => [r.external_id, r.content_hash]));
    },
    async load(native, doc, ctx) {
      await src.beforeLoad?.(doc.externalId);
      const r = byId.get(doc.externalId);
      if (r?.meter) {
        ctx.meter("model-a", 10, 20);
        ctx.count("calls");
      }
      if (r?.quotaHit) ctx.quotaHit();
      if (r?.quota) throw new QuotaError(`quota for ${doc.externalId}`);
      if (r?.failLoad) throw new Error(`load failed for ${doc.externalId}`);
      await nativeExec(
        tx.id,
        native,
        `INSERT INTO ${env.D} (external_id, content_hash) VALUES ($1, $2) ON CONFLICT (external_id) DO UPDATE SET content_hash = excluded.content_hash`,
        [doc.externalId, doc.contentHash],
      );
    },
  };
  if (opts.repoint) {
    const repoint = opts.repoint;
    src.tryRepoint = async (_native, doc) => {
      const r = repoint(doc.externalId);
      if (r === "throw") throw new Error(`repoint failed for ${doc.externalId}`);
      return r;
    };
  }
  if (opts.planLoad) {
    src.planLoad = async (native, doc) => {
      await nativeExec(
        tx.id,
        native,
        `INSERT INTO ${env.D} (external_id, content_hash) VALUES ($1, $2)`,
        [doc.externalId, doc.contentHash],
      );
      return { wrote: doc.externalId };
    };
  }
  return src;
}

/** The rows of the doc table, external_id order. */
export async function docs(sql: Sql, env: RunnerEnv): Promise<string[]> {
  const rows = await sql.unsafe<{ external_id: string }>(
    `SELECT external_id FROM ${env.D} ORDER BY external_id`,
  );
  return rows.map((r) => r.external_id);
}

export async function cursorOf(sql: Sql, env: RunnerEnv, name = "alpha-sync"): Promise<unknown> {
  const [row] = await sql.unsafe<{ value: string }>(
    `SELECT value::text AS value FROM ${env.C} WHERE name = $1`,
    [name],
  );
  return row === undefined ? undefined : JSON.parse(row.value);
}

export async function quarantineRows(
  sql: Sql,
  env: RunnerEnv,
): Promise<{ external_id: string; status: string; reason: string }[]> {
  return sql.unsafe(`SELECT external_id, status, reason FROM ${env.Q} ORDER BY external_id`);
}

export async function runRows(sql: Sql, env: RunnerEnv): Promise<Record<string, unknown>[]> {
  return sql.unsafe(
    `SELECT id::text AS id, status, reason, listed, written, unchanged, quarantined, excluded_count AS excluded, reconciled, counts::text AS counts FROM ${env.R} ORDER BY started_at`,
  );
}
