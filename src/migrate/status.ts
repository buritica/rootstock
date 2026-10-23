import type { Sql } from "../db/index.ts";
import { rootstockSource } from "./apply.ts";
import { type RootstockMigration, rootstockMigrations } from "./migrations.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import { hasStale, readStates, type SourceState, sourceState } from "./state.ts";
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
  return summarizeStatus(await readStates(sql, slice, sources));
}

/** The red flags of a set of source states (contract §1.3), pure. */
export function summarizeStatus(states: readonly SourceStatus[]): MigrationStatus {
  const behind = states.some((s) => s.pending.length > 0);
  const ahead = states.some((s) => s.ahead.length > 0);
  const tampered = states.some((s) => s.tampered.length > 0);
  const trackerRot = states.some(
    (s) => s.unknown.length > 0 || s.duplicate.length > 0 || hasStale(s),
  );
  return Object.freeze({
    sources: Object.freeze([...states]),
    behind,
    ahead,
    tampered,
    trackerRot,
    red: behind || ahead || tampered || trackerRot,
  });
}

const hex8 = (h: string): string => h.slice(0, 8);

function sourceLine(s: SourceStatus): string {
  const ok =
    s.pending.length +
      s.ahead.length +
      s.tampered.length +
      s.unknown.length +
      s.duplicate.length ===
      0 && !hasStale(s);
  // Contract §1.3's order.
  const parts = [
    ok ? `ok (${s.applied.length} applied)` : "",
    s.pending.length > 0 ? `behind: ${s.pending.map((m) => m.id).join(", ")}` : "",
    s.ahead.length > 0 ? `ahead: ${s.ahead.join(", ")}` : "",
    s.tampered.length > 0
      ? `TAMPERED: ${s.tampered.map((t) => `${t.id} recorded ${hex8(t.recorded)} now ${hex8(t.current)}`).join(", ")}`
      : "",
    s.accepted.length > 0
      ? `accepted: ${s.accepted.map((a) => `${a.id} (${a.reason})${a.stale ? " STALE" : ""}`).join(", ")}`
      : "",
    s.unknown.length > 0 ? `unknown rows: ${s.unknown.map((u) => u.rowId).join(", ")}` : "",
    s.duplicate.length > 0 ? `duplicate keys: ${s.duplicate.join(", ")}` : "",
    s.outOfOrder.length > 0 ? `out of order: ${s.outOfOrder.join(", ")}` : "",
    s.unhashed.length > 0 ? `hashes not yet stamped: ${s.unhashed.length}` : "",
  ];
  return `${s.source}: ${parts.filter((p) => p !== "").join("; ")}`;
}

/**
 * One line per source, then the remedy for each red condition that has one.
 * When the database is ahead, the remedy is a deploy, never the migrate
 * command (contract §6 Q4), so the two are separate lines.
 */
export function renderMigrationStatus(status: MigrationStatus, opts: { fix: string }): string {
  if (typeof opts?.fix !== "string" || opts.fix.trim() === "") {
    throw new Error(
      `renderMigrationStatus: opts.fix must be a non-empty command — got ${JSON.stringify(opts?.fix)}`,
    );
  }
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
  const ids = new Set(s.pending.map((m) => m.id));
  const pending = rootstockMigrations().filter((m) => ids.has(m.filename));
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
    // 0.3.0's rule plus ahead (D48). Unknown and duplicate rows cannot occur
    // under the filename primary key, and a stale acceptance never hides a
    // tamper, so migrationStatus's tracker-rot flag is left out on purpose.
    red: s.pending.length > 0 || s.tampered.length > 0 || s.ahead.length > 0,
  });
}
