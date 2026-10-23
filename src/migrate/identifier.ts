/**
 * migrate's copy of `db`'s identifier rule, so the refusal can name `what`
 * ("migrateSlice: schema"): the import allowlist admits only `db`'s index,
 * which exports `quoteIdentifier` but not a rule that takes a name. A shared
 * table test holds the two copies to the same verdicts.
 */

import { q } from "../internal/slice.ts";

// ASCII-only, so the length is the byte count.
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_BYTES = 63;

/** Throws the identifier error, naming `what`, unless `value` is a safe identifier. */
export function checkIdentifier(what: string, value: unknown): string {
  if (typeof value === "string" && IDENTIFIER.test(value) && value.length <= MAX_IDENTIFIER_BYTES) {
    return value;
  }
  throw new Error(
    `rootstock: ${what} must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${q(value)}`,
  );
}
