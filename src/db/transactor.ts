export type Row = Record<string, unknown>;

/** The query surface every rootstock component takes: a tagged template and `unsafe`. */
export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]>;
  unsafe<T = Row>(query: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface TxSql<N = unknown> extends Sql {
  /** A nested savepoint. A throw inside rolls back only the savepoint, then rethrows the same error. */
  savepoint<T>(fn: (sp: TxSql<N>, native: N) => Promise<T>): Promise<T>;
}

export type TransactorId = "postgres-js" | "bun-sql" | "drizzle";

export interface Transactor<N = unknown> {
  readonly id: TransactorId;
  /** Autocommit queries on the root client. */
  readonly sql: Sql;
  /** One transaction. Commits when fn resolves; rolls back and rethrows the same error when it rejects. */
  begin<T>(fn: (tx: TxSql<N>, native: N) => Promise<T>): Promise<T>;
}

// The driver-like interfaces below are the minimal call surface rootstock
// uses. A driver's own generic call signatures are not assignable to a
// narrower interface under strictFunctionTypes, hence one `any` each,
// as the type parameter's default.

// biome-ignore lint/suspicious/noExplicitAny: structural driver surface
export interface PostgresJsClientLike<D = any> {
  (strings: TemplateStringsArray, ...values: D[]): PromiseLike<D>;
  unsafe(query: string, params?: D[]): PromiseLike<D>;
  begin(fn: (tx: D) => D): PromiseLike<D>;
}

// biome-ignore lint/suspicious/noExplicitAny: structural driver surface
export interface BunSqlClientLike<D = any> {
  (strings: TemplateStringsArray, ...values: D[]): PromiseLike<D>;
  unsafe(query: string, params?: D[]): PromiseLike<D>;
  begin(fn: (tx: D) => D): PromiseLike<D>;
}

// biome-ignore lint/suspicious/noExplicitAny: structural driver surface
export interface DrizzleDbLike<D = any> {
  execute(query: D): PromiseLike<D>;
  transaction(fn: (tx: D) => D): PromiseLike<D>;
}

// biome-ignore lint/suspicious/noExplicitAny: structural driver surface
export interface DrizzleSqlTagLike<D = any> {
  (strings: TemplateStringsArray, ...values: D[]): D;
  raw(query: string): D;
}

/** A tagged-template driver object: postgres.js and Bun.SQL clients, transactions and savepoints. */
interface TagDriver {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
  unsafe(query: string, params?: readonly unknown[]): PromiseLike<unknown>;
}

/** A driver's transaction or savepoint entry: `begin`, `savepoint` or drizzle's `transaction`. */
type Nest = (fn: (native: unknown) => unknown) => PromiseLike<unknown>;

/** Enters a transaction or savepoint, wrapping the driver's object once for fn. */
function enter<N, T>(
  nest: Nest,
  wrap: (native: unknown) => TxSql<N>,
  fn: (tx: TxSql<N>, native: N) => Promise<T>,
): Promise<T> {
  return nest((native) => fn(wrap(native), native as N)) as Promise<T>;
}

function surface<S extends object>(
  tag: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>,
  rest: S,
): Sql & S {
  return Object.freeze(Object.assign(tag, rest)) as unknown as Sql & S;
}

// The driver's own result promise is handed back unchanged: no copy, no extra await.
function tagSurface<S extends object>(x: TagDriver, rest: S): Sql & S {
  return surface((strings, ...values) => x(strings, ...values) as Promise<unknown>, {
    unsafe: (query: string, params?: readonly unknown[]) =>
      x.unsafe(query, params) as Promise<unknown>,
    ...rest,
  });
}

function tagTx<N>(native: unknown): TxSql<N> {
  const x = native as TagDriver & { savepoint: Nest };
  return tagSurface(x, {
    savepoint: <T>(fn: (sp: TxSql<N>, native: N) => Promise<T>) =>
      enter((cb) => x.savepoint(cb), tagTx<N>, fn),
  });
}

function tagTransactor<N>(
  id: Exclude<TransactorId, "drizzle">,
  client: TagDriver & { begin: Nest },
): Transactor<N> {
  return Object.freeze({
    id,
    sql: tagSurface(client, {}),
    begin: <T>(fn: (tx: TxSql<N>, native: N) => Promise<T>) =>
      enter((cb) => client.begin(cb), tagTx<N>, fn),
  });
}

/** A transactor over a postgres.js client. `native` is its `TransactionSql`. */
export function postgresJsTransactor<N = unknown>(client: PostgresJsClientLike): Transactor<N> {
  return tagTransactor<N>("postgres-js", client);
}

/** A transactor over a `Bun.SQL` client. `native` is Bun's transaction object. */
export function bunSqlTransactor<N = unknown>(client: BunSqlClientLike): Transactor<N> {
  return tagTransactor<N>("bun-sql", client);
}

interface DrizzleExecutor {
  execute(query: unknown): PromiseLike<unknown>;
  transaction: Nest;
}

const PLACEHOLDER = /\$([1-9][0-9]*)/;

/** Rewrites `unsafe(query, params)` as the pieces and values of one tagged-template call. */
function drizzleTemplate(
  query: string,
  params: readonly unknown[],
): { strings: TemplateStringsArray; values: unknown[] } {
  // split with a capture group alternates text and placeholder numbers.
  const parts = query.split(PLACEHOLDER);
  const pieces: string[] = [];
  const values: unknown[] = [];
  const referenced = new Set<number>();
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      pieces.push(part);
      return;
    }
    const n = Number(part);
    if (n > params.length) {
      throw new Error(
        `drizzleTransactor: unsafe() query references $${n} but ${params.length} parameter(s) were passed`,
      );
    }
    referenced.add(n);
    values.push(params[n - 1]);
  });
  for (let n = 1; n <= params.length; n += 1) {
    if (!referenced.has(n)) {
      throw new Error(
        `drizzleTransactor: unsafe() parameter ${n} is never referenced in the query`,
      );
    }
  }
  const strings = Object.freeze(
    Object.assign([...pieces], { raw: Object.freeze([...pieces]) }),
  ) as unknown as TemplateStringsArray;
  return { strings, values };
}

function drizzleSurface<S extends object>(
  x: DrizzleExecutor,
  deps: { sql: DrizzleSqlTagLike },
  rest: S,
): Sql & S {
  const run = async (query: unknown): Promise<unknown> => {
    const result = await x.execute(query);
    if (!Array.isArray(result)) {
      const kind =
        typeof result === "object" && result !== null ? "an object without rows" : typeof result;
      throw new Error(
        `drizzleTransactor: execute() returned ${kind}, not an array of rows — only drivers whose execute() resolves to a row array are supported`,
      );
    }
    return result;
  };
  return surface((strings, ...values) => run(deps.sql(strings, ...values)), {
    unsafe: async (query: string, params?: readonly unknown[]) => {
      if (params === undefined || params.length === 0) return run(deps.sql.raw(query));
      const { strings, values } = drizzleTemplate(query, params);
      return run(deps.sql(strings, ...values));
    },
    ...rest,
  });
}

function drizzleTx<N>(native: unknown, deps: { sql: DrizzleSqlTagLike }): TxSql<N> {
  const x = native as DrizzleExecutor;
  return drizzleSurface(x, deps, {
    savepoint: <T>(fn: (sp: TxSql<N>, native: N) => Promise<T>) =>
      enter(
        (cb) => x.transaction(cb),
        (sp) => drizzleTx<N>(sp, deps),
        fn,
      ),
  });
}

/**
 * A transactor over a drizzle database. `deps.sql` is the consumer's own `sql`
 * tag, so rootstock never imports drizzle. `native` is drizzle's transaction;
 * a savepoint is its nested `transaction`. Every `execute` result must be a row
 * array, which holds for drizzle over postgres.js. `unsafe` rewrites every
 * `$n` in the text, including inside a quoted literal or comment, so its query
 * text must use `$` only as placeholders.
 */
export function drizzleTransactor<N = unknown>(
  db: DrizzleDbLike,
  deps: { sql: DrizzleSqlTagLike },
): Transactor<N> {
  return Object.freeze({
    id: "drizzle" as const,
    sql: drizzleSurface(db, deps, {}),
    begin: <T>(fn: (tx: TxSql<N>, native: N) => Promise<T>) =>
      enter(
        (cb) => db.transaction(cb),
        (tx) => drizzleTx<N>(tx, deps),
        fn,
      ),
  });
}
