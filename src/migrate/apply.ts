import { quoted, type Transactor, type TxSql } from "./db-surface.ts";
import { type RootstockMigration, rootstockMigrations } from "./migrations.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import { statusOf } from "./status.ts";

export interface ApplyReport {
  readonly schema: string;
  readonly schemaCreated: boolean;
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
  /** Non-empty only under ahead: "allow". */
  readonly ahead: readonly string[];
}

/**
 * Refuses unless the transaction's role can use and create in the schema, or
 * can create the schema when it is missing. The privileges are checked before
 * anything touches the schema, because Postgres's own errors for a missing
 * privilege name the wrong thing.
 */
async function preflight(tx: TxSql, schema: string): Promise<{ exists: boolean }> {
  const [who] = await tx<{ user: string; exists: boolean; dbCreate: boolean }>`
    select current_user::text as "user",
           to_regnamespace(${schema}::text) is not null as "exists",
           has_database_privilege(current_database(), 'CREATE') as "dbCreate"`;
  if (who === undefined)
    throw new Error("applyRootstockMigrations: the preflight query returned no row");
  const { user } = who;
  if (!who.exists) {
    if (who.dbCreate) return { exists: false };
    throw new Error(
      `applyRootstockMigrations: schema "${schema}" does not exist and role ${JSON.stringify(user)} cannot create it (no CREATE on this database) — have a superuser or a member of that role run CREATE SCHEMA "${schema}" AUTHORIZATION "${user}", then re-run`,
    );
  }
  const [can] = await tx<{ usage: boolean; create: boolean }>`
    select has_schema_privilege(${schema}::text, 'USAGE') as "usage",
           has_schema_privilege(${schema}::text, 'CREATE') as "create"`;
  if (can === undefined)
    throw new Error("applyRootstockMigrations: the privilege query returned no row");
  const missing = [...(can.usage ? [] : ["USAGE"]), ...(can.create ? [] : ["CREATE"])];
  if (missing.length > 0) {
    throw new Error(
      `applyRootstockMigrations: role ${JSON.stringify(user)} lacks ${missing.join(" and ")} on schema "${schema}" — run GRANT ${missing.join(", ")} ON SCHEMA "${schema}" TO "${user}" as its owner, then re-run`,
    );
  }
  return { exists: true };
}

/**
 * Applies `list` to the slice's schema in one transaction, under a lock keyed
 * on the schema. Any throw rolls everything back, the schema's creation
 * included, so running it again is always the recovery.
 */
export async function applyMigrationList(
  transactor: Transactor,
  slice: MigrateSlice,
  list: readonly RootstockMigration[],
  opts?: { allowHeavy?: boolean },
): Promise<ApplyReport> {
  assertMigrateSlice("applyRootstockMigrations", slice);
  const { schema } = slice;
  return transactor.begin(async (tx) => {
    // Selected FROM the call so no driver has to decode a void column. The
    // lock serializes appliers only under READ COMMITTED: at a stricter
    // isolation the snapshot predates the wait, so a second concurrent apply
    // fails on CREATE TABLE (42P07) and a re-run then finds it applied.
    await tx`select 1::int as locked from pg_advisory_xact_lock(hashtext(${`rootstock-migrate:${schema}`}::text)::bigint)`;
    const { exists } = await preflight(tx, schema);
    if (!exists) await tx.unsafe(`CREATE SCHEMA ${quoted(schema)}`);
    const status = await statusOf(tx, slice, list);
    const [tamper] = status.tampered;
    if (tamper !== undefined) {
      throw new Error(
        `applyRootstockMigrations: ${schema}.schema_migrations records ${tamper.filename} with sha256 ${tamper.recorded}, but this package ships ${tamper.shipped} — an applied migration changed after it ran; refusing, and re-running will not fix this`,
      );
    }
    const pendingNames = status.pending.map((m) => m.filename);
    if (status.ahead.length > 0 && pendingNames.length > 0) {
      throw new Error(
        `applyRootstockMigrations: schema "${schema}" has applied ${status.ahead.join(", ")}, which this package does not ship, and is missing ${pendingNames.join(", ")} — the database and this package have diverged; refusing`,
      );
    }
    if (status.ahead.length > 0 && slice.ahead === "refuse") {
      throw new Error(
        `applyRootstockMigrations: schema "${schema}" has applied ${status.ahead.join(", ")}, which this package does not ship — the database is ahead of this rootstock version; upgrade rootstock, or set ahead: "allow" in the migrate slice`,
      );
    }
    const heavy = status.pending.filter((m) => m.kind === "heavy").map((m) => m.filename);
    if (heavy.length > 0 && opts?.allowHeavy !== true) {
      throw new Error(
        `applyRootstockMigrations: pending migration(s) marked heavy: ${heavy.join(", ")} — apply them deliberately with { allowHeavy: true }, then re-run`,
      );
    }
    if (status.pending.length > 0) {
      await tx.unsafe(`SET LOCAL search_path TO ${quoted(schema)}`);
      for (const m of status.pending) {
        for (const statement of m.statements) await tx.unsafe(statement);
        await tx.unsafe(
          `INSERT INTO ${quoted(schema)}.schema_migrations (filename, sha256) VALUES ($1, $2)`,
          [m.filename, m.sha256],
        );
      }
    }
    return Object.freeze({
      schema,
      schemaCreated: !exists,
      applied: Object.freeze(pendingNames),
      alreadyApplied: status.applied.length - status.ahead.length,
      ahead: Object.freeze([...status.ahead]),
    });
  });
}

/** Applies every shipped rootstock migration the slice's schema has not applied. */
export function applyRootstockMigrations(
  transactor: Transactor,
  slice: MigrateSlice,
  opts?: { allowHeavy?: boolean },
): Promise<ApplyReport> {
  return applyMigrationList(transactor, slice, rootstockMigrations(), opts);
}
