import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineRootstockConfig, type RootstockConfigInput } from "./config/index.ts";
import type { Sql } from "./db/index.ts";
import { openTestTransactor, type TestTransactor } from "./db/transactor.pg-support.ts";
import { lockDriver, openBunSqlClient, openPostgresJsClient } from "./lock/fixtures.pg-support.ts";
import {
  acquireRunLock,
  bunSqlLockSession,
  type LockDeps,
  type LockSession,
  type LockSlice,
  locksHeld,
  postgresJsLockSession,
} from "./lock/index.ts";
import { schemaFactory } from "./migrate/fixtures.pg-support.ts";
import { applyMigrations, migrationStatus, rootstockSource } from "./migrate/index.ts";
import { ack, claim, enqueue, getCursor, setCursor } from "./queue/index.ts";

// R-O1 (contract §6): the lock and the queue composed through
// defineRootstockConfig, on three synthetic shapes, once per transactor kind.
// "origin" brings its own tables (created here with the origin's shape),
// "lock only" uses rootstock's default run_locks, and "schema only" has no
// slices at all. Each ends with a clean migrationStatus.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_lq");
let rootstockExisted = true;

const LOCK_PROFILE = {
  max: 1,
  maxCeiling: 1,
  idleTimeoutSeconds: "driver-default",
  maxLifetimeSeconds: "never",
  connectTimeoutSeconds: "driver-default",
  prepare: "driver-default",
  keepAliveSeconds: "driver-default",
  statementTimeoutMs: 0,
  readOnly: false,
} as const;

const LOCK = {
  profile: "lock",
  names: ["alpha-sync", "gamma-*"],
  heartbeatSeconds: 30,
  probeStallSeconds: 60,
  maxRecoveries: 5,
  endTimeoutSeconds: 5,
  wait: { maxMs: 5000, pollIntervalMs: 50 },
};

const QUEUE = {
  sources: ["alpha", "beta"],
  kinds: ["put", "drop"],
  stickyKind: "drop",
  expiredClaimClass: "ExpiredClaim",
  backoffMinutes: [1, 5, 30, 120, 240, 480],
  maxAttempts: 8,
  claimTimeoutMinutes: 30,
  maxDebounceSeconds: 900,
  maxDebounceSlideMinutes: 15,
  maxKeyChars: 512,
  maxNameChars: 128,
  maxPayloadBytes: 65536,
  maxClaimLimit: 500,
  enqueueLockTimeoutMs: 2000,
};

const ORIGIN_DDL = [
  `CREATE TABLE public.locks_o (
     name text PRIMARY KEY,
     holder uuid NOT NULL,
     acquired_at timestamptz NOT NULL DEFAULT now(),
     heartbeat_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE public.queue_o (
     key text PRIMARY KEY,
     source text NOT NULL,
     kind text NOT NULL,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     not_before timestamptz NOT NULL DEFAULT now(),
     claimed_at timestamptz,
     claimed_by text,
     attempts integer NOT NULL DEFAULT 0,
     last_error text,
     dead_at timestamptz,
     enqueued_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CHECK (key LIKE source || ':%'))`,
  `CREATE TABLE public.cursors_o (
     name text PRIMARY KEY,
     value text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now())`,
];
const ORIGIN_DROP = "DROP TABLE IF EXISTS public.locks_o, public.queue_o, public.cursors_o";

beforeAll(async () => {
  main = openTestTransactor();
  sql = main.transactor.sql;
  const [r] = await sql.unsafe("SELECT 1 AS one FROM pg_namespace WHERE nspname = 'rootstock'");
  rootstockExisted = r !== undefined;
  await sql.unsafe(ORIGIN_DROP);
});

afterAll(async () => {
  await sql.unsafe(ORIGIN_DROP);
  if (!rootstockExisted) await sql.unsafe("DROP SCHEMA IF EXISTS rootstock CASCADE");
  await dropAll(sql);
  await main.close();
});

function config(over: Partial<RootstockConfigInput>) {
  return defineRootstockConfig({
    client: { profiles: { lock: LOCK_PROFILE } },
    migrate: {},
    concurrency: { widths: { fetch: { default: 1, max: 1 } } },
    ...over,
  });
}

function open(slice: LockSlice): () => LockSession {
  return () =>
    lockDriver() === "bun-sql"
      ? bunSqlLockSession(openBunSqlClient(), slice)
      : postgresJsLockSession(openPostgresJsClient(), slice);
}

const deps: LockDeps = {
  now: () => Date.now(),
  setInterval: () => {
    throw new Error("the composition starts no keepalive");
  },
  clearInterval: () => {},
  randomUUID: () => crypto.randomUUID(),
  sleep: (ms) => Bun.sleep(ms),
};

async function apply(c: ReturnType<typeof config>): Promise<void> {
  await applyMigrations(main.transactor, c.migrate, [rootstockSource(c.migrate)], {
    entry: "deploy",
    backup: { skip: "composition test" },
    fix: "bun run migrate apply --manual",
  });
}

async function clean(c: ReturnType<typeof config>): Promise<void> {
  const status = await migrationStatus(sql, c.migrate, [rootstockSource(c.migrate)]);
  expect(status.red).toBe(false);
}

describe("lock and queue composed", () => {
  test("origin: the consumer's own lock, queue and text cursor tables", async () => {
    for (const ddl of ORIGIN_DDL) await sql.unsafe(ddl);
    const c = config({
      migrate: { schema: schema() },
      lock: { ...LOCK, table: { schema: "public", name: "locks_o" } },
      queue: {
        ...QUEUE,
        table: { schema: "public", name: "queue_o" },
        cursors: {
          table: { schema: "public", name: "cursors_o" },
          value: "text",
          maxNameChars: 128,
          maxValueChars: 512,
        },
      },
    });
    const lock = c.lock as LockSlice;
    const queue = c.queue;
    if (queue === null || queue.cursors === null) throw new Error("queue slice missing");
    await apply(c);
    const run = await acquireRunLock(open(lock), lock, "alpha-sync", deps);
    try {
      await run.ensureExclusive();
      const [fence] = await sql.unsafe(
        "SELECT holder::text AS holder FROM public.locks_o WHERE name = 'alpha-sync'",
      );
      expect(fence?.holder).toBe(run.holder);
      expect(
        await enqueue(main.transactor, queue, {
          key: "alpha:1",
          source: "alpha",
          kind: "put",
          payload: { n: 1 },
          debounceSeconds: 0,
        }),
      ).toBe("enqueued");
      const rows = await claim(sql, queue, { source: "alpha", limit: 10, worker: "worker-a" });
      expect(rows.map((r) => [r.key, r.payload])).toEqual([["alpha:1", { n: 1 }]]);
      expect(await ack(sql, queue, { key: "alpha:1", worker: "worker-a" })).toBe("deleted");
      await setCursor(sql, queue.cursors, "alpha-feed", "page-2");
      expect(await getCursor(sql, queue.cursors, "alpha-feed")).toBe("page-2");
    } finally {
      await run.release();
    }
    expect((await locksHeld(sql, ["alpha-sync"])).get("alpha-sync")).toBe(false);
    await clean(c);
  });

  test("lock only: rootstock's default run_locks", async () => {
    const c = config({ lock: LOCK });
    const lock = c.lock as LockSlice;
    expect(lock.table).toEqual({ schema: "rootstock", name: "run_locks" });
    expect(c.queue).toBeNull();
    await apply(c);
    const run = await acquireRunLock(open(lock), lock, "gamma-1", deps);
    try {
      await run.ensureExclusive();
      const [fence] = await sql.unsafe(
        "SELECT holder::text AS holder FROM rootstock.run_locks WHERE name = 'gamma-1'",
      );
      expect(fence?.holder).toBe(run.holder);
    } finally {
      await run.release();
    }
    await clean(c);
  });

  test("schema only: no slices, only the migrations", async () => {
    const c = config({ migrate: { schema: schema() } });
    expect([c.lock, c.queue]).toEqual([null, null]);
    expect(c.invariants).toEqual([]);
    await apply(c);
    const tables = await sql.unsafe<{ t: string }>(
      "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1",
      [c.migrate.schema],
    );
    expect(tables.map((r) => r.t)).toEqual([
      "cursors",
      "quarantine",
      "run_locks",
      "runs",
      "schema_migrations",
      "work_queue",
    ]);
    await clean(c);
  });
});
