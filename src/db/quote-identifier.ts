import { q } from "../internal/slice.ts";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// Postgres truncates a longer identifier with only a NOTICE. The rule is
// ASCII-only, so characters are bytes.
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Returns the identifier double-quoted, for splicing into `unsafe` text. Throws
 * unless it matches `[a-z_][a-z0-9_]*` and is at most 63 bytes, so no quote,
 * case fold or truncation can change what it names.
 */
export function quoteIdentifier(name: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `rootstock: identifier must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${q(name)}`,
    );
  }
  return `"${name}"`;
}
