import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bunSqlOptions, postgresJsOptions, type Sql } from "../db/index.ts";
import { openSecond, type TestTransactor } from "../db/transactor.pg-support.ts";
import {
  killBackend,
  LOCK_CLIENT,
  lockDriver,
  openBunSqlClient,
  openPostgresJsClient,
  rawSql,
  testKind,
  testUrl,
} from "./fixtures.pg-support.ts";
import { type LockSession, lockSlice } from "./index.ts";
import { bunSqlLockSession, postgresJsLockSession } from "./session.ts";

// C-S1 (contract §3.2): what each driver does when the backend under a lock
// session is killed, on a dedicated `max: 1` client and on a pool reservation.
// pg_terminate_backend stands in for a socket severed without a reset
// (iptables is not available); a severed socket is not exercised.

const L1 = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid";
const L3 = `SELECT pg_backend_pid() AS pid,
       (SELECT count(*)::int FROM pg_locks l
         WHERE l.pid = pg_backend_pid() AND l.locktype = 'advisory' AND l.granted) AS held`;

/** How long X1 lets the driver process a severed socket's close. */
const SETTLE_MS = 50;

interface Probe {
  pid: number;
  held: number;
}

let admin: TestTransactor;
let adminSql: Sql;
const kind = testKind();
const driver = lockDriver();

beforeAll(() => {
  admin = openSecond();
  adminSql = admin.transactor.sql;
});

afterAll(async () => {
  await admin.close();
});

const SLICE = lockSlice({
  profile: "lock",
  names: ["alpha-sync"],
  heartbeatSeconds: 5,
  probeStallSeconds: 10,
  maxRecoveries: 1,
  endTimeoutSeconds: 1,
  wait: { maxMs: 0, pollIntervalMs: 10 },
});

/** A dedicated `max: 1` lock client of the driver under test, as a lock session. */
function openDedicated(): LockSession {
  return driver === "bun-sql"
    ? bunSqlLockSession(openBunSqlClient(), SLICE)
    : postgresJsLockSession(openPostgresJsClient(), SLICE);
}

/** The same, with every driver end/close call counted. */
function openCounted(): { session: LockSession; ends: () => number } {
  let ends = 0;
  if (driver === "bun-sql") {
    const c = openBunSqlClient();
    const counted = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => c(s, ...v), {
      unsafe: (q: string, p?: unknown[]) => c.unsafe(q, p),
      close: (o?: { timeout?: number }) => {
        ends += 1;
        return c.close(o);
      },
    });
    return { session: bunSqlLockSession(counted, SLICE), ends: () => ends };
  }
  const c = openPostgresJsClient();
  const counted = Object.assign(
    (s: TemplateStringsArray, ...v: unknown[]) => c(s, ...(v as never[])),
    {
      unsafe: (q: string, p?: unknown[]) => c.unsafe(q, p as never[]),
      end: (o?: { timeout?: number }) => {
        ends += 1;
        return c.end(o);
      },
    },
  );
  return { session: postgresJsLockSession(counted, SLICE), ends: () => ends };
}

async function probe(sql: Sql): Promise<Probe> {
  const [row] = await sql.unsafe<{ pid: unknown; held: unknown }>(L3);
  return { pid: Number(row?.pid), held: Number(row?.held) };
}

describe("C-S1: a killed lock backend", () => {
  if (kind !== "drizzle") {
    test("X1: on a max: 1 session the next query reconnects", async () => {
      const s = openDedicated();
      try {
        const [row] = await s.sql.unsafe<{ locked: boolean; pid: number }>(L1, ["alpha-sync"]);
        expect(row?.locked).toBe(true);
        const before = Number(row?.pid);
        await killBackend(adminSql, before);
        // The first query either pays for the reconnect by rejecting, or
        // already runs on a fresh backend that holds nothing.
        try {
          const first = await probe(s.sql);
          expect(first.pid).not.toBe(before);
          expect(first.held).toBe(0);
        } catch (err) {
          expect(err).toBeDefined();
        }
        // On postgres.js the following query must not be sent in the same
        // turn as an ECONNRESET rejection (X1w); a few milliseconds is enough.
        await Bun.sleep(SETTLE_MS);
        const second = await probe(s.sql);
        expect(second.pid).not.toBe(before);
        expect(second.held).toBe(0);
      } finally {
        await s.close();
      }
    });
  }

  if (driver === "postgres-js" && kind === "postgres-js") {
    // Observed 2026-11-07, Bun 1.4.2 and postgres 3.4.9: after the kill, the
    // first query rejects with ECONNRESET most of the time (CONNECTION_CLOSED
    // otherwise). A query sent right after an ECONNRESET rejection, before
    // the driver has processed the socket's close, never settles, and neither
    // does any query after it: the client is wedged. Sent 5 ms or more later,
    // it runs on a fresh backend. Bun.SQL reconnects in both cases.
    test("X1w: a query sent in the same turn as an ECONNRESET rejection wedges postgres.js", async () => {
      let wedged = false;
      for (let attempt = 0; attempt < 10 && !wedged; attempt += 1) {
        const s = openDedicated();
        const [row] = await s.sql.unsafe<{ pid: number }>(L1, ["alpha-sync"]);
        await killBackend(adminSql, Number(row?.pid));
        const first = await probe(s.sql).then(
          () => "resolved",
          (err: unknown) => String((err as { code?: unknown }).code),
        );
        if (first === "ECONNRESET") {
          const next = await Promise.race([
            probe(s.sql).then(
              () => "settled",
              () => "settled",
            ),
            Bun.sleep(2_000).then(() => "never settled"),
          ]);
          expect(next).toBe("never settled");
          wedged = true;
        }
        s.close().catch(() => {});
      }
      expect(wedged).toBe(true);
    }, 40_000);
  }

  if (kind === "bun-sql") {
    // Observed 2026-11-07, Bun 1.4.2: every query on the reservation after
    // the kill rejects with "connection must be a PostgresSQLConnection".
    test("X2: a Bun.SQL pool.reserve() handle fails every later query", async () => {
      const pool = openBunSqlClient(2);
      const reserved = await pool.reserve();
      try {
        const sql = rawSql(reserved as unknown as Parameters<typeof rawSql>[0]);
        const [row] = await sql.unsafe<{ pid: number }>(L1, ["alpha-sync"]);
        await killBackend(adminSql, Number(row?.pid));
        for (let i = 0; i < 3; i += 1) {
          let failed: unknown;
          try {
            await probe(sql);
          } catch (err) {
            failed = err;
          }
          expect(failed).toBeInstanceOf(Error);
          expect((failed as Error).message).toContain("connection must be a PostgresSQLConnection");
        }
      } finally {
        reserved.release();
        await pool.close({ timeout: 5 });
      }
    });
  }

  if (kind === "postgres-js") {
    // Observed 2026-11-07, Bun 1.4.2 and postgres 3.4.9: the driver throws an
    // uncaught `TypeError: null is not an object (evaluating
    // 'socket.write')` from its write path, and the query never settles. The
    // process does not exit on its own; the child's watchdog ends it (3).
    test("X3: a postgres.js pool.reserve() handle hits an uncaught TypeError", async () => {
      const child = Bun.spawn(
        [process.execPath, `${import.meta.dir}/reserve-child.pg-support.ts`],
        {
          env: { ...process.env, ROOTSTOCK_TEST_DATABASE_URL: testUrl() },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toContain("TypeError");
      expect(stderr).toContain("socket.write");
      expect(stdout).toBe("query never settled\n");
      expect(code).toBe(3);
    }, 15_000);
  }

  if (kind !== "drizzle") {
    test("X4: close() on a killed backend is bounded, and a second close() calls no driver", async () => {
      const { session, ends } = openCounted();
      const [row] = await session.sql.unsafe<{ pid: number }>(L1, ["alpha-sync"]);
      await killBackend(adminSql, Number(row?.pid));
      const started = performance.now();
      await session.close().catch(() => undefined);
      expect(performance.now() - started).toBeLessThan((SLICE.endTimeoutSeconds + 2) * 1000);
      expect(ends()).toBe(1);
      expect(await session.close()).toBeUndefined();
      expect(ends()).toBe(1);

      // A query that outlives the bound: close() still settles within it.
      const busy = openCounted();
      await busy.session.sql.unsafe("SELECT 1");
      const sleeping = busy.session.sql.unsafe("SELECT pg_sleep(30)").catch(() => undefined);
      await Bun.sleep(100);
      const t0 = performance.now();
      await busy.session.close().catch(() => undefined);
      expect(performance.now() - t0).toBeLessThan((SLICE.endTimeoutSeconds + 2) * 1000);
      void sleeping;
    }, 15_000);
  }

  test("X5: the driver-default idle timeout emits no key and keeps the session", async () => {
    expect(Object.keys(postgresJsOptions(LOCK_CLIENT, "lock"))).not.toContain("idle_timeout");
    expect(Object.keys(bunSqlOptions(LOCK_CLIENT, "lock"))).not.toContain("idleTimeout");
    const s = openDedicated();
    try {
      const before = await probe(s.sql);
      await Bun.sleep(3_000);
      const after = await probe(s.sql);
      expect(after.pid).toBe(before.pid);
    } finally {
      await s.close();
    }
  }, 10_000);

  if (kind === "postgres-js") {
    test("X6: the backoff expression's precedence", async () => {
      const [row] = await adminSql.unsafe<{ a: number; b: number }>(
        "SELECT ('[1,5,30]'::jsonb ->> (least(0 + 1, 3) - 1))::int AS a, ('[1,5,30]'::jsonb ->> least(0, 3) - 1)::int AS b",
      );
      expect(row).toEqual({ a: 1, b: 30 });
    });
  }
});
