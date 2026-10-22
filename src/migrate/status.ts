import { quoteIdentifier, type Sql } from "../db/index.ts";
import { type RootstockMigration, rootstockMigrations } from "./migrations.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";

export interface RootstockMigrationStatus {
  readonly schema: string;
  readonly schemaExists: boolean;
  /** <schema>.schema_migrations exists. */
  readonly tracked: boolean;
  /** Filenames, sorted. */
  readonly applied: readonly string[];
  /** Shipped and not applied, sorted by filename. */
  readonly pending: readonly RootstockMigration[];
  /** Applied and not shipped. */
  readonly ahead: readonly string[];
  readonly tampered: readonly { filename: string; recorded: string; shipped: string }[];
  /** pending, ahead (only when the slice refuses ahead) or tampered is non-empty. */
  readonly red: boolean;
}

/**
 * Compares what `sql` reports applied in the slice's schema with `list`. A
 * migration is pending when its filename is absent, never by comparison with
 * the newest applied name, so one that sorts before an applied one still runs.
 */
export async function statusOf(
  sql: Sql,
  slice: MigrateSlice,
  list: readonly RootstockMigration[],
): Promise<RootstockMigrationStatus> {
  const { schema } = slice;
  const table = `${quoteIdentifier(schema)}.schema_migrations`;
  const [found] = await sql<{ schemaExists: boolean; tracked: boolean }>`
    select to_regnamespace(${schema}::text) is not null as "schemaExists",
           to_regclass(${table}::text) is not null as "tracked"`;
  if (found === undefined) throw new Error("rootstock migrate: the catalog query returned no row");
  const { schemaExists, tracked } = found;
  const rows = tracked
    ? await sql.unsafe<{ filename: string; sha256: string }>(
        `select filename, sha256 from ${table} order by filename collate "C"`,
      )
    : [];
  const recorded = new Map(rows.map((r) => [r.filename, r.sha256]));
  const shipped = new Set(list.map((m) => m.filename));
  const pending: RootstockMigration[] = [];
  const tampered: RootstockMigrationStatus["tampered"][number][] = [];
  for (const m of [...list].sort((a, b) => (a.filename < b.filename ? -1 : 1))) {
    const sha = recorded.get(m.filename);
    if (sha === undefined) pending.push(m);
    else if (sha !== m.sha256) {
      tampered.push(Object.freeze({ filename: m.filename, recorded: sha, shipped: m.sha256 }));
    }
  }
  const ahead = rows.map((r) => r.filename).filter((f) => !shipped.has(f));
  return Object.freeze({
    schema,
    schemaExists,
    tracked,
    applied: Object.freeze(rows.map((r) => r.filename)),
    pending: Object.freeze(pending),
    ahead: Object.freeze(ahead),
    tampered: Object.freeze(tampered),
    red:
      pending.length > 0 || tampered.length > 0 || (ahead.length > 0 && slice.ahead === "refuse"),
  });
}

/**
 * Read-only, lock-free status of the shipped migrations in the slice's schema.
 * The role needs USAGE on that schema, or this rejects with the driver's 42501.
 */
export async function rootstockMigrationStatus(
  sql: Sql,
  slice: MigrateSlice,
): Promise<RootstockMigrationStatus> {
  assertMigrateSlice("rootstockMigrationStatus", slice);
  return statusOf(sql, slice, rootstockMigrations());
}
