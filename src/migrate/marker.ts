import { q } from "../internal/slice.ts";

export type MigrationKind = "additive" | "heavy";

/** Only these first lines are read, so a marker further down the file does not count. */
export const MARKER_WINDOW_LINES = 40;
/** The rule for a marker prefix and a source name. */
export const NAME_RULE = /^[a-z][a-z0-9-]*$/;
// Every line terminator a regex `m` flag honours, so no file shape widens the window.
const LINE_BREAK = /\r\n|\n|\r|\u2028|\u2029/;

/**
 * The pattern one header line must match, accepting any of `prefixes`; refuses
 * a prefix that is not [a-z][a-z0-9-]*.
 */
export function markerPattern(...prefixes: readonly string[]): RegExp {
  if (prefixes.length === 0) throw new Error("rootstock migrate: markerPattern needs a prefix");
  for (const prefix of prefixes) {
    if (!NAME_RULE.test(prefix)) {
      throw new Error(
        `rootstock migrate: marker prefix must match [a-z][a-z0-9-]* — got ${q(prefix)}`,
      );
    }
  }
  return new RegExp(`^--\\s*(?:${prefixes.join("|")})-migration:\\s*(additive|heavy)\\s*$`);
}

/**
 * The marker on a whole line within the first 40 lines of `text` (after a
 * leading byte-order mark), or null. When the header carries both kinds,
 * heavy wins: that is the direction that stops a deploy rather than runs it.
 */
export function matchMarker(text: string, pattern: RegExp): MigrationKind | null {
  let kind: MigrationKind | null = null;
  for (const line of text.replace(/^\uFEFF/, "").split(LINE_BREAK, MARKER_WINDOW_LINES)) {
    const found = pattern.exec(line)?.[1] as MigrationKind | undefined;
    if (found === "heavy") return "heavy";
    if (found !== undefined) kind = found;
  }
  return kind;
}
