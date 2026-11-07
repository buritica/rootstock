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
// its own.

const SHIPPED = rootstockMigrations();
const STAGE_C = SHIPPED.slice(1).map((m) => m.filename);

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
    expect(rerun.applied).toEqual(STAGE_C.slice(2));
    expect((await rootstockMigrationStatus(sql, slice)).red).toBe(false);
  });

  test("a schema at the previous release's state upgrades with the three files", async () => {
    const s = schema();
    const slice = migrateSlice({ schema: s });
    await applyMigrationList(main.transactor, slice, SHIPPED.slice(0, 1));
    const status = await rootstockMigrationStatus(sql, slice);
    expect(status.pending.map((m) => m.filename)).toEqual(STAGE_C);
    const upgrade = await applyRootstockMigrations(main.transactor, slice);
    expect(upgrade.applied).toEqual(STAGE_C);
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
