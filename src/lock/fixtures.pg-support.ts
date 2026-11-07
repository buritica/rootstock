import { SQL } from "bun";
import postgres from "postgres";
import { bunSqlOptions, clientSlice, postgresJsOptions, type Sql } from "../db/index.ts";

/**
 * Lock-session fixtures for the lock DB suites. Under kind `bun-sql` the lock
 * session is a Bun.SQL `max: 1` client; under `postgres-js` and `drizzle` it is
 * a postgres.js `max: 1` client (contract §3). Every value is synthetic.
 */

export type LockDriver = "postgres-js" | "bun-sql";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set — run DB suites through \`bun run test:db\``);
  }
  return value;
}

export function testUrl(): string {
  return env("ROOTSTOCK_TEST_DATABASE_URL");
}

/** The transactor kind under test. */
export function testKind(): "postgres-js" | "bun-sql" | "drizzle" {
  const kind = env("ROOTSTOCK_TEST_TRANSACTOR");
  if (kind !== "postgres-js" && kind !== "bun-sql" && kind !== "drizzle") {
    throw new Error(`unknown ROOTSTOCK_TEST_TRANSACTOR ${JSON.stringify(kind)}`);
  }
  return kind;
}

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

export function openPostgresJsClient(max = 1): postgres.Sql {
  return postgres(testUrl(), {
    ...(postgresJsOptions(LOCK_CLIENT, "lock") as postgres.Options<Record<string, never>>),
    max,
    onnotice: () => {},
  });
}

export function openBunSqlClient(max = 1): SQL {
  return new SQL(testUrl(), { ...bunSqlOptions(LOCK_CLIENT, "lock"), max });
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
