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

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Throws the identifier error, naming `what`, unless `value` is a safe identifier. */
export function checkIdentifier(what: string, value: unknown): string {
  if (typeof value === "string" && IDENTIFIER.test(value) && value.length <= 63) return value;
  throw new Error(
    `rootstock: ${what} must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${JSON.stringify(value)}`,
  );
}

/** The double-quoted form of an identifier `checkIdentifier` accepted. */
export function quoted(identifier: string): string {
  return `"${checkIdentifier("identifier", identifier)}"`;
}
