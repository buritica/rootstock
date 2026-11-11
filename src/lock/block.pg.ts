import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgCode, type Row, type Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { quoteTable } from "../internal/slice.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import {
  lateBunSqlDestroy,
  lockDriver,
  openBunSqlClient,
  openPostgresJsClient,
  openRaw,
  rawSql,
} from "./fixtures.pg-support.ts";
import {
  acquireRunLock,
  type LockDeps,
  type LockEvent,
  type LockSession,
  type LockSlice,
  lockSlice,
  locksHeld,
} from "./index.ts";
import { startStallProxy } from "./proxy.pg-support.ts";
import { bunSqlLockSession, postgresJsLockSession } from "./session.ts";

// D-S1 (contract §14): the block-mode hypotheses H5, H6, H7, H10 and H11,
// measured with the frozen B0–B3 texts of §8.1 on raw driver clients, before
// the block-mode API exists. Each case pins what the server and the driver
// actually do; the bounds are about twice what was measured locally.

const B0 =
  "SELECT current_setting('lock_timeout') AS lt, current_setting('client_connection_check_interval') AS cc";
const B1 =
  "SELECT set_config('lock_timeout', $1::text, false) AS lt, set_config('client_connection_check_interval', $2::text, false) AS cc";
const B2 =
  "SELECT true AS locked, pg_backend_pid() AS pid FROM (SELECT pg_advisory_lock(hashtext($1))) AS t";

const driver = lockDriver();
/** §20 A38: this cell's destroy() waits for B2, so there is no at-once FIN to time. */
const late = lateBunSqlDestroy();
let main: TestTransactor;
let admin: TestTransactor;
let adminSql: Sql;
const { schema, dropAll } = schemaFactory("rs_blk");
let slice: LockSlice;

/** The connection error each driver rejects an in-flight query with when its client is ended. */
const CLOSED_CODE =
  driver === "bun-sql" ? "ERR_POSTGRES_CONNECTION_CLOSED" : "CONNECTION_DESTROYED";

/** A raw `max: 1` client of the lock driver: its backend pid, and its two ways to end. */
interface Waiter {
  sql: Sql;
  pid: number;
  /** postgres.js `end({ timeout: 0 })`, Bun.SQL `close({ timeout: 0 })`: §8.1's `destroy`. */
  destroy(): Promise<void>;
  /** postgres.js `end({ timeout })`, Bun.SQL `close({ timeout })`: the shipped sessions' `close`. */
  close(timeoutSeconds: number): Promise<void>;
}

async function openWaiter(kind = driver): Promise<Waiter> {
  let sql: Sql;
  let end: (timeout: number) => Promise<void>;
  if (kind === "bun-sql") {
    const c = openBunSqlClient(1);
    sql = rawSql(c);
    end = (timeout) => c.close({ timeout });
  } else {
    const c = openPostgresJsClient(1);
    sql = rawSql(c);
    end = (timeout) => c.end({ timeout });
  }
  const [row] = await sql.unsafe("SELECT pg_backend_pid() AS pid");
  return { sql, pid: Number(row?.pid), destroy: () => end(0), close: end };
}

/** A pending query, settled into a value so nothing it does is unhandled. */
function pending(
  p: Promise<Row[]>,
): Promise<{ ok: true; rows: Row[] } | { ok: false; error: unknown }> {
  return p.then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function alive(pid: number): Promise<boolean> {
  const rows = await adminSql.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
  return rows.length > 0;
}

async function waitingOnLock(pid: number): Promise<boolean> {
  const rows = await adminSql.unsafe(
    "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
    [pid],
  );
  return rows.length > 0;
}

async function holdsAdvisory(pid: number): Promise<boolean> {
  const rows = await adminSql.unsafe(
    "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted",
    [pid],
  );
  return rows.length > 0;
}

/** Ms until `cond` holds, polled every 5 ms from `since`; throws past `limitMs`. */
async function msUntil(
  cond: () => Promise<boolean>,
  since: number,
  limitMs: number,
): Promise<number> {
  for (;;) {
    if (await cond()) return performance.now() - since;
    if (performance.now() - since > limitMs)
      throw new Error(`condition not met within ${limitMs} ms`);
    await Bun.sleep(5);
  }
}

/** A holder on its own raw session, and a waiter blocked behind it in B2 after B1. */
async function blockedWaiter(name: string, checkInterval: string, lockTimeout = "30000ms") {
  const holder = openRaw();
  const [h] = await holder.sql.unsafe(
    "SELECT pg_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid",
    [name],
  );
  const w = await openWaiter();
  await w.sql.unsafe(B1, [lockTimeout, checkInterval]);
  const b2 = pending(w.sql.unsafe(B2, [name]));
  await msUntil(() => waitingOnLock(w.pid), performance.now(), 3_000);
  const unlock = () => holder.sql.unsafe("SELECT pg_advisory_unlock(hashtext($1))", [name]);
  return { holder, holderPid: Number(h?.pid), w, b2, unlock };
}

/** A second, live waiter queued behind `name`: when it is granted, in performance.now() time. */
function queuedSecond(name: string) {
  const second = openRaw();
  let grantedAt = Number.NaN;
  const done = second.sql.unsafe("SELECT pg_advisory_lock(hashtext($1))", [name]).then(() => {
    grantedAt = performance.now();
  });
  return {
    granted: async () => {
      await done;
      return grantedAt;
    },
    end: () => second.end(),
  };
}

beforeAll(async () => {
  main = openTestTransactor();
  admin = openSecond();
  adminSql = admin.transactor.sql;
  const s = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
  slice = lockSlice({
    table: { schema: s },
    profile: "lock",
    names: ["alpha-sync"],
    heartbeatSeconds: 5,
    probeStallSeconds: 6,
    maxRecoveries: 3,
    endTimeoutSeconds: 1,
    wait: { maxMs: 0, pollIntervalMs: 50 },
  });
});

afterAll(async () => {
  await dropAll(main.transactor.sql);
  await admin.close();
  await main.close();
});

describe("D-S1 block-mode hypotheses (§14)", () => {
  test("H5: both settings are user-settable, B1 is accepted for an ordinary role, B0 reads them back normalised, B3 restores", async () => {
    const contexts = await adminSql.unsafe(
      "SELECT name, context FROM pg_settings WHERE name IN ('lock_timeout', 'client_connection_check_interval') ORDER BY name",
    );
    expect(contexts).toEqual([
      { name: "client_connection_check_interval", context: "user" },
      { name: "lock_timeout", context: "user" },
    ]);
    const role = `rs_ds1_plain_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await adminSql.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER`);
    const w = await openWaiter();
    try {
      await w.sql.unsafe(`SET ROLE "${role}"`);
      const [who] = await w.sql.unsafe(
        "SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su",
      );
      expect(who?.u).toBe(role);
      expect(who?.su === true || who?.su === "t" || who?.su === "true").toBe(false);
      const before = await w.sql.unsafe(B0);
      expect(before).toEqual([{ lt: "0", cc: "0" }]);
      const [set] = await w.sql.unsafe(B1, ["30000ms", "1000ms"]);
      // set_config answers the normalised text, not the text it was given.
      expect(set).toEqual({ lt: "30s", cc: "1s" });
      expect(await w.sql.unsafe(B0)).toEqual([{ lt: "30s", cc: "1s" }]);
      await w.sql.unsafe(B1, [before[0]?.lt, before[0]?.cc]);
      expect(await w.sql.unsafe(B0)).toEqual(before);
    } finally {
      await w.close(1);
      await adminSql.unsafe(`DROP ROLE "${role}"`);
    }
  });

  test("H7: pg_advisory_lock under lock_timeout raises 55P03, readable through pgCode", async () => {
    const holder = openRaw();
    await holder.sql.unsafe("SELECT pg_advisory_lock(hashtext($1))", ["alpha-sync"]);
    const w = await openWaiter();
    try {
      await w.sql.unsafe(B1, ["300ms", "1000ms"]);
      const started = performance.now();
      const b2 = await pending(w.sql.unsafe(B2, ["alpha-sync"]));
      const waited = performance.now() - started;
      expect(b2.ok).toBe(false);
      if (!b2.ok) expect(pgCode(b2.error)).toBe("55P03");
      expect(waited).toBeGreaterThanOrEqual(280);
      expect(waited).toBeLessThan(600);
      // The session survives the timeout, with B1's values still set.
      expect(await w.sql.unsafe(B0)).toEqual([{ lt: "300ms", cc: "1s" }]);
    } finally {
      await w.close(1);
      await holder.end();
    }
  });

  test.skipIf(late)(
    "H10: destroy() ends the client at once while B2 is in flight; B2 rejects; nothing is unhandled; the server hears the FIN at once",
    async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", onUnhandled);
      process.on("uncaughtException", onUnhandled);
      const { holder, holderPid, w, b2, unlock } = await blockedWaiter("alpha-sync", "100ms");
      try {
        const t0 = performance.now();
        await w.destroy();
        const destroyMs = performance.now() - t0;
        const settled = await b2;
        const goneMs = await msUntil(async () => !(await alive(w.pid)), t0, 5_000);
        expect(destroyMs).toBeLessThan(100);
        expect(settled.ok).toBe(false);
        if (!settled.ok) {
          expect(pgCode(settled.error)).toBeUndefined();
          expect((settled.error as { code?: unknown }).code).toBe(CLOSED_CODE);
        }
        // With a 100 ms check interval the backend goes within one interval of the FIN.
        expect(goneMs).toBeLessThan(400);
        expect(await holdsAdvisory(holderPid)).toBe(true);
        await Bun.sleep(100);
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        process.off("uncaughtException", onUnhandled);
        await unlock();
        await holder.end();
      }
    },
  );

  test.skipIf(late)(
    "H10 contrast: close({ timeout: 1 }) waits out the timeout with B2 in flight before it sends the FIN",
    async () => {
      const { holder, w, b2, unlock } = await blockedWaiter("alpha-sync", "100ms");
      try {
        const t0 = performance.now();
        await w.close(1);
        const closeMs = performance.now() - t0;
        const settled = await b2;
        expect(closeMs).toBeGreaterThanOrEqual(900);
        expect(closeMs).toBeLessThan(2_000);
        expect(settled.ok).toBe(false);
        // The FIN goes out only now: the backend leaves within one 100 ms interval of it.
        const closed = performance.now();
        expect(await msUntil(async () => !(await alive(w.pid)), closed, 5_000)).toBeLessThan(400);
      } finally {
        await unlock();
        await holder.end();
      }
    },
  );

  test.skipIf(late)(
    "H6a: with client_connection_check_interval 1000ms, a destroyed waiter is ended within about 1 s, before it is granted",
    async () => {
      const { holder, holderPid, w, b2, unlock } = await blockedWaiter("alpha-sync", "1000ms");
      try {
        const t0 = performance.now();
        await w.destroy();
        const goneMs = await msUntil(async () => !(await alive(w.pid)), t0, 5_000);
        expect(goneMs).toBeLessThan(2_000);
        // The holder never let go, so the waiter was ended while still waiting.
        expect(await holdsAdvisory(holderPid)).toBe(true);
        expect((await b2).ok).toBe(false);
      } finally {
        await unlock();
        await holder.end();
      }
    },
  );

  test.skipIf(late)(
    "H6b: without it, a destroyed waiter stays blocked until granted, then exits when its reply fails; a second waiter is granted at once",
    async () => {
      const { holder, w, b2, unlock } = await blockedWaiter("alpha-sync", "0");
      const second = queuedSecond("alpha-sync");
      try {
        await w.destroy();
        await Bun.sleep(1_500);
        expect(await waitingOnLock(w.pid)).toBe(true);
        const released = performance.now();
        await unlock();
        const goneMs = await msUntil(async () => !(await alive(w.pid)), released, 5_000);
        const grantedMs = (await second.granted()) - released;
        expect(goneMs).toBeLessThan(500);
        expect(grantedMs).toBeLessThan(500);
        expect((await b2).ok).toBe(false);
      } finally {
        await second.end();
        await holder.end();
      }
    },
  );

  test.skipIf(late)(
    "H6c (LB3's second bound): released just after the destroy, a second waiter is granted within checkIntervalMs + 200 ms",
    async () => {
      const { holder, w, b2, unlock } = await blockedWaiter("alpha-sync", "1000ms");
      const second = queuedSecond("alpha-sync");
      try {
        await w.destroy();
        const released = performance.now();
        await unlock();
        const grantedMs = (await second.granted()) - released;
        expect(grantedMs).toBeLessThan(1_200);
        await msUntil(async () => !(await alive(w.pid)), released, 3_000);
        expect((await b2).ok).toBe(false);
      } finally {
        await second.end();
        await holder.end();
      }
    },
  );

  test.skipIf(late)(
    "H6d: through close() bounded by endTimeoutSeconds, the ghost window is endTimeoutSeconds + checkIntervalMs",
    async () => {
      const { holder, holderPid, w, b2, unlock } = await blockedWaiter("alpha-sync", "1000ms");
      try {
        const t0 = performance.now();
        const closing = w.close(1);
        const goneMs = await msUntil(async () => !(await alive(w.pid)), t0, 6_000);
        await closing;
        expect(goneMs).toBeGreaterThanOrEqual(900);
        expect(goneMs).toBeLessThan(4_000);
        expect(await holdsAdvisory(holderPid)).toBe(true);
        expect((await b2).ok).toBe(false);
      } finally {
        await unlock();
        await holder.end();
      }
    },
  );

  test.skipIf(!late)(
    "A38 (Bun.SQL before 1.4.4): destroy() waits for B2, which ends at lock_timeout; then the backend leaves and the holder keeps the lock",
    async () => {
      const { holder, holderPid, w, b2, unlock } = await blockedWaiter(
        "alpha-sync",
        "100ms",
        "1500ms",
      );
      try {
        const t0 = performance.now();
        await w.destroy();
        const destroyMs = performance.now() - t0;
        const settled = await b2;
        const goneMs = await msUntil(async () => !(await alive(w.pid)), t0, 5_000);
        expect(destroyMs).toBeGreaterThanOrEqual(1_300);
        expect(destroyMs).toBeLessThan(3_500);
        expect(settled.ok).toBe(false);
        if (!settled.ok) expect(pgCode(settled.error)).toBe("55P03");
        expect(goneMs - destroyMs).toBeLessThan(1_000);
        expect(await holdsAdvisory(holderPid)).toBe(true);
      } finally {
        await unlock();
        await holder.end();
      }
    },
  );

  test("H11: a stalled-probe recovery's L9 ends only the run's own backend, never an abandoned block-mode waiter, and its fresh session sends no B statement", async () => {
    const proxy = startStallProxy();
    const events: LockEvent[] = [];
    const sent: string[] = [];
    const open = (): LockSession => {
      const inner =
        driver === "bun-sql"
          ? bunSqlLockSession(openBunSqlClient(1, proxy.url), slice)
          : postgresJsLockSession(openPostgresJsClient(1, proxy.url), slice);
      const sql = inner.sql;
      const recording = (async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
        sent.push(strings.join("?"));
        return sql(strings, ...values);
      }) as Sql;
      (recording as { unsafe: Sql["unsafe"] }).unsafe = ((
        query: string,
        params?: readonly unknown[],
      ) => {
        sent.push(query);
        return sql.unsafe(query, params);
      }) as Sql["unsafe"];
      return { sql: recording, close: () => inner.close() };
    };
    const lock = await acquireRunLock(open, slice, "alpha-sync", lockDeps(events));
    // A block-mode waiter, abandoned: its socket closed, no check interval, so
    // the server keeps it queued for the advisory lock. On a §20 A38 cell the
    // ghost is a postgres.js client, whose destroy() closes the socket at once.
    const ghost = await openWaiter(late ? "postgres-js" : driver);
    await ghost.sql.unsafe(B1, ["30000ms", "0"]);
    const ghostB2 = pending(ghost.sql.unsafe(B2, ["alpha-sync"]));
    try {
      const old = acquiredPid(events);
      await msUntil(() => waitingOnLock(ghost.pid), performance.now(), 3_000);
      await ghost.destroy();
      proxy.freeze({ forwardClose: false });
      await lock.ensureExclusive();
      const terminated = events.filter((e) => e.type === "lock.stalled_backend_terminated");
      expect(terminated).toEqual([
        { type: "lock.stalled_backend_terminated", name: "alpha-sync", attempt: 1, pid: old },
      ]);
      expect(events.map((e) => e.type)).toContain("lock.recovered");
      // The ghost was granted once the old backend died, failed its reply and left; it never fenced.
      await msUntil(async () => !(await alive(ghost.pid)), performance.now(), 3_000);
      expect((await ghostB2).ok).toBe(false);
      const fence = await adminSql.unsafe(
        `SELECT holder::text AS holder FROM ${quoteTable(slice.table)} WHERE name = $1`,
        ["alpha-sync"],
      );
      expect(fence).toEqual([{ holder: lock.holder }]);
      expect(
        sent.filter((q) =>
          /lock_timeout|client_connection_check_interval|pg_advisory_lock\(/.test(q),
        ),
      ).toEqual([]);
      expect((await locksHeld(adminSql, ["alpha-sync"])).get("alpha-sync")).toBe(true);
    } finally {
      await lock.release();
      proxy.stop();
    }
    expect((await locksHeld(adminSql, ["alpha-sync"])).get("alpha-sync")).toBe(false);
  }, 30_000);
});

function lockDeps(events: LockEvent[]): LockDeps {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
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

function acquiredPid(events: LockEvent[]): number {
  const e = events.find((x) => x.type === "lock.acquired");
  if (e?.type !== "lock.acquired") throw new Error("no lock.acquired event");
  return e.pid;
}
