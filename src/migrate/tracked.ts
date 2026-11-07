import { own, q, sliceRefusals } from "../internal/slice.ts";
import { fail } from "./errors.ts";
import { checkIdentifier } from "./identifier.ts";
import type { MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";

/** Where "what has run" lives for a source. Origin tables never move. */
export type Tracker =
  | { readonly kind: "drizzle"; readonly schema: string; readonly table: string }
  | { readonly kind: "filename"; readonly schema: string; readonly table: string }
  | { readonly kind: "rootstock" };

export interface TrackedSource {
  readonly name: string;
  /** One reader's output; every element's `source` is `name`. */
  readonly migrations: readonly SourceMigration[];
  readonly tracker: Tracker;
}

/** A drizzle key: a journal `when`, which the reader accepts as any safe integer, negative included. */
export const DRIZZLE_WHEN = /^-?(0|[1-9][0-9]*)$/;

/**
 * Where a migration sits in apply order, for the order check and status.
 *
 * - A drizzle source orders by its key, the journal's `when`, as an integer:
 *   the value drizzle's tracker records and compares. (The applier walks the
 *   journal, and `when` need not increase along it; see `drizzleJournal`.)
 * - Every other source orders by id, its filename: a filename tracker is
 *   paired with an sql folder (or rootstock's own files), which applies in
 *   filename order. A renamed file keeps its old name as its key, which is not
 *   where it applies.
 *
 * Refuses (ERR_ROOTSTOCK_MIG_SRC) to compare a drizzle key that is not an
 * integer, rather than throwing BigInt's bare SyntaxError.
 */
export function applyOrder(source: TrackedSource): {
  readonly of: (m: SourceMigration) => string;
  readonly compare: (a: string, b: string) => number;
} {
  if (source.tracker.kind === "drizzle") {
    const int = (key: string): bigint => {
      if (!DRIZZLE_WHEN.test(key)) {
        fail(`source ${q(source.name)}: key ${q(key)} is not a drizzle when`);
      }
      return BigInt(key);
    };
    return {
      of: (m) => m.key,
      compare: (a, b) => {
        const x = int(a);
        const y = int(b);
        return x < y ? -1 : x > y ? 1 : 0;
      },
    };
  }
  return { of: (m) => m.id, compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0) };
}

const TABLE_KEYS: ReadonlySet<string> = new Set(["schema", "table"]);

function tableOptions(
  fn: string,
  defaults: { schema: string; table: string },
  opts: unknown,
): { schema: string; table: string } {
  const refuse = sliceRefusals(fn);
  const given = opts === undefined ? {} : refuse.record("options", opts);
  refuse.refuseUnknownKeys(given, TABLE_KEYS, "options.");
  const pick = (key: "schema" | "table"): string => {
    const value = own(given, key);
    return value === undefined ? defaults[key] : checkIdentifier(`${fn}: options.${key}`, value);
  };
  return { schema: pick("schema"), table: pick("table") };
}

/** drizzle-kit's tracker: `drizzle.__drizzle_migrations` unless named otherwise. */
export function drizzleTracker(opts?: { schema?: string; table?: string }): Tracker {
  const where = tableOptions(
    "drizzleTracker",
    { schema: "drizzle", table: "__drizzle_migrations" },
    opts,
  );
  return Object.freeze({ kind: "drizzle", ...where });
}

/** A filename-keyed tracker: `public.schema_migrations` unless named otherwise. */
export function filenameTracker(opts?: { schema?: string; table?: string }): Tracker {
  const where = tableOptions(
    "filenameTracker",
    { schema: "public", table: "schema_migrations" },
    opts,
  );
  return Object.freeze({ kind: "filename", ...where });
}

/** The table a tracker names. rootstock's own lives in the slice's schema. */
export function trackerTable(
  tracker: Tracker,
  slice: MigrateSlice,
): { readonly schema: string; readonly table: string } {
  return tracker.kind === "rootstock"
    ? { schema: slice.schema, table: "schema_migrations" }
    : { schema: tracker.schema, table: tracker.table };
}
