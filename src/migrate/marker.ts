import { q } from "./identifier.ts";

export type MigrationKind = "additive" | "heavy";

/** Only the header counts, so a marker quoted inside a statement does not. */
export const MARKER_WINDOW_LINES = 40;
const PREFIX = /^[a-z][a-z0-9-]*$/;

/** The `-- <prefix>-migration: additive|heavy` pattern; refuses a prefix that is not [a-z][a-z0-9-]*. */
export function markerPattern(prefix: string): RegExp {
  if (!PREFIX.test(prefix)) {
    throw new Error(
      `rootstock migrate: marker prefix must match [a-z][a-z0-9-]* — got ${q(prefix)}`,
    );
  }
  return new RegExp(`^--\\s*${prefix}-migration:\\s*(additive|heavy)\\s*$`, "m");
}

/** The marker `pattern` finds in the first 40 lines of `text`, or null. */
export function matchMarker(text: string, pattern: RegExp): MigrationKind | null {
  const head = text.split("\n", MARKER_WINDOW_LINES).join("\n");
  return (pattern.exec(head)?.[1] as MigrationKind | undefined) ?? null;
}
