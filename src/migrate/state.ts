import type { Sql } from "../db/index.ts";
import type { AcceptedHash, MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import type { TrackedSource } from "./tracked.ts";
import { readTracker, type TrackerRead, type TrackerRow } from "./tracker-db.ts";

/**
 * One source compared with its tracker (contract §1.3's vocabulary), pure:
 * the applier's plan and verify, and `migrationStatus`, read it the same way.
 */
export interface SourceState {
  readonly source: string;
  readonly tracked: boolean;
  /** Has the hash column and no NULL hash left. */
  readonly hashTracking: boolean;
  /** Ids with a row, in source order. */
  readonly applied: readonly string[];
  /** In the source, no row. Source order. */
  readonly pending: readonly SourceMigration[];
  /** Row keys with no file, as recorded. */
  readonly ahead: readonly string[];
  /** Row hash differs from the file's and no acceptance covers the pair. */
  readonly tampered: readonly {
    id: string;
    recorded: string;
    current: string;
    acceptedCurrent?: string;
  }[];
  /** Every slice acceptance naming this source, with whether it still matches. */
  readonly accepted: readonly {
    id: string;
    recorded: string;
    current: string;
    reason: string;
    stale: boolean;
  }[];
  /** drizzle rows whose created_at is NULL or not an integer. */
  readonly unknown: readonly { rowId: number; hash: string }[];
  /** Keys held by more than one row. */
  readonly duplicate: readonly string[];
  /** Pending ids that sort before the newest applied key. */
  readonly outOfOrder: readonly string[];
  /** Keys whose row has a NULL hash. */
  readonly unhashed: readonly string[];
}

// A journal `when` the reader accepts is any safe integer, negative included.
const DECIMAL = /^-?(0|[1-9][0-9]*)$/;

/**
 * The slice's acceptance naming this file, and whether it covers exactly the
 * pair (recorded, current). A file edited again after its acceptance is not
 * covered, so it reads as tampered.
 */
export function acceptanceOf(
  accepted: readonly AcceptedHash[],
  source: string,
  id: string,
  recorded: string,
  current: string,
): { entry: AcceptedHash | undefined; covers: boolean } {
  const entry = accepted.find((a) => a.source === source && a.id === id);
  return {
    entry,
    covers: entry !== undefined && entry.recorded === recorded && entry.current === current,
  };
}

/** Compares keys the way the tracker orders them: drizzle's as integers. */
function keyBefore(a: string, b: string, numeric: boolean): boolean {
  return numeric ? BigInt(a) < BigInt(b) : a < b;
}

export function sourceState(
  source: TrackedSource,
  read: TrackerRead,
  accepted: readonly AcceptedHash[],
): SourceState {
  const numeric = source.tracker.kind === "drizzle";
  const unknown: { rowId: number; hash: string }[] = [];
  const byKey = new Map<string, TrackerRow[]>();
  for (const row of read.rows) {
    if (row.key === null || (numeric && !DECIMAL.test(row.key))) {
      unknown.push({ rowId: row.rowId ?? -1, hash: row.hash ?? "" });
      continue;
    }
    const held = byKey.get(row.key);
    if (held === undefined) byKey.set(row.key, [row]);
    else held.push(row);
  }
  const duplicate = [...byKey].filter(([, rows]) => rows.length > 1).map(([key]) => key);
  const mine = accepted.filter((a) => a.source === source.name);
  const files = new Set(source.migrations.map((m) => m.key));

  const applied: string[] = [];
  const pending: SourceMigration[] = [];
  const tampered: SourceState["tampered"][number][] = [];
  const unhashed: string[] = [];
  let newest: string | undefined;
  for (const m of source.migrations) {
    const rows = byKey.get(m.key);
    if (rows === undefined) {
      pending.push(m);
      continue;
    }
    applied.push(m.id);
    if (newest === undefined || keyBefore(newest, m.key, numeric)) newest = m.key;
    for (const row of rows) {
      if (row.hash === null) continue;
      if (row.hash === m.sha256) continue;
      const entry = mine.find((a) => a.id === m.id);
      if (entry !== undefined && entry.recorded === row.hash && entry.current === m.sha256)
        continue;
      tampered.push(
        Object.freeze({
          id: m.id,
          recorded: row.hash,
          current: m.sha256,
          ...(entry === undefined ? {} : { acceptedCurrent: entry.current }),
        }),
      );
    }
  }
  for (const [key, rows] of byKey) {
    if (rows.some((r) => r.hash === null)) unhashed.push(key);
  }
  const ahead = [...byKey.keys()].filter((key) => !files.has(key));
  const outOfOrder =
    newest === undefined
      ? []
      : pending.filter((m) => keyBefore(m.key, newest as string, numeric)).map((m) => m.id);
  const acceptedState = mine.map((a) => {
    const m = source.migrations.find((x) => x.id === a.id);
    const rows = m === undefined ? undefined : byKey.get(m.key);
    // A row already holding today's hash needs no acceptance on this database
    // (a dev or preview database applied the edited file): not stale. The
    // acceptance is stale when the file is gone or back to `recorded`, or when
    // a row holds neither hash.
    const stale =
      m === undefined ||
      m.sha256 === a.recorded ||
      (rows !== undefined && !rows.every((r) => r.hash === a.recorded || r.hash === m.sha256));
    return Object.freeze({ ...a, stale });
  });
  return Object.freeze({
    source: source.name,
    tracked: read.tracked,
    hashTracking: read.hashColumn && unhashed.length === 0,
    applied: Object.freeze(applied),
    pending: Object.freeze(pending),
    ahead: Object.freeze(ahead),
    tampered: Object.freeze(tampered),
    accepted: Object.freeze(acceptedState.map(({ source: _s, ...rest }) => Object.freeze(rest))),
    unknown: Object.freeze(unknown.map((u) => Object.freeze(u))),
    duplicate: Object.freeze(duplicate),
    outOfOrder: Object.freeze(outOfOrder),
    unhashed: Object.freeze(unhashed),
  });
}

/** Every source's state, read unlocked, one tracker snapshot per source. */
export async function readStates(
  sql: Sql,
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
): Promise<SourceState[]> {
  // In source order, one at a time: the first failure is then always the same
  // source's, so a refusal (and the exit code a CLI derives from it) does not
  // depend on which query settled first.
  const states: SourceState[] = [];
  for (const s of sources) {
    states.push(sourceState(s, await readTracker(sql, s.tracker, slice), slice.accepted));
  }
  return states;
}

/** An acceptance whose pair no longer matches the row and the file. */
export function hasStale(s: SourceState): boolean {
  return s.accepted.some((a) => a.stale);
}
