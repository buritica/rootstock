import type { Transactor } from "../db/index.ts";
import { runMigrations } from "./applier.ts";
import { type RootstockMigration, rootstockMigrations } from "./migrations.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import type { TrackedSource } from "./tracked.ts";

export interface ApplyReport {
  readonly schema: string;
  /** The bootstrap of this run created the schema. */
  readonly schemaCreated: boolean;
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
  /** Always empty since 0.5.0: a manual apply refuses a database that is ahead. */
  readonly ahead: readonly string[];
}

function asSource(list: readonly RootstockMigration[]): TrackedSource {
  return Object.freeze({
    name: "rootstock",
    tracker: Object.freeze({ kind: "rootstock" as const }),
    migrations: Object.freeze(
      list.map(
        (m): SourceMigration =>
          Object.freeze({
            source: "rootstock",
            id: m.filename,
            key: m.filename,
            sha256: m.sha256,
            kind: m.kind,
            baselined: false,
            statements: m.statements,
          }),
      ),
    ),
  });
}

/**
 * rootstock's own migrations as the first source of every run (contract
 * §1.1). Its tracker is `<slice.schema>.schema_migrations`.
 */
export function rootstockSource(slice: MigrateSlice): TrackedSource {
  assertMigrateSlice("rootstockSource", slice);
  return asSource(rootstockMigrations());
}

/**
 * Applies `list` as the rootstock source alone, with Stage A's texts. Each
 * file commits on its own since 0.5.0 (the bootstrap creates the schema
 * first), so a failure leaves earlier files applied and a re-run continues.
 */
export async function applyMigrationList(
  transactor: Transactor,
  slice: MigrateSlice,
  list: readonly RootstockMigration[],
  opts?: { allowHeavy?: boolean },
): Promise<ApplyReport> {
  assertMigrateSlice("applyRootstockMigrations", slice);
  const outcome = await runMigrations(
    transactor,
    slice,
    [asSource(list)],
    {
      entry: "manual",
      backup: { skip: "applyRootstockMigrations: caller's responsibility" },
      fix: "applyRootstockMigrations(transactor, slice, { allowHeavy: true })",
      ...(opts?.allowHeavy === true ? { allowHeavy: true } : {}),
    },
    true,
  );
  const planned = new Set(outcome.plan.apply.map((a) => a.id));
  return Object.freeze({
    schema: slice.schema,
    schemaCreated: outcome.schemaCreated,
    applied: Object.freeze(outcome.applied.map((a) => a.id)),
    alreadyApplied:
      list.filter((m) => !planned.has(m.filename)).length + outcome.skippedConcurrent.length,
    ahead: Object.freeze([]),
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
