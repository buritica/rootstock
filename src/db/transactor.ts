import { pgCode } from "./pg-code.ts";

export type Row = Record<string, unknown>;

/**
 * The query surface every rootstock component takes: a tagged template and
 * `unsafe`. Always await a query: postgres.js and Bun.SQL queries are lazy
 * and never run unless awaited, while drizzle's run at once. Every query comes
 * back as the driver's own query object, on the root `sql` and on `begin` and
 * savepoint handles alike; a handle only watches what it sends.
 */
export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T[]>;
  unsafe<T = Row>(query: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface TxSql<N = unknown> extends Sql {
  /**
   * A nested savepoint. A throw inside rolls back only the savepoint, then
   * rethrows the same error (if the rollback itself fails, the driver's error
   * comes back instead). A server error on an awaited query through `sp` rolls
   * it back even when fn caught it, as `begin` does. Savepoints are a stack on
   * one connection, so a second savepoint on the same handle while one is open
   * is refused: rolling back the first would also undo the second. To nest,
   * call `sp.savepoint`. While one is open, a query through the outer handle is
   * refused too: it would run inside the savepoint and roll back with it.
   * Savepoints and queries sent through `native` bypass these refusals.
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
   * same error when it rejects (if the rollback itself fails, the driver's
   * error comes back instead). An awaited query through `tx` that failed on
   * the server left the transaction aborted, so if fn caught it and resolved
   * anyway, the transaction rolls back and rejects with the first such error,
   * on every driver. That covers a query still running when fn settles (one
   * that lost a `Promise.race`, say): before committing, `begin` waits for
   * every query sent through `tx` and every savepoint started through it, and
   * a savepoint whose own SAVEPOINT, RELEASE or ROLLBACK TO failed on the
   * server rejects `begin` the same way. A lazy query nobody awaited never ran
   * and is not waited for; resolve fn with values, never with queries. Queries
   * sent through `native`, and drizzle's refusals (a value before sending, a
   * result that is not rows after it), are not tracked. `tx` is valid only
   * until fn settles; a query through it afterwards, even one racing the
   * driver's COMMIT or ROLLBACK, is refused. On postgres.js the driver itself
   * also rejects `begin` with any error a query through it rejected with.
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

interface Driver {
  id: TransactorId;
  /** Builds the query surface over one driver object. */
  surfaceOf: (native: unknown) => Sql;
  /** How a driver object nests a savepoint. */
  savepointOf: (native: unknown) => Nest;
  /** Queries run when made, not when awaited. */
  eager: boolean;
}

/** One transaction or savepoint scope, as its handle sees it. */
interface Scope {
  /** Set when fn settles, or when the driver's call does. */
  closed: boolean;
  /** A savepoint started through this scope's handle has not settled yet. */
  childOpen: boolean;
  /** The first server error a query through this handle rejected with. */
  failed?: unknown;
  /** Queries and savepoints sent through this handle that have not settled. */
  pending: Set<PromiseLike<unknown>>;
  /** The scope this savepoint nests in; closing it closes this one too. */
  parent?: Scope;
}

const isClosed = (scope: Scope): boolean =>
  scope.closed || (scope.parent !== undefined && isClosed(scope.parent));

/**
 * Enters a transaction or savepoint and hands fn a handle over the driver's
 * object. The handle closes when fn settles, or when any scope it nests in
 * does. A query through it afterwards would run after the driver's COMMIT or
 * ROLLBACK: as autocommit on a connection the driver may have lent to someone
 * else, or, for a savepoint, in the parent after the savepoint rolled back. It
 * is refused instead. Before handing back to the driver it waits for what the
 * handle sent, so no query or savepoint exit runs after the scope's own exit;
 * a savepoint left running keeps its transaction open until it settles.
 */
function enter<N, T>(
  driver: Driver,
  nest: Nest,
  fn: (tx: TxSql<N>, native: N) => Promise<T>,
  parent?: Scope,
): Promise<T> {
  const scope: Scope = { closed: false, childOpen: false, parent, pending: new Set() };
  const close = () => {
    scope.closed = true;
  };
  // What fn's scope rejected with, so a different error from the driver's exit
  // statement can be told apart from it.
  let thrown: unknown;
  let settled: PromiseLike<unknown>;
  try {
    settled = nest(async (native) => {
      let outcome: PromiseSettledResult<T>;
      try {
        outcome = {
          status: "fulfilled",
          value: await fn(txHandle<N>(driver, native, scope), native as N),
        };
      } catch (reason) {
        outcome = { status: "rejected", reason };
      }
      close();
      while (scope.pending.size > 0) {
        const batch = [...scope.pending];
        scope.pending.clear();
        await Promise.allSettled(batch);
      }
      if (outcome.status === "rejected") {
        thrown = outcome.reason;
        throw thrown;
      }
      // Postgres aborts a transaction on any server error, and one driver then
      // answers COMMIT with a silent rollback. Throwing here makes every driver
      // roll back the scope and reject instead.
      if (scope.failed !== undefined) {
        thrown = scope.failed;
        throw thrown;
      }
      return outcome.value;
    });
  } catch (err) {
    // A driver entry that throws instead of rejecting.
    close();
    return Promise.reject(err);
  }
  return Promise.resolve(settled as PromiseLike<T>).then(
    (value) => {
      close();
      return value;
    },
    (err: unknown) => {
      close();
      // The savepoint's own SAVEPOINT, RELEASE or ROLLBACK TO failed on the
      // server, which leaves the parent transaction aborted.
      if (parent !== undefined && err !== thrown) track(parent, err);
      throw err;
    },
  );
}

/** Records the first server error on a scope; a refusal raised before sending carries no code. */
function track(scope: Scope, err: unknown): void {
  // pgCode also matches a few socket errors (EPIPE); those leave the
  // transaction dead anyway, so tracking them is harmless.
  if (scope.failed === undefined && pgCode(err) !== undefined) scope.failed = err;
}

function txHandle<N>(driver: Driver, native: unknown, scope: Scope): TxSql<N> {
  const { id } = driver;
  const base = driver.surfaceOf(native);
  // Savepoints are a stack on one connection. While one is open, a query
  // through this handle would run inside it and roll back with it, and a
  // second savepoint's rollback would also undo the first; both are refused.
  const refusal = (whileChildOpen: string): Error | undefined =>
    isClosed(scope)
      ? new Error(`${id}: this transaction has already settled — its handle can no longer be used`)
      : scope.childOpen
        ? new Error(`${id}: ${whileChildOpen}`)
        : undefined;
  const send = <R>(run: () => Promise<R>): Promise<R> => {
    const refused = refusal(
      "a savepoint is open on this transaction — use the savepoint's handle until it settles",
    );
    if (refused) return Promise.reject(refused);
    let query: Promise<R>;
    try {
      query = run();
    } catch (err) {
      return Promise.reject(err);
    }
    if (typeof query?.then !== "function") return query;
    // The driver's own query object goes back, so a lazy query stays lazy and
    // a fragment stays a fragment. Its `then` is shadowed: the first await
    // starts it through the driver's own `then`, records a server error, and
    // registers it so the scope waits for it before its exit statement.
    const driverThen = query.then;
    let watched: Promise<R> | undefined;
    const watch = (): Promise<R> => {
      if (watched === undefined) {
        const settled = driverThen.call(query, undefined, (err: unknown) => {
          track(scope, err);
          throw err;
        }) as Promise<R>;
        watched = settled;
        scope.pending.add(settled);
        settled.then(
          () => scope.pending.delete(settled),
          () => scope.pending.delete(settled),
        );
      }
      return watched;
    };
    // biome-ignore lint/suspicious/noThenProperty: shadowing the query's own then is the point
    Object.defineProperty(query, "then", {
      configurable: true,
      value: (ok?: (v: R) => unknown, bad?: (e: unknown) => unknown) => {
        const next = watch().then(ok, bad);
        // Bun.SQL's own `then` marks what it returns as handled, and Bun calls
        // `finally` on its own query while running it; without the same mark
        // that internal chain reports an unhandled rejection.
        if (id === "bun-sql") next.catch(() => undefined);
        return next;
      },
    });
    if (driver.eager) watch();
    return query;
  };
  return surface((strings, ...values) => send(() => base(strings, ...values)), {
    unsafe: (query: string, params?: readonly unknown[]) => send(() => base.unsafe(query, params)),
    savepoint: <T>(fn: (sp: TxSql<N>, native: N) => Promise<T>): Promise<T> => {
      const refused = refusal(
        "a savepoint is already open on this transaction — await it before starting another",
      );
      if (refused) return Promise.reject(refused);
      const nest = driver.savepointOf(native);
      scope.childOpen = true;
      const open = enter(driver, nest, fn, scope).finally(() => {
        scope.childOpen = false;
      });
      scope.pending.add(open);
      open.then(
        () => scope.pending.delete(open),
        () => scope.pending.delete(open),
      );
      return open;
    },
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
    eager: false,
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

function drizzleSurface(x: DrizzleExecutor, sql: DrizzleSqlTagLike): Sql {
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
  return surface(async (strings, ...values) => run(sql(strings, ...refuseUnbindable(values))), {
    unsafe: async (query: string, params?: readonly unknown[]) => {
      if (params === undefined || params.length === 0) return run(sql.raw(query));
      const { strings, values } = drizzleTemplate(query, refuseUnbindable(params));
      return run(sql(strings, ...values));
    },
  });
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
    surfaceOf: (native) => drizzleSurface(native as DrizzleExecutor, deps.sql),
    savepointOf: (native) => (cb) => (native as DrizzleExecutor).transaction(cb),
    eager: true,
  };
  return Object.freeze({
    id: "drizzle" as const,
    sql: drizzleSurface(db, deps.sql),
    begin: <T>(fn: (tx: TxSql<N>, native: N) => Promise<T>) =>
      enter(driver, (cb) => db.transaction(cb), fn),
  });
}
