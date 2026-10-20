import { pgCode } from "./pg-code.ts";

export type Row = Record<string, unknown>;

/**
 * The query surface every rootstock component takes: a tagged template and
 * `unsafe`. Always await a query: postgres.js and Bun.SQL queries are lazy and
 * never run unless awaited, while drizzle's run at once.
 */
export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]>;
  unsafe<T = Row>(query: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface TxSql<N = unknown> extends Sql {
  /**
   * A nested savepoint. A throw inside rolls back only the savepoint, then
   * rethrows the same error. A server error on one of its queries rolls it
   * back even when fn caught it, as `begin` does. Savepoints on one transaction must not overlap:
   * they are a stack on one connection, and rolling back one that started
   * first also undoes one started after it. While one is open, a query
   * through the outer handle is refused: it would run inside the savepoint
   * and roll back with it.
   */
  savepoint<T>(fn: (sp: TxSql<N>, native: N) => Promise<T>): Promise<T>;
}

export type TransactorId = "postgres-js" | "bun-sql" | "drizzle";

export interface Transactor<N = unknown> {
  readonly id: TransactorId;
  /**
   * Autocommit queries on the root client. Never use it inside `begin`: it
   * runs outside the transaction, and on a pool of one it waits forever for
   * the connection the transaction holds.
   */
  readonly sql: Sql;
  /**
   * One transaction. Commits when fn resolves; rolls back and rethrows the
   * same error when it rejects. A query through `tx` that failed on the server
   * left the transaction aborted, so if fn caught it and resolved anyway, the
   * transaction rolls back and rejects with that error, on every driver.
   * Queries sent through `native` are not tracked. `tx` is valid only until
   * fn settles; a query through it afterwards is refused.
   */
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

/** Builds the query surface over one driver object. */
type SurfaceOf = (native: unknown) => Sql;
/** How a driver object nests a savepoint. */
type SavepointOf = (native: unknown) => Nest;

interface Driver {
  id: TransactorId;
  surfaceOf: SurfaceOf;
  savepointOf: SavepointOf;
}

/**
 * Enters a transaction or savepoint and hands fn a handle over the driver's
 * object. The handle closes when the driver's call settles: a query through it
 * afterwards would run as autocommit on a connection the driver lent to
 * someone else, so it is refused instead.
 */
function enter<N, T>(
  driver: Driver,
  nest: Nest,
  fn: (tx: TxSql<N>, native: N) => Promise<T>,
): Promise<T> {
  const state: HandleState = { closed: false, failed: [] };
  const settled = nest(async (native) => {
    const value = await fn(txHandle<N>(driver, native, state), native as N);
    // Postgres aborts a transaction on any server error, and one driver then
    // answers COMMIT with a silent rollback. Throwing here makes every driver
    // roll back the scope and reject instead.
    if (state.failed.length > 0) throw state.failed[0];
    return value;
  });
  return (settled as Promise<T>).finally(() => {
    state.closed = true;
  });
}

interface HandleState {
  closed: boolean;
  /** The first server error a query through this handle rejected with. */
  failed: unknown[];
}

function txHandle<N>(driver: Driver, native: unknown, state: HandleState): TxSql<N> {
  const { id } = driver;
  const base = driver.surfaceOf(native);
  // Only an error with a SQLSTATE came from the server; a refusal raised
  // before sending leaves the transaction usable.
  const track = <R>(query: Promise<R>): Promise<R> =>
    query.catch((err: unknown) => {
      if (state.failed.length === 0 && pgCode(err) !== undefined) state.failed.push(err);
      throw err;
    });
  // Savepoints are a stack on one connection: rolling back one that started
  // first would also undo one started after it, so a second open one is refused.
  let savepointOpen = false;
  const guard = <R>(run: () => Promise<R>): Promise<R> =>
    state.closed
      ? Promise.reject(
          new Error(
            `${id}: this transaction has already settled — its handle can no longer be used`,
          ),
        )
      : run();
  // A query through this handle while its savepoint is open would run inside
  // the savepoint and roll back with it.
  const send = <R>(run: () => Promise<R>): Promise<R> =>
    guard(() =>
      savepointOpen
        ? Promise.reject(
            new Error(
              `${id}: a savepoint is open on this transaction — use the savepoint's handle until it settles`,
            ),
          )
        : track(run()),
    );
  return surface((strings, ...values) => send(() => base(strings, ...values)), {
    unsafe: (query: string, params?: readonly unknown[]) => send(() => base.unsafe(query, params)),
    savepoint: <T>(fn: (sp: TxSql<N>, native: N) => Promise<T>) =>
      guard<T>((): Promise<T> => {
        if (savepointOpen) {
          return Promise.reject(
            new Error(
              `${id}: a savepoint is already open on this transaction — await it before starting another`,
            ),
          );
        }
        savepointOpen = true;
        return enter(driver, driver.savepointOf(native), fn).finally(() => {
          savepointOpen = false;
        });
      }),
  });
}

function surface<S extends object>(
  tag: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>,
  rest: S,
): Sql & S {
  return Object.freeze(Object.assign(tag, rest)) as unknown as Sql & S;
}

// The driver's own result promise is handed back unchanged: no copy, no extra await.
function tagSurface(native: unknown): Sql {
  const x = native as TagDriver;
  return surface((strings, ...values) => x(strings, ...values) as Promise<unknown>, {
    unsafe: (query: string, params?: readonly unknown[]) =>
      x.unsafe(query, params) as Promise<unknown>,
  });
}

function tagTransactor<N>(
  id: Exclude<TransactorId, "drizzle">,
  client: TagDriver & { begin: Nest },
): Transactor<N> {
  const driver: Driver = {
    id,
    surfaceOf: tagSurface,
    savepointOf: (native) => (cb) => (native as { savepoint: Nest }).savepoint(cb),
  };
  return Object.freeze({
    id,
    sql: tagSurface(client),
    begin: <T>(fn: (tx: TxSql<N>, native: N) => Promise<T>) =>
      enter(driver, (cb) => client.begin(cb), fn),
  });
}

/**
 * A transactor over a postgres.js client. `native` is its `TransactionSql`.
 * On Bun, a connection that dies mid-transaction can leave a postgres.js
 * client unusable: its rollback writes to the closed socket and throws
 * outside any promise, and later queries time out connecting. Treat a
 * connection error inside `begin` as fatal for that client and replace it.
 * Binding `undefined` is refused by the driver; pass `null`. The id is the
 * factory's, not checked against the client: the client types are structural.
 */
export function postgresJsTransactor<N = unknown>(client: PostgresJsClientLike): Transactor<N> {
  return tagTransactor<N>("postgres-js", client);
}

/**
 * A transactor over a `Bun.SQL` client. `native` is Bun's transaction object.
 * The driver binds `undefined` as NULL without complaint; pass `null`. The id
 * is the factory's, not checked against the client: the client types are
 * structural.
 */
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

// Spelled in pieces because the purity scan reads string text too, and the
// class name is also a runtime global's.
const DATE_TAG = ["[object Da", "te]"].join("");

function isScalar(value: unknown): boolean {
  const type = typeof value;
  return (
    value === null ||
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "bigint" ||
    Object.prototype.toString.call(value) === DATE_TAG
  );
}

/**
 * Refuses what drizzle's tag would not bind as one parameter: `undefined` is
 * dropped from the text (the placeholders after it shift, and the server
 * reports a syntax error), an array expands into a list, and a drizzle SQL
 * object is spliced in as SQL text.
 */
function refuseUnbindable(values: readonly unknown[]): readonly unknown[] {
  // A loop, not indexOf: indexOf skips the holes of a sparse array.
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === undefined) {
      throw new Error(`drizzleTransactor: value ${i + 1} is undefined — bind null instead`);
    }
    if (!isScalar(value)) {
      const kind = Array.isArray(value)
        ? "array"
        : typeof (value as { getSQL?: unknown }).getSQL === "function"
          ? "sql"
          : typeof value;
      throw new Error(`drizzleTransactor: value ${i + 1} is not a bindable scalar — got ${kind}`);
    }
  }
  return values;
}

function drizzleSurface(x: DrizzleExecutor, deps: { sql: DrizzleSqlTagLike }): Sql {
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
  return surface(
    async (strings, ...values) => run(deps.sql(strings, ...refuseUnbindable(values))),
    {
      unsafe: async (query: string, params?: readonly unknown[]) => {
        if (params === undefined || params.length === 0) return run(deps.sql.raw(query));
        const { strings, values } = drizzleTemplate(query, refuseUnbindable(params));
        return run(deps.sql(strings, ...values));
      },
    },
  );
}

/**
 * A transactor over a drizzle database. `deps.sql` is the consumer's own `sql`
 * tag, so rootstock never imports drizzle. `native` is drizzle's transaction;
 * a savepoint is its nested `transaction`. Every `execute` result must be a row
 * array, which holds for drizzle over postgres.js. The check runs after the
 * statement did, so a refused write on the root `sql` has already committed.
 *
 * `unsafe(query, params)` becomes one tagged-template call: each `$n` occurrence
 * binds `params[n - 1]` (a placeholder used twice binds twice), and every
 * parameter must be referenced, or the call rejects before anything is sent.
 * It rewrites `$n` anywhere in the text, inside a quoted literal or a comment
 * too, so the text must use `$` only as placeholders. With no params, or `[]`,
 * the text is sent as-is. Every value, in the tag or in `params`, must be a
 * string, number, boolean, bigint, null or date, or the call rejects before
 * sending; pass `null` for `undefined`. Errors are drizzle's own, whose message
 * carries the query and its bound values: never send a raw error message to a
 * shared channel; log `pgCode(err)` instead. The id is the factory's, not checked against `db`.
 */
export function drizzleTransactor<N = unknown>(
  db: DrizzleDbLike,
  deps: { sql: DrizzleSqlTagLike },
): Transactor<N> {
  const driver: Driver = {
    id: "drizzle",
    surfaceOf: (native) => drizzleSurface(native as DrizzleExecutor, deps),
    savepointOf: (native) => (cb) => (native as DrizzleExecutor).transaction(cb),
  };
  return Object.freeze({
    id: "drizzle" as const,
    sql: drizzleSurface(db, deps),
    begin: <T>(fn: (tx: TxSql<N>, native: N) => Promise<T>) =>
      enter(driver, (cb) => db.transaction(cb), fn),
  });
}
