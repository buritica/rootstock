import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { applyMigrationList, applyRootstockMigrations } from "./apply.ts";
import { schemaFactory } from "./fixtures.pg-support.ts";
import { rootstockMigrations } from "./migrations.ts";
import { migrateSlice } from "./slice.ts";
import { rootstockMigrationStatus } from "./status.ts";

// R-C1: the three Stage C tables, applied by the real applier as part of
// rootstock's own source, once per transactor kind, each case in schemas of
// its own. R-D1 (0.8.0) adds the Stage D files: two tables and two
// work_queue columns.

const SHIPPED = rootstockMigrations();
const STAGE_C = SHIPPED.slice(1, 4).map((m) => m.filename);
const STAGE_D = SHIPPED.slice(4).map((m) => m.filename);

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_c");

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

interface Column {
  table: string;
  column: string;
  type: string;
  nullable: string;
  default: string | null;
}

async function columns(s: string): Promise<Column[]> {
  return sql.unsafe<Column>(
    `SELECT table_name AS "table", column_name AS "column", data_type AS "type",
            is_nullable AS nullable, column_default AS "default"
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name IN ('run_locks', 'work_queue', 'cursors')
     ORDER BY table_name, ordinal_position`,
    [s],
  );
}

const TS = "timestamp with time zone";
const SHAPE: Column[] = [
  { table: "cursors", column: "name", type: "text", nullable: "NO", default: null },
  { table: "cursors", column: "value", type: "jsonb", nullable: "NO", default: null },
  { table: "cursors", column: "updated_at", type: TS, nullable: "NO", default: "now()" },
  { table: "run_locks", column: "name", type: "text", nullable: "NO", default: null },
  { table: "run_locks", column: "holder", type: "uuid", nullable: "NO", default: null },
  { table: "run_locks", column: "acquired_at", type: TS, nullable: "NO", default: "now()" },
  { table: "run_locks", column: "heartbeat_at", type: TS, nullable: "NO", default: "now()" },
  { table: "work_queue", column: "key", type: "text", nullable: "NO", default: null },
  { table: "work_queue", column: "source", type: "text", nullable: "NO", default: null },
  { table: "work_queue", column: "kind", type: "text", nullable: "NO", default: null },
  {
    table: "work_queue",
    column: "payload",
    type: "jsonb",
    nullable: "NO",
    default: "'{}'::jsonb",
  },
  { table: "work_queue", column: "not_before", type: TS, nullable: "NO", default: "now()" },
  { table: "work_queue", column: "claimed_at", type: TS, nullable: "YES", default: null },
  { table: "work_queue", column: "claimed_by", type: "text", nullable: "YES", default: null },
  { table: "work_queue", column: "attempts", type: "integer", nullable: "NO", default: "0" },
  { table: "work_queue", column: "last_error", type: "text", nullable: "YES", default: null },
  { table: "work_queue", column: "dead_at", type: TS, nullable: "YES", default: null },
  { table: "work_queue", column: "enqueued_at", type: TS, nullable: "NO", default: "now()" },
  { table: "work_queue", column: "updated_at", type: TS, nullable: "NO", default: "now()" },
  { table: "work_queue", column: "version", type: "bigint", nullable: "NO", default: "0" },
  { table: "work_queue", column: "claim_token", type: "uuid", nullable: "YES", default: null },
];

async function applied(s: string): Promise<string[]> {
  const rows = await sql.unsafe<{ filename: string }>(
    `SELECT filename FROM "${s}".schema_migrations ORDER BY filename`,
  );
  return rows.map((r) => r.filename);
}

describe("the Stage C tables", () => {
  test("apply on a fresh schema, re-run as a no-op, and leave status clean", async () => {
    const slice = migrateSlice({ schema: schema() });
    const first = await applyRootstockMigrations(main.transactor, slice);
    expect(first.applied).toEqual(SHIPPED.map((m) => m.filename));
    const again = await applyRootstockMigrations(main.transactor, slice);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(SHIPPED.length);
    const status = await rootstockMigrationStatus(sql, slice);
    expect(status.red).toBe(false);
    expect(status.applied).toEqual(SHIPPED.map((m) => m.filename));
  });

  test("the columns, types, nullability and defaults equal the pinned shape", async () => {
    const s = schema();
    await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
    expect(await columns(s)).toEqual(SHAPE);
    const constraints = await sql.unsafe<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE connamespace = to_regnamespace($1::text) AND contype = 'c'
         AND conrelid = to_regclass(quote_ident($1) || '.work_queue') ORDER BY conname`,
      [s],
    );
    expect(constraints).toEqual([
      { name: "work_queue_key_length_check", def: "CHECK ((length(key) <= 512))" },
      { name: "work_queue_key_source_check", def: "CHECK ((key ~~ (source || ':%'::text)))" },
    ]);
    const [index] = await sql.unsafe<{ def: string }>(
      "SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND indexname = 'work_queue_due_idx'",
      [s],
    );
    expect(index?.def).toBe(
      `CREATE INDEX work_queue_due_idx ON ${s}.work_queue USING btree (source, not_before) WHERE (dead_at IS NULL)`,
    );
  });

  test("a run that stopped between the second and third new files applies only the third on re-run", async () => {
    const slice = migrateSlice({ schema: schema() });
    await applyMigrationList(main.transactor, slice, SHIPPED.slice(0, 3));
    const rerun = await applyRootstockMigrations(main.transactor, slice);
    expect(rerun.applied).toEqual([...STAGE_C.slice(2), ...STAGE_D]);
    expect((await rootstockMigrationStatus(sql, slice)).red).toBe(false);
  });

  test("a schema at the 0.5.x state upgrades with the Stage C and Stage D files", async () => {
    const s = schema();
    const slice = migrateSlice({ schema: s });
    await applyMigrationList(main.transactor, slice, SHIPPED.slice(0, 1));
    const status = await rootstockMigrationStatus(sql, slice);
    expect(status.pending.map((m) => m.filename)).toEqual([...STAGE_C, ...STAGE_D]);
    const upgrade = await applyRootstockMigrations(main.transactor, slice);
    expect(upgrade.applied).toEqual([...STAGE_C, ...STAGE_D]);
    expect(await applied(s)).toEqual(SHIPPED.map((m) => m.filename));
  });

  test("two rootstock schemas get two independent table sets", async () => {
    const a = schema();
    const b = schema();
    await applyRootstockMigrations(main.transactor, migrateSlice({ schema: a }));
    await applyRootstockMigrations(main.transactor, migrateSlice({ schema: b }));
    await sql.unsafe(
      `INSERT INTO "${a}".run_locks (name, holder) VALUES ('alpha-sync', gen_random_uuid())`,
    );
    const [inB] = await sql.unsafe<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${b}".run_locks`,
    );
    expect(inB?.n).toBe(0);
    expect(await columns(b)).toEqual(SHAPE);
  });
});

describe("the Stage D tables (R-D1)", () => {
  test("a schema at the 0.7.0 state upgrades with the three files, and its queue rows read version 0 and no token", async () => {
    const s = schema();
    const slice = migrateSlice({ schema: s });
    await applyMigrationList(main.transactor, slice, SHIPPED.slice(0, 4));
    await sql.unsafe(
      `INSERT INTO "${s}".work_queue (key, source, kind) VALUES ('alpha:1', 'alpha', 'put')`,
    );
    const status = await rootstockMigrationStatus(sql, slice);
    expect(status.pending.map((m) => m.filename)).toEqual(STAGE_D);
    const upgrade = await applyRootstockMigrations(main.transactor, slice);
    expect(upgrade.applied).toEqual(STAGE_D);
    expect((await rootstockMigrationStatus(sql, slice)).red).toBe(false);
    const [row] = await sql.unsafe<{ version: string; token: string | null }>(
      `SELECT version::text AS version, claim_token::text AS token FROM "${s}".work_queue`,
    );
    expect(row).toEqual({ version: "0", token: null });
  });

  test("runs and quarantine: columns, checks and indexes equal the contract", async () => {
    const s = schema();
    await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
    const cols = await sql.unsafe<{
      t: string;
      c: string;
      type: string;
      n: string;
      d: string | null;
    }>(
      `SELECT table_name AS t, column_name AS c, data_type AS type, is_nullable AS n, column_default AS d
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name IN ('runs', 'quarantine')
       ORDER BY table_name, ordinal_position`,
      [s],
    );
    expect(cols.map((r) => `${r.t}.${r.c} ${r.type} ${r.n} ${r.d ?? "-"}`)).toEqual([
      "quarantine.id uuid NO gen_random_uuid()",
      "quarantine.job text NO -",
      "quarantine.external_id text NO -",
      "quarantine.payload jsonb NO -",
      "quarantine.reason text NO -",
      "quarantine.status text NO 'pending'::text",
      `quarantine.failed_at ${TS} NO now()`,
      `quarantine.resolved_at ${TS} YES -`,
      "quarantine.run_id uuid YES -",
      "runs.id uuid NO -",
      "runs.job text NO -",
      "runs.mode text NO -",
      "runs.status text NO -",
      "runs.phase text YES -",
      "runs.lock_name text NO -",
      "runs.holder uuid NO -",
      `runs.started_at ${TS} NO now()`,
      `runs.finished_at ${TS} YES -`,
      "runs.listed integer YES -",
      "runs.written integer YES -",
      "runs.unchanged integer YES -",
      "runs.quarantined integer YES -",
      "runs.excluded_count integer YES -",
      "runs.reconciled boolean YES -",
      "runs.excluded_reasons jsonb NO '{}'::jsonb",
      "runs.counts jsonb NO '{}'::jsonb",
      "runs.tokens jsonb NO '{}'::jsonb",
      "runs.cost_usd numeric YES -",
      "runs.cost_note text YES -",
      "runs.scope jsonb YES -",
      "runs.scope_excluded jsonb YES -",
      "runs.overrides jsonb NO '[]'::jsonb",
      "runs.reason text YES -",
    ]);
    const checks = await sql.unsafe<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
       WHERE connamespace = to_regnamespace($1::text) AND contype = 'c'
         AND conrelid IN (to_regclass(quote_ident($1) || '.runs'), to_regclass(quote_ident($1) || '.quarantine'))
       ORDER BY conname`,
      [s],
    );
    expect(checks.map((r) => r.name)).toEqual([
      "quarantine_status_check",
      "runs_settled_check",
      "runs_status_check",
    ]);
    const indexes = await sql.unsafe<{ name: string; def: string }>(
      `SELECT indexname AS name, indexdef AS def FROM pg_indexes
       WHERE schemaname = $1 AND tablename IN ('runs', 'quarantine') AND indexname NOT LIKE '%_pkey'
       ORDER BY indexname`,
      [s],
    );
    expect(indexes.map((r) => r.def)).toEqual([
      `CREATE UNIQUE INDEX quarantine_job_external_idx ON ${s}.quarantine USING btree (job, external_id)`,
      `CREATE INDEX quarantine_pending_idx ON ${s}.quarantine USING btree (job) WHERE (status = 'pending'::text)`,
      `CREATE INDEX runs_job_started_idx ON ${s}.runs USING btree (job, started_at DESC)`,
      `CREATE INDEX runs_running_idx ON ${s}.runs USING btree (lock_name) WHERE (status = 'running'::text)`,
    ]);
    // The settled check: a running row has no finish time, a settled one has one.
    const bad = await sql
      .unsafe(
        `INSERT INTO "${s}".runs (id, job, mode, status, lock_name, holder)
         VALUES (gen_random_uuid(), 'alpha-sync', 'manual', 'ok', 'alpha-sync', gen_random_uuid())`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(bad).not.toBeNull();
  });
});
