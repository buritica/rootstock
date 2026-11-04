import { quoteIdentifier, type Sql, type TxSql } from "../db/index.ts";
import { q } from "../internal/slice.ts";
import { fail } from "./errors.ts";
import { checkIdentifier } from "./identifier.ts";
import type { MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import { type TrackedSource, type Tracker, trackerTable } from "./tracked.ts";

// The SQL each tracker kind needs (contract §1.2). applyMigrations and
// migrationStatus (B-R3, B-R4) read and write app trackers only through here.
// Every function assumes the caller holds whatever lock its step needs; none
// of them takes one, and none emits an event: bootstrap reports what it did
// and the applier emits once the transaction has committed.

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
  /** The table exists and has its hash column (a filename tracker gains `sha256` on upgrade). */
  readonly hashColumn: boolean;
  /** drizzle by `id`, the other kinds by filename in byte order (C collation). */
  readonly rows: readonly TrackerRow[];
}

/** What bootstrap did, for the applier to report after commit. */
export interface TrackerBootstrap {
  /** `schema.table`. */
  readonly table: string;
  readonly created: boolean;
  readonly upgraded: boolean;
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
  readonly hashCol: "hash" | "sha256";
  /** The key's column and the type it must have. */
  readonly keyCol: { readonly name: "created_at" | "filename"; readonly type: "bigint" | "text" };
}

const KINDS: ReadonlySet<string> = new Set(["drizzle", "filename", "rootstock"]);

function identifier(what: string, value: unknown): void {
  try {
    checkIdentifier(what, value);
  } catch (err) {
    fail((err as Error).message.replace(/^rootstock: /, ""));
  }
}

/** Refuses a hand-built tracker the factories would not have returned. */
function resolve(tracker: Tracker, slice: MigrateSlice): Resolved {
  if (!KINDS.has((tracker as { kind?: unknown })?.kind as string)) {
    fail(
      `tracker kind must be "drizzle", "filename" or "rootstock" — got ${q((tracker as { kind?: unknown })?.kind)}`,
    );
  }
  if (tracker.kind !== "rootstock") {
    identifier("tracker schema", tracker.schema);
    identifier("tracker table", tracker.table);
  }
  const { schema, table } = trackerTable(tracker, slice);
  return {
    tracker,
    schema,
    name: `${schema}.${table}`,
    sql: `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    // created_at is bigint: ::text keeps it exact and a string on every driver.
    keyExpr: tracker.kind === "drizzle" ? "created_at::text" : "filename",
    hashCol: tracker.kind === "drizzle" ? "hash" : "sha256",
    keyCol:
      tracker.kind === "drizzle"
        ? { name: "created_at", type: "bigint" }
        : { name: "filename", type: "text" },
  };
}

function shapeRefusal(t: Resolved, found: string, expected: string): never {
  fail(
    `${t.name} is not a tracker rootstock can read — found ${found}; expected ${expected}`,
    "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
  );
}

/**
 * What the catalog says about a tracker. A relation that is not a plain table,
 * a key column that is missing or of another type (drizzle's `id` included),
 * or a hash column that is not text refuses (E-MIG-TRACKER-SHAPE) rather than
 * surfacing later as a driver error. `upgrading` leaves a hash-less filename
 * tracker's columns to the upgrade guard, which names all of them. Without USAGE on the tracker's schema the
 * driver's 42501 comes back, as in 0.3.0's status.
 */
async function catalog(
  sql: Sql,
  t: Resolved,
  upgrading = false,
): Promise<{ schemaExists: boolean; tracked: boolean; hashColumn: boolean }> {
  const [row] = await sql<{
    schemaExists: boolean;
    relkind: string | null;
    hashType: string | null;
    keyType: string | null;
    idType: string | null;
  }>`
    select to_regnamespace(${t.schema}::text) is not null as "schemaExists",
           (select relkind::text from pg_class where oid = to_regclass(${t.sql}::text)) as relkind,
           (select format_type(atttypid, atttypmod) from pg_attribute
             where attrelid = to_regclass(${t.sql}::text)
               and attname = ${t.hashCol}::text and not attisdropped) as "hashType",
           (select format_type(atttypid, atttypmod) from pg_attribute
             where attrelid = to_regclass(${t.sql}::text)
               and attname = ${t.keyCol.name}::text and not attisdropped) as "keyType",
           (select format_type(atttypid, atttypmod) from pg_attribute
             where attrelid = to_regclass(${t.sql}::text)
               and attname = 'id' and not attisdropped) as "idType"`;
  if (row === undefined)
    throw new Error("rootstock migrate: the tracker catalog query returned no row");
  const tracked = row.relkind !== null;
  if (tracked && row.relkind !== "r") {
    shapeRefusal(t, `a relation of kind ${q(row.relkind)}`, "a table");
  }
  const checkKey = tracked && !(upgrading && row.hashType === null);
  if (checkKey && row.keyType !== t.keyCol.type) {
    shapeRefusal(
      t,
      row.keyType === null
        ? `no column ${t.keyCol.name}`
        : `column ${t.keyCol.name} ${row.keyType}`,
      `${t.keyCol.name} ${t.keyCol.type}`,
    );
  }
  if (checkKey && t.tracker.kind === "drizzle" && row.idType !== "integer") {
    shapeRefusal(t, row.idType === null ? "no column id" : `column id ${row.idType}`, "id integer");
  }
  if (row.hashType !== null && row.hashType !== "text") {
    shapeRefusal(t, `column ${t.hashCol} ${row.hashType}`, `${t.hashCol} text`);
  }
  if (tracked && row.hashType === null && t.tracker.kind !== "filename") {
    shapeRefusal(t, `no column ${t.hashCol}`, `${t.hashCol} text`);
  }
  return { schemaExists: row.schemaExists, tracked, hashColumn: row.hashType !== null };
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
  const hash = hashColumn ? t.hashCol : "null::text";
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

/**
 * `schema.table` of a tracker, refusing one the factories would not have
 * returned. Two sources resolving to the same name share a table.
 */
export function trackerName(tracker: Tracker, slice: MigrateSlice): string {
  return resolve(tracker, slice).name;
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
 * `applied_at timestamptz` that an insert may omit (nullable, or with a
 * default, since rootstock's insert names only filename and sha256), nothing
 * else. It is the one table rootstock alters
 * without having created it.
 */
async function assertUpgradable(tx: TxSql, t: Resolved): Promise<void> {
  const [rel] = await tx.unsafe<{ owner: boolean; user: string; cols: string[] | null }>(
    `select pg_get_userbyid(c.relowner) = current_user as owner, current_user::text as "user",
            (select array_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod)
                              || case when a.attnum = any(i.indkey::int2[]) then ' (primary key)' else '' end
                              || case when a.attnotnull and not a.atthasdef and not a.attnum = any(i.indkey::int2[])
                                      then ' (not null, no default)' else '' end
                              order by a.attnum)
               from pg_attribute a
               left join pg_index i on i.indrelid = c.oid and i.indisprimary
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols
       from pg_class c where c.oid = to_regclass($1::text)`,
    [t.sql],
  );
  const found = rel?.cols ?? [];
  const owner = rel?.owner === true;
  const expected = ["applied_at timestamp with time zone", "filename text (primary key)"];
  if (owner && [...found].sort().join() === expected.join()) return;
  fail(
    `${t.name} is not a tracker rootstock can upgrade — found columns ${found.length > 0 ? found.join(", ") : "(none)"}${owner ? "" : `, not owned by ${rel?.user ?? "the current user"}`}; expected exactly filename text primary key and applied_at timestamptz`,
    "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
  );
}

/**
 * Makes a source's tracker ready to apply against, in the caller's bootstrap
 * transaction (contract §1.4 step 1): creates a missing table (and schema),
 * and adds `sha256` to a hash-less filename tracker behind the shape guard.
 * Stamping NULL hashes is `stampHashes`, a later step, so a run that is then
 * refused stamps nothing. It emits nothing: a later throw rolls the whole
 * transaction back, so the caller reports the result only after commit. rootstock's own tracker is left to
 * rootstock's first migration, as in 0.3.0. Running it again on a ready
 * tracker does nothing. Ownership is compared exactly (the contract's rule),
 * so a table owned by a role the current user merely belongs to is refused.
 */
export async function bootstrapTracker(
  tx: TxSql,
  source: TrackedSource,
  slice: MigrateSlice,
): Promise<TrackerBootstrap> {
  const { tracker } = source;
  const t = resolve(tracker, slice);
  if (tracker.kind === "rootstock") {
    return Object.freeze({
      table: t.name,
      created: false,
      upgraded: false,
    });
  }
  const { schemaExists, tracked, hashColumn } = await catalog(tx, t, true);
  let created = false;
  let upgraded = false;
  if (!tracked) {
    if (!schemaExists) await tx.unsafe(`CREATE SCHEMA ${quoteIdentifier(t.schema)}`);
    await tx.unsafe(createDdl(t));
    created = true;
  } else if (!hashColumn) {
    await assertUpgradable(tx, t);
    await tx.unsafe(`ALTER TABLE ${t.sql} ADD COLUMN sha256 text ${HASH_CHECK}`);
    upgraded = true;
  }
  return Object.freeze({ table: t.name, created, upgraded });
}

/**
 * Stamps each NULL hash of a filename tracker whose file is in `source` with
 * that file's hash, and returns the stamped ids (contract D42). The caller runs
 * it under the lock, only once the run is known not to be refused, so a refused
 * run (a stale checkout, say) never writes a hash. A row already stamped is
 * never rewritten. Other kinds store a hash with every row and return [].
 */
export async function stampHashes(
  tx: TxSql,
  source: TrackedSource,
  slice: MigrateSlice,
): Promise<readonly string[]> {
  if (source.tracker.kind !== "filename" || source.migrations.length === 0)
    return Object.freeze([]);
  const t = resolve(source.tracker, slice);
  // One statement whatever the count. The pairs travel as one text parameter
  // cast to json, since not every transactor binds arrays, and a json-typed
  // parameter is re-encoded by bun-sql and postgres-js into a JSON string scalar.
  const done = await tx.unsafe<{ key: string }>(
    `UPDATE ${t.sql} AS t SET sha256 = v.hash
       FROM json_to_recordset($1::text::json) AS v(key text, hash text)
      WHERE t.filename = v.key AND t.sha256 IS NULL
      RETURNING t.filename AS key`,
    [JSON.stringify(source.migrations.map((m) => ({ key: m.key, hash: m.sha256 })))],
  );
  const keys = new Set(done.map((r) => r.key));
  return Object.freeze(source.migrations.filter((m) => keys.has(m.key)).map((m) => m.id));
}
