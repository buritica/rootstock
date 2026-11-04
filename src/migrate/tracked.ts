import { own, sliceRefusals } from "../internal/slice.ts";
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
