import { quoteIdentifier, type Sql, type TxSql } from "../db/index.ts";
import { fail } from "./errors.ts";
import type { MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import { type TrackedSource, type Tracker, trackerTable } from "./tracked.ts";

// The SQL each tracker kind needs (contract §1.2). Status and apply read and
// write a tracker only through here. Every function assumes the caller holds
// whatever lock its step needs; none of them takes one.

/** One tracker row, read the same way on every driver. */
export interface TrackerRow {
  /** drizzle's `id`; null for the other kinds, whose key is the primary key. */
  readonly rowId: number | null;
  /** drizzle: `created_at::text`, null when NULL. Otherwise the filename. */
  readonly key: string | null;
  /** null while the row is unstamped, or when the table has no hash column yet. */
  readonly hash: string | null;
}

export interface TrackerRead {
  /** The tracker table exists. */
  readonly tracked: boolean;
  /** Always true for drizzle and rootstock; a filename tracker once it has `sha256`. */
  readonly hashColumn: boolean;
  /** drizzle by `id`, the other kinds by filename (code-unit order). */
  readonly rows: readonly TrackerRow[];
}

export type TrackerEvent =
  | { type: "migrate.tracker_created" | "migrate.tracker_upgraded"; source: string; table: string }
  | { type: "migrate.hash_stamped"; source: string; id: string };

export interface TrackerBootstrap {
  readonly created: boolean;
  readonly upgraded: boolean;
  /** Ids whose NULL hash was stamped. */
  readonly stamped: readonly string[];
}

const HASH_CHECK = "CHECK (sha256 ~ '^[0-9a-f]{64}$')";

function qualified(tracker: Tracker, slice: MigrateSlice): { name: string; sql: string } {
  const { schema, table } = trackerTable(tracker, slice);
  return {
    name: `${schema}.${table}`,
    sql: `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
  };
}

async function catalog(
  sql: Sql,
  tracker: Tracker,
  slice: MigrateSlice,
): Promise<{ schemaExists: boolean; tracked: boolean; hashColumn: boolean }> {
  const { schema } = trackerTable(tracker, slice);
  const [row] = await sql<{ schemaExists: boolean; tracked: boolean; sha256: boolean }>`
    select to_regnamespace(${schema}::text) is not null as "schemaExists",
           to_regclass(${qualified(tracker, slice).sql}::text) is not null as "tracked",
           exists (select 1 from pg_attribute
                   where attrelid = to_regclass(${qualified(tracker, slice).sql}::text)
                     and attname = 'sha256' and not attisdropped) as "sha256"`;
  if (row === undefined) fail("the tracker catalog query returned no row");
  return {
    schemaExists: row.schemaExists,
    tracked: row.tracked,
    hashColumn: tracker.kind === "filename" ? row.sha256 : true,
  };
}

function rowsQuery(tracker: Tracker, table: string, hashColumn: boolean, where = ""): string {
  if (tracker.kind === "drizzle") {
    // created_at is bigint: ::text keeps it exact and a string on every driver.
    return `select id::text as "rowId", created_at::text as key, hash from ${table}${where} order by id`;
  }
  const hash = hashColumn ? "sha256" : "null::text";
  return `select null::text as "rowId", filename as key, ${hash} as hash from ${table}${where} order by filename collate "C"`;
}

function toRow(r: { rowId: string | null; key: string | null; hash: string | null }): TrackerRow {
  return Object.freeze({
    rowId: r.rowId === null ? null : Number(r.rowId),
    key: r.key,
    hash: r.hash,
  });
}

/** Every row of a source's tracker. Read-only; a missing table reads as untracked. */
export async function readTracker(
  sql: Sql,
  tracker: Tracker,
  slice: MigrateSlice,
): Promise<TrackerRead> {
  const { tracked, hashColumn } = await catalog(sql, tracker, slice);
  const rows = tracked
    ? await sql.unsafe<{ rowId: string | null; key: string | null; hash: string | null }>(
        rowsQuery(tracker, qualified(tracker, slice).sql, hashColumn),
      )
    : [];
  return Object.freeze({ tracked, hashColumn, rows: Object.freeze(rows.map(toRow)) });
}

/**
 * The rows recorded under one key, for the per-file re-read under the lock. A
 * tracker table that does not exist yet reads as no row: rootstock's first
 * file creates its own table.
 */
export async function trackerRowsFor(
  tx: TxSql,
  tracker: Tracker,
  slice: MigrateSlice,
  key: string,
): Promise<readonly TrackerRow[]> {
  const { tracked, hashColumn } = await catalog(tx, tracker, slice);
  if (!tracked) return [];
  const where =
    tracker.kind === "drizzle" ? " where created_at::text = $1" : " where filename = $1";
  const rows = await tx.unsafe<{ rowId: string | null; key: string | null; hash: string | null }>(
    rowsQuery(tracker, qualified(tracker, slice).sql, hashColumn, where),
    [key],
  );
  return Object.freeze(rows.map(toRow));
}

/** Records `m` as applied, in the caller's transaction. */
export async function recordApplied(
  tx: TxSql,
  tracker: Tracker,
  slice: MigrateSlice,
  m: SourceMigration,
): Promise<void> {
  const table = qualified(tracker, slice).sql;
  await (tracker.kind === "drizzle"
    ? tx.unsafe(`INSERT INTO ${table} (hash, created_at) VALUES ($1, $2::bigint)`, [
        m.sha256,
        m.key,
      ])
    : tx.unsafe(`INSERT INTO ${table} (filename, sha256) VALUES ($1, $2)`, [m.key, m.sha256]));
}

/** drizzle-orm 0.45.3's own DDL, minus IF NOT EXISTS: the caller checked the catalog. */
function createDdl(tracker: Tracker, table: string): string {
  return tracker.kind === "drizzle"
    ? `CREATE TABLE ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
    : `CREATE TABLE ${table} (filename text PRIMARY KEY, sha256 text ${HASH_CHECK}, applied_at timestamptz NOT NULL DEFAULT now())`;
}

/**
 * Refuses (E-MIG-TRACKER-SHAPE) unless the table is exactly a hash-less
 * filename tracker this role owns: `filename text` as the whole primary key and
 * `applied_at timestamptz`, nothing else. It is the one table rootstock alters
 * without having created it.
 */
async function assertUpgradable(tx: TxSql, table: { name: string; sql: string }): Promise<void> {
  const cols = await tx.unsafe<{ name: string; type: string; pk: boolean }>(
    `select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
            coalesce(a.attnum = any(i.indkey::int2[]), false) as pk
       from pg_attribute a
       left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
      where a.attrelid = to_regclass($1::text) and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [table.sql],
  );
  const [who] = await tx.unsafe<{ owner: boolean; user: string }>(
    `select pg_get_userbyid(c.relowner) = current_user as owner, current_user::text as "user"
       from pg_class c where c.oid = to_regclass($1::text)`,
    [table.sql],
  );
  const shape = cols.map((c) => `${c.name} ${c.type}${c.pk ? " primary key" : ""}`).sort();
  const expected = ["applied_at timestamp with time zone", "filename text primary key"];
  const owner = who?.owner === true;
  if (owner && shape.length === 2 && shape.every((c, i) => c === expected[i])) return;
  const found = cols.map((c) => `${c.name} ${c.type}${c.pk ? " (primary key)" : ""}`).join(", ");
  fail(
    `${table.name} is not a tracker rootstock can upgrade — found columns ${found}${owner ? "" : `, not owned by ${who?.user ?? "the current user"}`}; expected exactly filename text primary key and applied_at timestamptz`,
    "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
  );
}

/**
 * Makes a source's tracker ready to apply against, in the caller's bootstrap
 * transaction (contract §1.4 step 1): creates a missing table (and schema),
 * adds `sha256` to a hash-less filename tracker behind the shape guard, and
 * stamps each NULL hash whose file is in `source` with that file's hash. One
 * event per action. rootstock's own tracker is left to rootstock's first
 * migration, as in 0.3.0. Running it again on a ready tracker does nothing.
 */
export async function bootstrapTracker(
  tx: TxSql,
  source: TrackedSource,
  slice: MigrateSlice,
  emit: (event: TrackerEvent) => void,
): Promise<TrackerBootstrap> {
  const { tracker } = source;
  if (tracker.kind === "rootstock") {
    return Object.freeze({ created: false, upgraded: false, stamped: Object.freeze([]) });
  }
  const table = qualified(tracker, slice);
  const { schemaExists, tracked, hashColumn } = await catalog(tx, tracker, slice);
  let created = false;
  let upgraded = false;
  if (!tracked) {
    if (!schemaExists) await tx.unsafe(`CREATE SCHEMA ${quoteIdentifier(tracker.schema)}`);
    await tx.unsafe(createDdl(tracker, table.sql));
    created = true;
    emit({ type: "migrate.tracker_created", source: source.name, table: table.name });
  } else if (!hashColumn) {
    await assertUpgradable(tx, table);
    await tx.unsafe(`ALTER TABLE ${table.sql} ADD COLUMN sha256 text ${HASH_CHECK}`);
    upgraded = true;
    emit({ type: "migrate.tracker_upgraded", source: source.name, table: table.name });
  }
  const stamped: string[] = [];
  if (tracker.kind === "filename" && !created) {
    const unstamped = await tx.unsafe<{ key: string }>(
      `select filename as key from ${table.sql} where sha256 is null`,
    );
    const keys = new Set(unstamped.map((r) => r.key));
    for (const m of source.migrations) {
      if (!keys.has(m.key)) continue;
      await tx.unsafe(
        `UPDATE ${table.sql} SET sha256 = $1 WHERE filename = $2 AND sha256 IS NULL`,
        [m.sha256, m.key],
      );
      stamped.push(m.id);
      emit({ type: "migrate.hash_stamped", source: source.name, id: m.id });
    }
  }
  return Object.freeze({ created, upgraded, stamped: Object.freeze(stamped) });
}
