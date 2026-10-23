import type { Sql } from "../db/index.ts";
import { rootstockSource } from "./apply.ts";
import type { RootstockMigration } from "./migrations.ts";
import { rootstockMigrations } from "./migrations.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import { type SourceState, sourceState } from "./state.ts";
import type { TrackedSource } from "./tracked.ts";
import { readTracker } from "./tracker-db.ts";
import { validateSources } from "./validate.ts";

/** One source compared with its tracker (contract §1.3). */
export type SourceStatus = SourceState;

export interface MigrationStatus {
  readonly sources: readonly SourceStatus[];
  /** Any pending file. */
  readonly behind: boolean;
  /** Any row with no file. */
  readonly ahead: boolean;
  /** Any changed file no acceptance covers. */
  readonly tampered: boolean;
  /** Any unknown or duplicate row, or any stale acceptance. */
  readonly trackerRot: boolean;
  /** behind || ahead || tampered || trackerRot. The drift check pages on it (D46/D48). */
  readonly red: boolean;
}

/**
 * Read-only, lock-free status of every source (contract §1.3): one snapshot
 * per source, so a concurrent apply can make two sources disagree in time.
 * Build `sources` once at boot; each call costs only the database reads. The
 * role needs USAGE on each tracker's schema, or this rejects with the
 * driver's 42501.
 */
export async function migrationStatus(
  sql: Sql,
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
): Promise<MigrationStatus> {
  assertMigrateSlice("migrationStatus", slice);
  validateSources("migrationStatus", slice, sources);
  const states: SourceStatus[] = [];
  for (const source of sources) {
    states.push(sourceState(source, await readTracker(sql, source.tracker, slice), slice.accepted));
  }
  const behind = states.some((s) => s.pending.length > 0);
  const ahead = states.some((s) => s.ahead.length > 0);
  const tampered = states.some((s) => s.tampered.length > 0);
  const trackerRot = states.some(
    (s) => s.unknown.length > 0 || s.duplicate.length > 0 || s.accepted.some((a) => a.stale),
  );
  return Object.freeze({
    sources: Object.freeze(states),
    behind,
    ahead,
    tampered,
    trackerRot,
    red: behind || ahead || tampered || trackerRot,
  });
}

const hex8 = (h: string): string => h.slice(0, 8);

function sourceLine(s: SourceStatus): string {
  const red: string[] = [];
  if (s.pending.length > 0) red.push(`behind: ${s.pending.map((m) => m.id).join(", ")}`);
  if (s.ahead.length > 0) red.push(`ahead: ${s.ahead.join(", ")}`);
  if (s.tampered.length > 0)
    red.push(
      `TAMPERED: ${s.tampered.map((t) => `${t.id} recorded ${hex8(t.recorded)} now ${hex8(t.current)}`).join(", ")}`,
    );
  if (s.unknown.length > 0) red.push(`unknown rows: ${s.unknown.map((u) => u.rowId).join(", ")}`);
  if (s.duplicate.length > 0) red.push(`duplicate keys: ${s.duplicate.join(", ")}`);
  const stale = s.accepted.some((a) => a.stale);
  const parts = red.length === 0 && !stale ? [`ok (${s.applied.length} applied)`] : red;
  if (s.accepted.length > 0)
    parts.push(
      `accepted: ${s.accepted.map((a) => `${a.id} (${a.reason})${a.stale ? " STALE" : ""}`).join(", ")}`,
    );
  if (s.outOfOrder.length > 0) parts.push(`out of order: ${s.outOfOrder.join(", ")}`);
  if (s.unhashed.length > 0) parts.push(`hashes not yet stamped: ${s.unhashed.length}`);
  return `${s.source}: ${parts.join("; ")}`;
}

/**
 * One line per source, then the remedy for each red condition that has one.
 * When the database is ahead, the remedy is a deploy, never the migrate
 * command (contract §6 Q4), so the two are separate lines.
 */
export function renderMigrationStatus(status: MigrationStatus, opts: { fix: string }): string {
  const lines = status.sources.map(sourceLine);
  if (status.behind) lines.push(`fix: ${opts.fix}`);
  if (status.ahead) {
    const ids = status.sources.flatMap((s) => s.ahead.map((id) => `${s.source}/${id}`));
    lines.push(
      `ahead: fix forward with a deploy that carries ${ids.join(", ")}; do not run the migrate command`,
    );
  }
  return `${lines.join("\n")}\n`;
}

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
  /** pending, ahead or tampered is non-empty (ahead always counts since 0.5.0). */
  readonly red: boolean;
}

/**
 * Read-only, lock-free status of the shipped migrations in the slice's schema,
 * in 0.3.0's shape, read through the same engine as `migrationStatus`. The
 * role needs USAGE on that schema, or this rejects with the driver's 42501.
 */
export async function rootstockMigrationStatus(
  sql: Sql,
  slice: MigrateSlice,
): Promise<RootstockMigrationStatus> {
  assertMigrateSlice("rootstockMigrationStatus", slice);
  const source = rootstockSource(slice);
  const read = await readTracker(sql, source.tracker, slice);
  const s = sourceState(source, read, slice.accepted);
  const shipped = new Map(rootstockMigrations().map((m) => [m.filename, m]));
  const pending = s.pending
    .map((m) => shipped.get(m.id))
    .filter((m): m is RootstockMigration => m !== undefined)
    .sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return Object.freeze({
    schema: slice.schema,
    schemaExists: read.schemaExists,
    tracked: read.tracked,
    applied: Object.freeze(read.rows.flatMap((r) => (r.key === null ? [] : [r.key]))),
    pending: Object.freeze(pending),
    ahead: s.ahead,
    tampered: Object.freeze(
      s.tampered.map((t) =>
        Object.freeze({ filename: t.id, recorded: t.recorded, shipped: t.current }),
      ),
    ),
    red: s.pending.length > 0 || s.tampered.length > 0 || s.ahead.length > 0,
  });
}
