/**
 * The slice of the `db` query surface this subpath calls, and the identifier
 * rule it splices schema names with. Structurally identical to `db`'s `Sql`,
 * `TxSql` and `Transactor`, so any transactor `db` builds is accepted here.
 */

export type Row = Record<string, unknown>;

export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]>;
  unsafe<T = Row>(query: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface TxSql<N = unknown> extends Sql {
  savepoint<T>(fn: (sp: TxSql<N>, native: N) => Promise<T>): Promise<T>;
}

export interface Transactor<N = unknown> {
  readonly id: "postgres-js" | "bun-sql" | "drizzle";
  readonly sql: Sql;
  begin<T>(fn: (tx: TxSql<N>, native: N) => Promise<T>): Promise<T>;
}

/**
 * `JSON.stringify(value)` for the `got …` part of a refusal, except that a
 * value it cannot serialize still yields text, as `db`'s refusals do.
 */
export function q(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "bigint" ? `${value}n` : "an unserializable value";
  }
}

// `db`'s identifier rule, copied so the refusal can name `what`; a shared
// table test holds the two copies to the same verdicts. ASCII-only, so the
// length is the byte count.
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

/** The double-quoted form of an identifier `checkIdentifier` accepted. */
export function quoted(identifier: string): string {
  return `"${checkIdentifier("identifier", identifier)}"`;
}
