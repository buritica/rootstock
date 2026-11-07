/**
 * `db`'s identifier rule with a refusal that names `what` ("migrateSlice:
 * schema"). The predicate is the shared one; a table test holds every user of
 * it to the same verdicts.
 */

import { isIdentifier, q } from "../internal/slice.ts";

/** Throws the identifier error, naming `what`, unless `value` is a safe identifier. */
export function checkIdentifier(what: string, value: unknown): string {
  if (isIdentifier(value)) return value;
  throw new Error(
    `rootstock: ${what} must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${q(value)}`,
  );
}
