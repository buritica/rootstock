import { SQL } from "bun";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Raw driver clients for the DB suites (`*.pg.ts`), one per test-matrix
 * transactor kind. `scripts/test-db.ts` sets `ROOTSTOCK_TEST_DATABASE_URL` to a
 * throwaway Postgres and `ROOTSTOCK_TEST_TRANSACTOR` to the kind under test.
 * This module reaches only the drivers and the environment, never rootstock's
 * own exports, so it compiles before any `db` code exists.
 *
 * Every client is `max: 1` (except `openPooledClient`'s), so all of a
 * client's queries run on one backend and session state is observable. Each call opens an independent client; a
 * test closes everything it opens.
 */
export const TEST_TRANSACTOR_KINDS = ["bun-sql", "postgres-js", "drizzle"] as const;
export type TestTransactorKind = (typeof TEST_TRANSACTOR_KINDS)[number];

/** The driver a lock session runs on. */
export type LockDriver = Extract<TestTransactorKind, "postgres-js" | "bun-sql">;

/**
 * The lock session's driver under a transactor kind: `drizzle` sits on
 * postgres.js, so its lock session is a postgres.js client.
 */
export function lockDriverOf(kind: TestTransactorKind): LockDriver {
  return kind === "bun-sql" ? "bun-sql" : "postgres-js";
}

/**
 * Set to "1" by `scripts/test-db.ts --hypotheses`; turns the hypothesis
 * tests on (`hypothesis` in `lock/fixtures.pg-support.ts`).
 */
export const HYPOTHESES_ENV = "ROOTSTOCK_HYPOTHESES";

/**
 * Header lines a DB suite declares itself with, read by `scripts/test-db.ts`:
 * `driver-only` = its code under test talks to Postgres only through the lock
 * session's driver (the transactor only creates and drops its schema), so a
 * `drizzle` run would repeat `postgres-js` and is skipped; `hypotheses` = it
 * holds `hypothesis` tests.
 */
export const SUITE_MARKERS = {
  driverOnly: "// rootstock-test: driver-only",
  hypotheses: "// rootstock-test: hypotheses",
} as const;

export type TestClient =
  | { kind: "bun-sql"; client: SQL; close: () => Promise<void> }
  | { kind: "postgres-js"; client: postgres.Sql; close: () => Promise<void> }
  | {
      kind: "drizzle";
      client: PostgresJsDatabase & { $client: postgres.Sql };
      close: () => Promise<void>;
    };

/** An environment variable the DB suites need, or a throw naming how to run them. */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set — run DB suites through \`bun run test:db\``);
  }
  return value;
}

/** The transactor kind under test. */
export function testTransactorKind(): TestTransactorKind {
  const kind = required("ROOTSTOCK_TEST_TRANSACTOR");
  const known = TEST_TRANSACTOR_KINDS.find((k) => k === kind);
  if (known === undefined) {
    throw new Error(
      `ROOTSTOCK_TEST_TRANSACTOR must be one of ${TEST_TRANSACTOR_KINDS.join(", ")} — got ${JSON.stringify(kind)}`,
    );
  }
  return known;
}

function open(max = 1, url = required("ROOTSTOCK_TEST_DATABASE_URL")): TestClient {
  const kind = testTransactorKind();
  switch (kind) {
    case "bun-sql": {
      const client = new SQL({ url, max });
      return { kind, client, close: () => client.close() };
    }
    case "postgres-js": {
      const client = postgres(url, { max, onnotice: () => {} });
      return { kind, client, close: () => client.end() };
    }
    case "drizzle": {
      const client = drizzle(postgres(url, { max, onnotice: () => {} }));
      return { kind, client, close: () => client.$client.end() };
    }
  }
}

/**
 * A `max: 1` client of the kind under test on another database of the same
 * server, for a suite that makes its own throwaway database (its URL from
 * `testDatabaseUrlFor`).
 */
export function openTestClientAt(url: string): TestClient {
  return open(1, url);
}

/** `ROOTSTOCK_TEST_DATABASE_URL` with its database name replaced by `database`. */
export function testDatabaseUrlFor(database: string): string {
  const url = new URL(required("ROOTSTOCK_TEST_DATABASE_URL"));
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.href;
}

/** The client a suite's cases run on. */
export function openTestClient(): TestClient {
  return open();
}

/**
 * Another `max: 1` client, independent of every other. It is the same call as
 * `openTestClient()`, named for the cases that need a second backend.
 */
export function openSecondClient(): TestClient {
  return open();
}

/**
 * A client whose pool holds `max` backends, for the cases that must show a
 * guarantee holds when a transactor's transactions land on different backends.
 */
export function openPooledClient(max: number): TestClient {
  return open(max);
}
