import { sql } from "drizzle-orm";
import {
  bunSqlTransactor,
  drizzleTransactor,
  postgresJsTransactor,
  type Transactor,
} from "./index.ts";
import { openSecondClient, openTestClient, type TestClient } from "./test-client.pg-support.ts";

/**
 * The matrix's transactors: the O1 test clients, each behind the factory for
 * its kind. Every client is `max: 1`, so a transactor's queries share one
 * backend; `openSecond()` is an independent one. A test closes what it opens.
 */
export interface TestTransactor {
  transactor: Transactor;
  close: () => Promise<void>;
}

function wrap(c: TestClient): TestTransactor {
  switch (c.kind) {
    case "bun-sql":
      return { transactor: bunSqlTransactor(c.client), close: c.close };
    case "postgres-js":
      return { transactor: postgresJsTransactor(c.client), close: c.close };
    case "drizzle":
      return { transactor: drizzleTransactor(c.client, { sql }), close: c.close };
  }
}

export function openTestTransactor(): TestTransactor {
  return wrap(openTestClient());
}

export function openSecond(): TestTransactor {
  return wrap(openSecondClient());
}
