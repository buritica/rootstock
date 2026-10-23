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
