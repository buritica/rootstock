import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import { lockDriver, openBunSqlClient, openPostgresJsClient } from "./fixtures.pg-support.ts";
import {
  acquireRunLock,
  createTurnQueue,
  type LockDeps,
  type LockEvent,
  type LockSession,
  type LockSlice,
  lockSlice,
  locksHeld,
  RootstockLockError,
} from "./index.ts";
import { bunSqlLockSession, postgresJsLockSession } from "./session.ts";
import { L1 } from "./statements.ts";

// R-C4 (contract §3.5): the poll wait against a real server, once per kind.

const POLL_MS = 50;

let main: TestTransactor;
let admin: TestTransactor;
let adminSql: Sql;
const { schema, dropAll } = schemaFactory("rs_lw");
let s: LockSlice;

beforeAll(async () => {
  main = openTestTransactor();
  admin = openSecond();
  adminSql = admin.transactor.sql;
  const fenced = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: fenced }));
  s = lockSlice({
    table: { schema: fenced },
    profile: "lock",
    names: ["alpha-sync"],
    heartbeatSeconds: 5,
    probeStallSeconds: 10,
    maxRecoveries: 1,
    endTimeoutSeconds: 1,
    wait: { maxMs: 5000, pollIntervalMs: POLL_MS },
  });
});

afterAll(async () => {
  await dropAll(main.transactor.sql);
  await admin.close();
  await main.close();
});

function open(): LockSession {
  return lockDriver() === "bun-sql"
    ? bunSqlLockSession(openBunSqlClient(), s)
    : postgresJsLockSession(openPostgresJsClient(), s);
}

function deps(events: LockEvent[] = []): LockDeps {
  return {
    now: () => Date.now(),
    setInterval: () => {
      throw new Error("no keepalive in these cases");
    },
    clearInterval: () => {},
    randomUUID: () => crypto.randomUUID(),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    onEvent: (e) => events.push(e),
  };
}

async function held(): Promise<boolean> {
  return (await locksHeld(adminSql, ["alpha-sync"])).get("alpha-sync") === true;
}

describe("poll wait against a real server", () => {
  test("W8: a waiter acquires within one pollIntervalMs of the holder's release", async () => {
    const holder = await acquireRunLock(open, s, "alpha-sync", deps());
    const events: LockEvent[] = [];
    const waiting = acquireRunLock(open, s, "alpha-sync", deps(events), {
      wait: { mode: "poll", ms: 2000, turns: createTurnQueue() },
    });
    await Bun.sleep(200);
    const releasedAt = Date.now();
    await holder.release();
    const lock = await waiting;
    const lag = Date.now() - releasedAt;
    expect(lag).toBeLessThanOrEqual(POLL_MS + 25);
    const wait = events.find((e) => e.type === "lock.wait");
    expect(wait).toMatchObject({ outcome: "acquired" });
    await lock.release();
  });

  test("W9: an L1 that wins after the abort leaves nothing held", async () => {
    const ac = new AbortController();
    const racing = (): LockSession => {
      const base = open();
      const unsafe = async (q: string, p?: readonly unknown[]) => {
        const rows = await base.sql.unsafe(q, p);
        if (q === L1) ac.abort();
        return rows;
      };
      const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
        base.sql(strings, ...values);
      return { sql: Object.assign(tag, { unsafe }) as unknown as Sql, close: base.close };
    };
    let err: unknown;
    try {
      await acquireRunLock(racing, s, "alpha-sync", deps(), {
        wait: { mode: "poll", ms: 1000, turns: createTurnQueue(), signal: ac.signal },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RootstockLockError);
    expect((err as RootstockLockError).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(await held()).toBe(false);
  });
});
