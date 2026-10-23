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
  /** The tracker's schema exists. */
  readonly schemaExists: boolean;
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

/** Everything kind-specific about a tracker's table, resolved once. */
interface Resolved {
  readonly tracker: Tracker;
  readonly schema: string;
  /** `schema.table`, for messages and events. */
  readonly name: string;
  /** The quoted `"schema"."table"`. */
  readonly sql: string;
  /** The expression a row's key is read from and compared with `SourceMigration.key`. */
  readonly keyExpr: string;
}

function resolve(tracker: Tracker, slice: MigrateSlice): Resolved {
  const { schema, table } = trackerTable(tracker, slice);
  return {
    tracker,
    schema,
    name: `${schema}.${table}`,
    sql: `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    // created_at is bigint: ::text keeps it exact and a string on every driver.
    keyExpr: tracker.kind === "drizzle" ? "created_at::text" : "filename",
  };
}

async function catalog(
  sql: Sql,
  t: Resolved,
): Promise<{ schemaExists: boolean; tracked: boolean; hashColumn: boolean }> {
  const [row] = await sql<{ schemaExists: boolean; tracked: boolean; sha256: boolean }>`
    select to_regnamespace(${t.schema}::text) is not null as "schemaExists",
           to_regclass(${t.sql}::text) is not null as "tracked",
           exists (select 1 from pg_attribute
                   where attrelid = to_regclass(${t.sql}::text)
                     and attname = 'sha256' and not attisdropped) as "sha256"`;
  if (row === undefined) fail("the tracker catalog query returned no row");
  return {
    schemaExists: row.schemaExists,
    tracked: row.tracked,
    hashColumn: t.tracker.kind === "filename" ? row.sha256 : true,
  };
}

/** The table's rows, or only those recorded under `key`. */
async function selectRows(
  sql: Sql,
  t: Resolved,
  hashColumn: boolean,
  key?: string,
): Promise<readonly TrackerRow[]> {
  const drizzle = t.tracker.kind === "drizzle";
  const rowId = drizzle ? "id::text" : "null::text";
  const hash = drizzle ? "hash" : hashColumn ? "sha256" : "null::text";
  const order = drizzle ? "id" : `filename collate "C"`;
  const where = key === undefined ? "" : ` where ${t.keyExpr} = $1`;
  const rows = await sql.unsafe<{ rowId: string | null; key: string | null; hash: string | null }>(
    `select ${rowId} as "rowId", ${t.keyExpr} as key, ${hash} as hash from ${t.sql}${where} order by ${order}`,
    key === undefined ? [] : [key],
  );
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({ rowId: r.rowId === null ? null : Number(r.rowId), key: r.key, hash: r.hash }),
    ),
  );
}

/** Every row of a source's tracker. Read-only; a missing table reads as untracked. */
export async function readTracker(
  sql: Sql,
  tracker: Tracker,
  slice: MigrateSlice,
): Promise<TrackerRead> {
  const t = resolve(tracker, slice);
  const found = await catalog(sql, t);
  const rows = found.tracked ? await selectRows(sql, t, found.hashColumn) : Object.freeze([]);
  return Object.freeze({ ...found, rows });
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
  const t = resolve(tracker, slice);
  const { tracked, hashColumn } = await catalog(tx, t);
  return tracked ? selectRows(tx, t, hashColumn, key) : Object.freeze([]);
}

/** Records `m` as applied, in the caller's transaction. */
export async function recordApplied(
  tx: TxSql,
  tracker: Tracker,
  slice: MigrateSlice,
  m: SourceMigration,
): Promise<void> {
  const { sql } = resolve(tracker, slice);
  await (tracker.kind === "drizzle"
    ? tx.unsafe(`INSERT INTO ${sql} (hash, created_at) VALUES ($1, $2::bigint)`, [m.sha256, m.key])
    : tx.unsafe(`INSERT INTO ${sql} (filename, sha256) VALUES ($1, $2)`, [m.key, m.sha256]));
}

/** drizzle-orm 0.45.3's own DDL, minus IF NOT EXISTS: the caller checked the catalog. */
function createDdl(t: Resolved): string {
  return t.tracker.kind === "drizzle"
    ? `CREATE TABLE ${t.sql} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
    : `CREATE TABLE ${t.sql} (filename text PRIMARY KEY, sha256 text ${HASH_CHECK}, applied_at timestamptz NOT NULL DEFAULT now())`;
}

/**
 * Refuses (E-MIG-TRACKER-SHAPE) unless the table is exactly a hash-less
 * filename tracker this role owns: `filename text` as the whole primary key and
 * `applied_at timestamptz`, nothing else. It is the one table rootstock alters
 * without having created it.
 */
async function assertUpgradable(tx: TxSql, t: Resolved): Promise<void> {
  const cols = await tx.unsafe<{ col: string; owner: boolean; user: string }>(
    `select a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod)
              || case when a.attnum = any(i.indkey::int2[]) then ' (primary key)' else '' end as col,
            pg_get_userbyid(c.relowner) = current_user as owner, current_user::text as "user"
       from pg_class c
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where c.oid = to_regclass($1::text)
      order by a.attnum`,
    [t.sql],
  );
  const found = cols.map((c) => c.col);
  const owner = cols[0]?.owner === true;
  const expected = ["applied_at timestamp with time zone", "filename text (primary key)"];
  if (owner && [...found].sort().join() === expected.join()) return;
  fail(
    `${t.name} is not a tracker rootstock can upgrade — found columns ${found.join(", ")}${owner ? "" : `, not owned by ${cols[0]?.user ?? "the current user"}`}; expected exactly filename text primary key and applied_at timestamptz`,
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
  const t = resolve(tracker, slice);
  const { schemaExists, tracked, hashColumn } = await catalog(tx, t);
  let created = false;
  let upgraded = false;
  if (!tracked) {
    if (!schemaExists) await tx.unsafe(`CREATE SCHEMA ${quoteIdentifier(t.schema)}`);
    await tx.unsafe(createDdl(t));
    created = true;
    emit({ type: "migrate.tracker_created", source: source.name, table: t.name });
  } else if (!hashColumn) {
    await assertUpgradable(tx, t);
    await tx.unsafe(`ALTER TABLE ${t.sql} ADD COLUMN sha256 text ${HASH_CHECK}`);
    upgraded = true;
    emit({ type: "migrate.tracker_upgraded", source: source.name, table: t.name });
  }
  const stamped: string[] = [];
  if (tracker.kind === "filename" && !created && source.migrations.length > 0) {
    // One statement whatever the count; a row already stamped is never
    // rewritten. The pairs travel as one JSON text, since not every transactor
    // binds arrays.
    const done = await tx.unsafe<{ key: string }>(
      `UPDATE ${t.sql} AS t SET sha256 = v.hash
         FROM json_to_recordset($1::json) AS v(key text, hash text)
        WHERE t.filename = v.key AND t.sha256 IS NULL
        RETURNING t.filename AS key`,
      [JSON.stringify(source.migrations.map((m) => ({ key: m.key, hash: m.sha256 })))],
    );
    const keys = new Set(done.map((r) => r.key));
    for (const m of source.migrations) {
      if (!keys.has(m.key)) continue;
      stamped.push(m.id);
      emit({ type: "migrate.hash_stamped", source: source.name, id: m.id });
    }
  }
  return Object.freeze({ created, upgraded, stamped: Object.freeze(stamped) });
}
