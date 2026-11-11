import type { Row, Sql } from "../db/index.ts";
import { assertLockSlice, type LockSlice } from "./slice.ts";

/**
 * The surface both drivers' clients share, as the lock uses it. A driver's
 * own generic call signatures are not assignable to a narrower interface
 * under strictFunctionTypes, hence one `any`, as the type parameter's default.
 */
// biome-ignore lint/suspicious/noExplicitAny: structural driver surface
interface TaggedClient<D = any> {
  (strings: TemplateStringsArray, ...values: D[]): PromiseLike<D>;
  unsafe(query: string, params?: D[]): PromiseLike<D>;
}

export interface PostgresJsLockClient extends TaggedClient {
  end(opts?: { timeout?: number }): Promise<void>;
}

export interface BunSqlLockClient extends TaggedClient {
  close(opts?: { timeout?: number }): Promise<void>;
}

export interface LockSession {
  /** One backend. After a severed socket, the next query opens a fresh one. */
  readonly sql: Sql;
  /** Ends the client, bounded by the slice's endTimeoutSeconds. Rejects with the driver's error; the lock catches it. */
  close(): Promise<void>;
  /**
   * Ends the client at once, without waiting for in-flight statements.
   * Optional; absent → close(). Shares close()'s once-only guard: a session
   * closed or destroyed once does neither again.
   */
  destroy?(): Promise<void>;
}

function surface(client: TaggedClient): Sql {
  const sql = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    (await client(strings, ...values)) as Row[]) as Sql;
  (sql as { unsafe: Sql["unsafe"] }).unsafe = (async (query: string, params?: readonly unknown[]) =>
    (await client.unsafe(
      query,
      params === undefined ? undefined : [...params],
    )) as Row[]) as Sql["unsafe"];
  return sql;
}

function session(
  client: TaggedClient,
  end: (timeoutSeconds: number) => Promise<void>,
  slice: LockSlice,
): LockSession {
  let closed = false;
  const once = (timeoutSeconds: number): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return end(timeoutSeconds);
  };
  return Object.freeze({
    sql: surface(client),
    close: () => once(slice.endTimeoutSeconds),
    destroy: () => once(0),
  });
}

/**
 * A lock session over a postgres.js client the consumer opened from its lock
 * profile (a dedicated `max: 1` client, never a pool reservation). Opens no
 * connection itself. `close()` is `end({ timeout: endTimeoutSeconds })`,
 * `destroy()` is `end({ timeout: 0 })`.
 */
export function postgresJsLockSession(client: PostgresJsLockClient, slice: LockSlice): LockSession {
  assertLockSlice("postgresJsLockSession", slice);
  return session(client, (timeout) => client.end({ timeout }), slice);
}

/**
 * A lock session over a Bun.SQL client the consumer opened from its lock
 * profile (a dedicated `max: 1` client, never a pool reservation). Opens no
 * connection itself. `close()` is `close({ timeout: endTimeoutSeconds })`,
 * `destroy()` is `close({ timeout: 0 })`.
 */
export function bunSqlLockSession(client: BunSqlLockClient, slice: LockSlice): LockSession {
  assertLockSlice("bunSqlLockSession", slice);
  return session(client, (timeout) => client.close({ timeout }), slice);
}
