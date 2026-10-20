const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// Postgres truncates a longer identifier with only a NOTICE. The rule is
// ASCII-only, so characters are bytes.
const MAX_IDENTIFIER_BYTES = 63;

/** Validates (E-ID, `what` = "identifier") and returns the double-quoted identifier. */
export function quoteIdentifier(name: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `rootstock: identifier must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${JSON.stringify(name)}`,
    );
  }
  return `"${name}"`;
}
