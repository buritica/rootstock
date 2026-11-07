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
import {
  lateBunSqlDestroy,
  lockDriver,
  openBunSqlClient,
  openPostgresJsClient,
} from "./fixtures.pg-support.ts";
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
import { B0, B1, B2, L1, L3, L6, tableStatements } from "./statements.ts";

// R-C4 (contract §3.5): the poll wait against a real server, once per kind;
// R-D7 (w4d §8.1): block mode, below.

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
    await holder.release();
    // Measured from release()'s resolution: its close is not the waiter's lag.
    const releasedAt = Date.now();
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

// w4d §8.1 (R-D7): block mode against a real server, once per kind.

const CHECK_MS = 200;
const SETTINGS =
  "SELECT current_setting('lock_timeout') AS lt, current_setting('client_connection_check_interval') AS cc, 1 AS probe";

let blockSlice: LockSlice;

beforeAll(() => {
  blockSlice = lockSlice({
    table: { ...s.table },
    profile: "lock",
    names: ["alpha-sync", "beta-sync", "shared-write"],
    heartbeatSeconds: 5,
    probeStallSeconds: 10,
    maxRecoveries: 1,
    endTimeoutSeconds: 1,
    wait: { maxMs: 5000, pollIntervalMs: POLL_MS, block: { checkIntervalMs: CHECK_MS } },
  });
});

function openBlock(): LockSession {
  return lockDriver() === "bun-sql"
    ? bunSqlLockSession(openBunSqlClient(), blockSlice)
    : postgresJsLockSession(openPostgresJsClient(), blockSlice);
}

/** Every statement text a session was sent, and how it was ended, in order. */
interface Recorded {
  sent: string[];
  ends: ("close" | "destroy")[];
}

/** A session over `base` that records what it is sent; `after` runs on it once a statement answers. */
function recording(
  base: LockSession,
  rec: Recorded,
  opts: {
    withDestroy?: boolean;
    before?: (text: string, sql: Sql) => Promise<void>;
    after?: (text: string, rows: unknown[], sql: Sql) => Promise<void> | void;
  } = {},
): LockSession {
  const unsafe = async (q: string, p?: readonly unknown[]) => {
    await opts.before?.(q, base.sql);
    rec.sent.push(q);
    const rows = await base.sql.unsafe(q, p);
    await opts.after?.(q, rows, base.sql);
    return rows;
  };
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => base.sql(strings, ...values);
  const session: LockSession = {
    sql: Object.assign(tag, { unsafe }) as unknown as Sql,
    close: () => {
      rec.ends.push("close");
      return base.close();
    },
  };
  if (opts.withDestroy === false) return session;
  return {
    ...session,
    destroy: () => {
      rec.ends.push("destroy");
      return (base.destroy as () => Promise<void>)();
    },
  };
}

/** deps whose randomUUID calls are counted: an acquire that never fences never calls it. */
function countingDeps(events: LockEvent[] = []): LockDeps & { uuids: () => number } {
  let uuids = 0;
  const d = deps(events);
  return {
    ...d,
    randomUUID: () => {
      uuids += 1;
      return crypto.randomUUID();
    },
    uuids: () => uuids,
  };
}

async function heldBy(name: string): Promise<boolean> {
  return (await locksHeld(adminSql, [name])).get(name) === true;
}

/** The pids blocked in B2 in this database, oldest first, once there are at least `n`. */
async function blockedPids(n: number): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const rows = await adminSql.unsafe(
      "SELECT pid FROM pg_stat_activity WHERE query = $1 AND wait_event_type = 'Lock' AND datname = current_database() ORDER BY query_start, pid",
      [B2],
    );
    if (rows.length >= n) return rows.map((r) => Number(r.pid));
    if (Date.now() > deadline) throw new Error(`fewer than ${n} backends blocked in B2`);
    await Bun.sleep(10);
  }
}

async function blockedPid(): Promise<number> {
  return (await blockedPids(1))[0] as number;
}

/** When `pid` left pg_stat_activity (Date.now()), polled every 5 ms. */
async function goneAt(pid: number): Promise<number> {
  const start = Date.now();
  for (;;) {
    const rows = await adminSql.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (rows.length === 0) return Date.now();
    if (Date.now() - start > 10_000) throw new Error(`backend ${pid} did not exit`);
    await Bun.sleep(5);
  }
}

async function fenceHolder(name: string): Promise<string | null> {
  const [row] = await adminSql.unsafe(
    `SELECT holder::text AS holder FROM "${blockSlice.table.schema}"."${blockSlice.table.name}" WHERE name = $1`,
    [name],
  );
  return row === undefined ? null : String(row.holder);
}

/** What each test measured; the bounds assert on it (LB3's bounds are a hypothesis, D-S1 H6/H10). */
const measured: Record<string, number> = {};

describe("block mode against a real server (w4d §8.1)", () => {
  test("LB1: block mode acquires after the holder releases; settings restored before L2 and after L2, L3, L5", async () => {
    const holder = await acquireRunLock(openBlock, blockSlice, "alpha-sync", deps());
    const rec: Recorded = { sent: [], ends: [] };
    const reads: { at: string; lt: unknown; cc: unknown }[] = [];
    let b0: { lt: unknown; cc: unknown } | undefined;
    let b1: { lt: unknown; cc: unknown } | undefined;
    const fenceText = tableStatements(blockSlice.table).fence;
    const heartbeat = tableStatements(blockSlice.table).heartbeat;
    const label = (q: string) =>
      q === fenceText ? "after L2" : q === L3 ? "after L3" : q === heartbeat ? "after L5" : null;
    const open = () =>
      recording(openBlock(), rec, {
        // The read just before L2 is sent, on the same session.
        before: async (q, sql) => {
          if (q !== fenceText) return;
          const [r] = await sql.unsafe(SETTINGS);
          reads.push({ at: "before L2", lt: r?.lt, cc: r?.cc });
        },
        after: async (q, rows, sql) => {
          const row = rows[0] as { lt: unknown; cc: unknown } | undefined;
          if (q === B0) b0 = { lt: row?.lt, cc: row?.cc };
          if (q === B1 && b1 === undefined) b1 = { lt: row?.lt, cc: row?.cc };
          const at = label(q);
          if (at === null) return;
          const [r] = await sql.unsafe(SETTINGS);
          reads.push({ at, lt: r?.lt, cc: r?.cc });
        },
      });
    let tick: () => void = () => {};
    const events: LockEvent[] = [];
    const d = {
      ...deps(events),
      setInterval: (fn: () => void) => {
        tick = fn;
        return 1;
      },
    };
    const waiting = acquireRunLock(open, blockSlice, "alpha-sync", d, {
      wait: { mode: "block", ms: 3000, turns: createTurnQueue() },
    });
    await blockedPid();
    await holder.release();
    const releasedAt = Date.now();
    const lock = await waiting;
    measured.lb1GrantAfterReleaseMs = Date.now() - releasedAt;
    try {
      expect(events.find((e) => e.type === "lock.wait")).toMatchObject({
        mode: "block",
        outcome: "acquired",
      });
      expect(rec.sent.slice(0, 5)).toEqual([B0, B1, B2, B1, fenceText]);
      // B1 really set them, so a restored read is not a coincidence.
      expect(b1?.cc).toBe(`${CHECK_MS}ms`);
      expect(b1?.lt).not.toBe(b0?.lt);
      await lock.ensureExclusive();
      lock.startKeepalive();
      tick();
      for (let i = 0; i < 200 && !reads.some((r) => r.at === "after L5"); i += 1) {
        await Bun.sleep(10);
      }
      lock.stopKeepalive();
      expect(reads.map((r) => r.at)).toEqual([
        "before L2",
        "after L2",
        "after L3",
        "after L3",
        "after L5",
      ]);
      for (const r of reads)
        expect({ lt: r.lt, cc: r.cc }).toEqual(b0 as { lt: unknown; cc: unknown });
      expect(events.map((e) => e.type)).not.toContain("lock.fence_missing");
    } finally {
      await lock.release();
    }
  });

  test("LB2: block timeout: the holder keeps the lock; ms 300 is HELD after a wait, outcome timeout", async () => {
    const holder = await acquireRunLock(openBlock, blockSlice, "alpha-sync", deps());
    const events: LockEvent[] = [];
    const started = Date.now();
    let err: unknown;
    try {
      await acquireRunLock(openBlock, blockSlice, "alpha-sync", deps(events), {
        wait: { mode: "block", ms: 300, turns: createTurnQueue() },
      });
    } catch (e) {
      err = e;
    }
    measured.lb2TimeoutMs = Date.now() - started;
    try {
      expect(err).toBeInstanceOf(RootstockLockError);
      expect((err as RootstockLockError).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
      expect((err as RootstockLockError).waitedMs).toBeGreaterThanOrEqual(300);
      expect(events.find((e) => e.type === "lock.wait")).toMatchObject({
        mode: "block",
        outcome: "timeout",
      });
      expect(await heldBy("alpha-sync")).toBe(true);
      await holder.ensureExclusive();
    } finally {
      await holder.release();
    }
  });

  for (const withDestroy of [true, false]) {
    const id = withDestroy ? "LB3" : "LB3b";
    test(`${id}: an aborted blocked waiter refuses ABANDONED and ends ${withDestroy ? "by destroy()" : "by close() (no destroy)"}; the next waiter is granted promptly; it never fences`, async () => {
      const name = withDestroy ? "beta-sync" : "alpha-sync";
      // §20 A38: on Bun.SQL before 1.4.4 neither destroy() nor close() sends
      // the FIN while B2 is in flight, so the ghost ends at its lock_timeout
      // (the wait's ms), still before it is granted.
      const late = lateBunSqlDestroy();
      const ghostMs = late ? 1500 : 5000;
      const bound = late
        ? ghostMs + CHECK_MS + 500
        : (withDestroy ? 0 : blockSlice.endTimeoutSeconds * 1000) + CHECK_MS + 200;
      const holder = await acquireRunLock(openBlock, blockSlice, name, deps());
      const rec: Recorded = { sent: [], ends: [] };
      const ac = new AbortController();
      const ghostDeps = countingDeps();
      const ghost = acquireRunLock(
        () => recording(openBlock(), rec, { withDestroy }),
        blockSlice,
        name,
        ghostDeps,
        { wait: { mode: "block", ms: ghostMs, turns: createTurnQueue(), signal: ac.signal } },
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      const ghostPid = await blockedPid();
      // A second process's waiter, queued on the server behind the ghost.
      const nextEvents: LockEvent[] = [];
      const next = acquireRunLock(openBlock, blockSlice, name, deps(nextEvents), {
        wait: { mode: "block", ms: 5000, turns: createTurnQueue() },
      });
      await blockedPids(2);
      const abortedAt = Date.now();
      ac.abort();
      // The holder keeps the lock meanwhile: the ghost ends because the
      // server noticed its socket, not because it was granted and replied.
      const gone = goneAt(ghostPid);
      const err = await ghost;
      measured[`${id.toLowerCase()}RefusalAfterAbortMs`] = Date.now() - abortedAt;
      measured[`${id.toLowerCase()}GhostGoneAfterAbortMs`] = (await gone) - abortedAt;
      expect(await heldBy(name)).toBe(true);
      await holder.release();
      const releasedAt = Date.now();
      const lock = await next;
      measured[`${id.toLowerCase()}GrantAfterReleaseMs`] = Date.now() - releasedAt;
      try {
        expect(err).toBeInstanceOf(RootstockLockError);
        expect((err as RootstockLockError).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
        expect(rec.ends).toEqual([withDestroy ? "destroy" : "close"]);
        expect(rec.sent).toEqual([B0, B1, B2]);
        expect(ghostDeps.uuids()).toBe(0);
        expect(await fenceHolder(name)).toBe(lock.holder);
        expect(measured[`${id.toLowerCase()}GhostGoneAfterAbortMs`]).toBeLessThanOrEqual(bound);
        expect(measured[`${id.toLowerCase()}GrantAfterReleaseMs`]).toBeLessThanOrEqual(
          late ? CHECK_MS + 200 : bound,
        );
      } finally {
        await lock.release();
      }
    }, 20_000);
  }

  test("LB4: a grant that lands after the abort is unlocked: ABANDONED, nothing held, no fencing row", async () => {
    const ac = new AbortController();
    const rec: Recorded = { sent: [], ends: [] };
    const d = countingDeps();
    let err: unknown;
    try {
      await acquireRunLock(
        () =>
          recording(openBlock(), rec, {
            after: (q, rows) => {
              if (q !== B2) return;
              // The grant has answered and decided the race; the abort lands
              // when the acquire reads the pid, just before its abort check.
              const row = rows[0] as Record<string, unknown>;
              const pid = row.pid;
              Object.defineProperty(row, "pid", {
                get: () => {
                  ac.abort();
                  return pid;
                },
              });
            },
          }),
        blockSlice,
        "shared-write",
        d,
        { wait: { mode: "block", ms: 1000, turns: createTurnQueue(), signal: ac.signal } },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RootstockLockError);
    expect((err as RootstockLockError).code).toBe("ERR_ROOTSTOCK_LOCK_ABANDONED");
    expect(rec.sent).toEqual([B0, B1, B2, L6]);
    expect(rec.ends).toEqual(["close"]);
    expect(d.uuids()).toBe(0);
    expect(await heldBy("shared-write")).toBe(false);
    expect(await fenceHolder("shared-write")).toBeNull();
  });

  test("LB5: block mode without wait.block refuses WAIT with the block note; ms 0 in block refuses WAIT", async () => {
    let opened = false;
    const refuse = async (slice: LockSlice, ms: number) => {
      try {
        await acquireRunLock(
          () => {
            opened = true;
            return openBlock();
          },
          slice,
          "alpha-sync",
          deps(),
          { wait: { mode: "block", ms, turns: createTurnQueue() } },
        );
      } catch (e) {
        return e as RootstockLockError;
      }
      throw new Error("expected WAIT");
    };
    const noBlock = await refuse(s, 100);
    expect(noBlock.code).toBe("ERR_ROOTSTOCK_LOCK_WAIT");
    expect(noBlock.message).toContain(" (block mode needs wait.block in the lock slice) — got ");
    const zero = await refuse(blockSlice, 0);
    expect(zero.code).toBe("ERR_ROOTSTOCK_LOCK_WAIT");
    expect(zero.message).not.toContain("block mode needs");
    expect(opened).toBe(false);
  });
});
