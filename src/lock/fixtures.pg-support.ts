import { SQL } from "bun";
import postgres from "postgres";
import { bunSqlOptions, clientSlice, postgresJsOptions, type Sql } from "../db/index.ts";
import { required, testTransactorKind } from "../db/test-client.pg-support.ts";

/**
 * Lock-session fixtures for the lock DB suites. Under kind `bun-sql` the lock
 * session is a Bun.SQL `max: 1` client; under `postgres-js` and `drizzle` it is
 * a postgres.js `max: 1` client (contract §3). Every value is synthetic.
 */

export type LockDriver = "postgres-js" | "bun-sql";

export function testUrl(): string {
  return required("ROOTSTOCK_TEST_DATABASE_URL");
}

/** The transactor kind under test. */
export const testKind = testTransactorKind;

/** The driver the lock session uses under the kind under test. */
export function lockDriver(): LockDriver {
  return testKind() === "bun-sql" ? "bun-sql" : "postgres-js";
}

/** The lock profile every lock suite opens its session with. */
export const LOCK_CLIENT = clientSlice({
  profiles: {
    lock: {
      max: 1,
      maxCeiling: 1,
      idleTimeoutSeconds: "driver-default",
      maxLifetimeSeconds: "never",
      connectTimeoutSeconds: "driver-default",
      prepare: "driver-default",
      keepAliveSeconds: "driver-default",
      statementTimeoutMs: 0,
      readOnly: false,
    },
  },
});

export function openPostgresJsClient(max = 1, url = testUrl()): postgres.Sql {
  return postgres(url, {
    ...(postgresJsOptions(LOCK_CLIENT, "lock") as postgres.Options<Record<string, never>>),
    max,
    onnotice: () => {},
  });
}

export function openBunSqlClient(max = 1, url = testUrl()): SQL {
  return new SQL(url, { ...bunSqlOptions(LOCK_CLIENT, "lock"), max });
}

/** `Sql` over a raw driver client: the tagged template and `unsafe`, as rows. */
export function rawSql(client: postgres.Sql | SQL): Sql {
  const c = client as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): PromiseLike<unknown>;
    unsafe(q: string, p?: unknown[]): PromiseLike<unknown>;
  };
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await c(strings, ...values)) as unknown[]) as unknown as Sql;
  (tag as { unsafe: unknown }).unsafe = async (q: string, p?: readonly unknown[]) =>
    (await c.unsafe(q, p === undefined ? undefined : [...p])) as unknown[];
  return tag;
}

/**
 * Terminates a backend from `admin` with the frozen kill statement, then waits
 * until it is gone from pg_stat_activity, so the next query on the killed
 * session cannot still reach the dying backend.
 */
export async function killBackend(admin: Sql, pid: number): Promise<void> {
  await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await admin.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (rows.length === 0) return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} did not exit`);
    await Bun.sleep(10);
  }
}

/**
 * R10's origin: a byte-copy of the acquire statements a pre-rootstock lock
 * sends, as synthetic SQL. The fence names `run_locks` unqualified, so the
 * origin's session sets its search_path first.
 */
export const ORIGIN_L1 =
  "SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid";
export const ORIGIN_FENCE = `INSERT INTO run_locks (name, holder, acquired_at, heartbeat_at)
VALUES ($1, $2::uuid, now(), now())
ON CONFLICT (name) DO UPDATE SET holder = $2::uuid, acquired_at = now(), heartbeat_at = now()
RETURNING pg_backend_pid() AS pid`;

/** A raw `max` client of the lock driver under test, for side sessions. */
export function openRaw(max = 1): { sql: Sql; end: () => Promise<void> } {
  if (lockDriver() === "bun-sql") {
    const c = openBunSqlClient(max);
    return { sql: rawSql(c), end: () => c.close({ timeout: 1 }) };
  }
  const c = openPostgresJsClient(max);
  return { sql: rawSql(c), end: () => c.end({ timeout: 1 }) };
}

/** The test database's URL with another database name. */
export function otherDatabaseUrl(database: string): string {
  const u = new URL(testUrl());
  u.pathname = `/${database}`;
  return u.toString();
}
