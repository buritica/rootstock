import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
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
  killBackend,
  lockDriver,
  ORIGIN_FENCE,
  ORIGIN_L1,
  openBunSqlClient,
  openPostgresJsClient,
  openRaw,
  otherDatabaseUrl,
} from "./fixtures.pg-support.ts";
import {
  acquireRunLock,
  LOCK_HELD_PREDICATE,
  type LockDeps,
  type LockEvent,
  type LockSession,
  type LockSlice,
  lockNameCollisions,
  lockSlice,
  locksHeld,
  RootstockLockError,
  type RunLock,
} from "./index.ts";
import { bunSqlLockSession, postgresJsLockSession } from "./session.ts";
import { L1, tableStatements } from "./statements.ts";

// R-C3 (contract §3.4): the fenced lock against a real server, once per
// transactor kind. Every kill is followed by SETTLE_MS before the next query
// on the killed session: postgres.js wedges a query sent in the same turn as
// the ECONNRESET rejection (C-S1, see session.pg.ts X1w).

const SETTLE_MS = 50;
const OTHER_DB = "rs_lock_other";

let main: TestTransactor;
let admin: TestTransactor;
let sql: Sql;
let adminSql: Sql;
const { schema, dropAll } = schemaFactory("rs_lk");
const driver = lockDriver();
let fenced: string;

function slice(over: Partial<Parameters<typeof lockSlice>[0]> = {}, s = fenced): LockSlice {
  return lockSlice({
    table: { schema: s },
    profile: "lock",
    names: ["alpha-sync", "beta-sync", "c14100", "c180248"],
    heartbeatSeconds: 5,
    probeStallSeconds: 10,
    maxRecoveries: 3,
    endTimeoutSeconds: 1,
    wait: { maxMs: 0, pollIntervalMs: 10 },
    ...over,
  });
}

async function migrated(): Promise<string> {
  const s = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
  return s;
}

beforeAll(async () => {
  main = openTestTransactor();
  admin = openSecond();
  sql = main.transactor.sql;
  adminSql = admin.transactor.sql;
  fenced = await migrated();
});

/** Every lock a case took, released after it so one failure cannot cascade. */
const taken: RunLock[] = [];

afterEach(async () => {
  for (const lock of taken.splice(0)) await lock.release();
});

afterAll(async () => {
  await dropAll(sql);
  await sql.unsafe("DROP SCHEMA IF EXISTS rootstock_c_missing CASCADE");
  await admin.close();
  await main.close();
});

function open(s: LockSlice, max = 1): () => LockSession {
  return () =>
    driver === "bun-sql"
      ? bunSqlLockSession(openBunSqlClient(max), s)
      : postgresJsLockSession(openPostgresJsClient(max), s);
}

interface Harness {
  deps: LockDeps;
  events: LockEvent[];
  /** Runs every registered keepalive tick once. */
  tick: () => void;
}

function harness(): Harness {
  const events: LockEvent[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    events,
    tick: () => {
      for (const fn of [...timers.values()]) fn();
    },
    deps: {
      now: () => Date.now(),
      setInterval: (fn) => {
        const id = next;
        next += 1;
        timers.set(id, fn);
        return id;
      },
      clearInterval: (h) => {
        timers.delete(h as number);
      },
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
    },
  };
}

async function take(name = "alpha-sync", s = slice(), h = harness()): Promise<RunLock> {
  const lock = await acquireRunLock(open(s), s, name, h.deps);
  taken.push(lock);
  return lock;
}

async function refusal(p: Promise<unknown>): Promise<RootstockLockError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RootstockLockError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

function pidOf(events: readonly LockEvent[]): number {
  const acquired = events.filter((e) => e.type === "lock.acquired").at(-1);
  if (acquired?.type !== "lock.acquired") throw new Error("no lock.acquired event");
  return acquired.pid;
}

async function kill(pid: number): Promise<void> {
  await killBackend(adminSql, pid);
  await Bun.sleep(SETTLE_MS);
}

async function row(
  name: string,
  s = fenced,
): Promise<{ holder: string; heartbeat: string } | undefined> {
  const [r] = await adminSql.unsafe<{ holder: string; heartbeat: string }>(
    `SELECT holder::text AS holder, heartbeat_at::text AS heartbeat FROM "${s}".run_locks WHERE name = $1`,
    [name],
  );
  return r;
}

async function held(name: string): Promise<boolean> {
  return (await locksHeld(adminSql, [name])).get(name) === true;
}

describe("acquire against a real server", () => {
  test("R1: a second acquire refuses HELD; after release a third succeeds", async () => {
    const first = await take();
    expect((await refusal(take())).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    await first.release();
    const third = await take();
    expect((await row("alpha-sync"))?.holder).toBe(third.holder);
    await third.release();
  });

  test("R2: after a kill the gate recovers, the holder stays, and a tick moves heartbeat_at", async () => {
    const h = harness();
    const lock = await take("alpha-sync", slice(), h);
    await kill(pidOf(h.events));
    await lock.ensureExclusive();
    expect(h.events.map((e) => e.type)).toContain("lock.recovered");
    for (const e of h.events) {
      if (e.type === "lock.recovery_retrying") expect(e.error).toBeDefined();
    }
    expect(h.events.filter((e) => e.type === "lock.recovery_retrying").length).toBeLessThanOrEqual(
      1,
    );
    const before = await row("alpha-sync");
    expect(before?.holder).toBe(lock.holder);
    lock.startKeepalive();
    await Bun.sleep(20);
    h.tick();
    const deadline = Date.now() + 2_000;
    while ((await row("alpha-sync"))?.heartbeat === before?.heartbeat && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect((await row("alpha-sync"))?.heartbeat).not.toBe(before?.heartbeat);
    expect(h.events.map((e) => e.type)).not.toContain("lock.keepalive_failed");
    await lock.ensureExclusive();
    await lock.release();
    expect(await held("alpha-sync")).toBe(false);
  });

  test("R3: a competitor that took and released in the gap displaces the holder: LOST", async () => {
    const h = harness();
    const lock = await take("alpha-sync", slice(), h);
    await kill(pidOf(h.events));
    const competitor = await take();
    await competitor.release();
    const err = await refusal(lock.ensureExclusive());
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "lock.recovery_refused", reason: "displaced" }),
    );
    await lock.release();
    expect(await held("alpha-sync")).toBe(false);
  });

  test("R4: a competitor holding after the kill: recovery_refused held, LOST", async () => {
    const h = harness();
    const lock = await take("alpha-sync", slice(), h);
    await kill(pidOf(h.events));
    const competitor = await take();
    const err = await refusal(lock.ensureExclusive());
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "lock.recovery_refused", reason: "held" }),
    );
    await lock.release();
    expect(await held("alpha-sync")).toBe(true);
    await competitor.release();
  });

  test("R5: maxRecoveries 1, two kills: the second gate throws LOST after recovery_exhausted", async () => {
    const h = harness();
    const lock = await take("alpha-sync", slice({ maxRecoveries: 1 }), h);
    await kill(pidOf(h.events));
    await lock.ensureExclusive();
    const recovered = h.events.find((e) => e.type === "lock.recovered");
    if (recovered?.type !== "lock.recovered") throw new Error("not recovered");
    await kill(recovered.pid);
    expect((await refusal(lock.ensureExclusive())).code).toBe("ERR_ROOTSTOCK_LOCK_LOST");
    expect(h.events).toContainEqual({
      type: "lock.recovery_exhausted",
      name: "alpha-sync",
      recoveries: 1,
      max: 1,
    });
    await lock.release();
  });

  test("a gate right after a kill, with no settle, settles: recovered, LOST or UNVERIFIABLE", async () => {
    // C-S1: postgres.js wedges a statement sent in the same turn as an
    // ECONNRESET rejection. The gate rests after any rejection, so with no
    // settle here it must still answer, and within a bound.
    const BOUND_MS = 5_000;
    for (let i = 0; i < 5; i += 1) {
      const h = harness();
      const lock = await take("alpha-sync", slice(), h);
      await adminSql.unsafe("SELECT pg_terminate_backend($1)", [pidOf(h.events)]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        lock.ensureExclusive().then(
          () => "recovered",
          (err: unknown) => (err instanceof RootstockLockError ? err.code : String(err)),
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("wedged"), BOUND_MS);
        }),
      ]);
      clearTimeout(timer);
      expect(["recovered", "ERR_ROOTSTOCK_LOCK_LOST", "ERR_ROOTSTOCK_LOCK_UNVERIFIABLE"]).toContain(
        outcome,
      );
      if (outcome === "recovered") {
        expect(h.events.map((e) => e.type)).toContain("lock.recovered");
      }
      const releasedIn = Date.now();
      await lock.release();
      expect(Date.now() - releasedIn).toBeLessThan(BOUND_MS);
      taken.splice(taken.indexOf(lock), 1);
      expect(await held("alpha-sync")).toBe(false);
    }
  });

  test("R7: a pool of 2 posing as a session puts L1 and L2 on two backends: CONN", async () => {
    const s = slice();
    let l1Pid: number | undefined;
    const pooled = (): LockSession => {
      const base = open(s, 2)();
      const unsafe = async (q: string, p?: readonly unknown[]) => {
        const rows = await base.sql.unsafe(q, p);
        if (q === L1) {
          l1Pid = Number(rows[0]?.pid);
          // Hold L1's backend busy, so the fence goes to the other one.
          base.sql.unsafe("SELECT pg_sleep(5)").then(
            () => {},
            () => {},
          );
          await Bun.sleep(20);
        }
        return rows;
      };
      const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
        base.sql(strings, ...values);
      return { sql: Object.assign(tag, { unsafe }) as unknown as Sql, close: base.close };
    };
    try {
      const err = await refusal(acquireRunLock(pooled, s, "alpha-sync", harness().deps));
      expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_CONN");
      expect(err.expectedPid).toBe(l1Pid as number);
      expect(typeof err.actualPid).toBe("number");
      expect(err.actualPid).not.toBe(l1Pid as number);
    } finally {
      // L1's backend is still inside pg_sleep after the bounded close, so the
      // server keeps its lock until it notices; reap it rather than wait.
      if (l1Pid !== undefined) await killBackend(adminSql, l1Pid);
    }
    expect(await held("alpha-sync")).toBe(false);
  });

  test("R8: a missing fencing table refuses UNFENCED and closes the session", async () => {
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS rootstock_c_missing");
    const s = slice({}, "rootstock_c_missing");
    const err = await refusal(take("alpha-sync", s));
    expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_UNFENCED");
    expect(err.cause).toBeDefined();
    expect(await held("alpha-sync")).toBe(false);
  });

  test("R9: two rootstock schemas share the advisory key but keep their own fencing rows", async () => {
    const a = await migrated();
    const b = await migrated();
    const inA = await take("alpha-sync", slice({}, a));
    expect((await refusal(take("alpha-sync", slice({}, b)))).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
    const inB = await take("beta-sync", slice({}, b));
    expect((await row("alpha-sync", a))?.holder).toBe(inA.holder);
    expect((await row("beta-sync", b))?.holder).toBe(inB.holder);
    expect(await row("alpha-sync", b)).toBeUndefined();
    expect(await row("beta-sync", a)).toBeUndefined();
    await inA.release();
    await inB.release();
  });

  test("R10: the origin's acquire and rootstock's exclude each other in both orders", async () => {
    const origin = openRaw();
    try {
      await origin.sql.unsafe(`SET search_path TO "${fenced}"`);
      const [o] = await origin.sql.unsafe(ORIGIN_L1, ["alpha-sync"]);
      expect(o?.locked).toBe(true);
      await origin.sql.unsafe(ORIGIN_FENCE, ["alpha-sync", crypto.randomUUID()]);
      expect((await refusal(take())).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
      expect((await locksHeld(origin.sql, ["alpha-sync"])).get("alpha-sync")).toBe(true);
      expect(await held("alpha-sync")).toBe(true);
      await origin.sql.unsafe("SELECT pg_advisory_unlock(hashtext($1))", ["alpha-sync"]);

      const lock = await take();
      const [again] = await origin.sql.unsafe(ORIGIN_L1, ["alpha-sync"]);
      expect(again?.locked).toBe(false);
      expect((await locksHeld(origin.sql, ["alpha-sync"])).get("alpha-sync")).toBe(true);
      await lock.release();
      expect((await locksHeld(origin.sql, ["alpha-sync"])).get("alpha-sync")).toBe(false);
    } finally {
      await origin.end();
    }
  });

  test("R11: a run killed between L1 and L2, or after L2, does not block a re-run", async () => {
    const fence = tableStatements({ schema: fenced, name: "run_locks" }).fence;
    for (const fenceFirst of [false, true]) {
      const dead = openRaw();
      const stale = crypto.randomUUID();
      const [r] = await dead.sql.unsafe(L1, ["beta-sync"]);
      expect(r?.locked).toBe(true);
      if (fenceFirst) await dead.sql.unsafe(fence, ["beta-sync", stale]);
      await killBackend(adminSql, Number(r?.pid));
      await dead.end().catch(() => {});
      const lock = await take("beta-sync");
      const now = await row("beta-sync");
      expect(now?.holder).toBe(lock.holder);
      expect(now?.holder).not.toBe(stale);
      await lock.release();
    }
  });
});

describe("w4d §8.2: the keepalive reads its fencing row", () => {
  async function untilEvent(h: Harness, type: LockEvent["type"]): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!h.events.some((e) => e.type === type) && Date.now() < deadline) await Bun.sleep(10);
  }

  for (const how of ["deleted", "replaced"] as const) {
    test(`LB6: fence row ${how} while held → the next tick emits fence_missing; the next gate throws LOST`, async () => {
      const h = harness();
      const lock = await take("beta-sync", slice(), h);
      lock.startKeepalive();
      h.tick();
      await Bun.sleep(50);
      expect(h.events.map((e) => e.type)).not.toContain("lock.fence_missing");
      await adminSql.unsafe(
        how === "deleted"
          ? `DELETE FROM "${fenced}".run_locks WHERE name = $1`
          : `UPDATE "${fenced}".run_locks SET holder = gen_random_uuid() WHERE name = $1`,
        ["beta-sync"],
      );
      h.tick();
      await untilEvent(h, "lock.fence_missing");
      expect(h.events).toContainEqual({
        type: "lock.fence_missing",
        name: "beta-sync",
        holder: lock.holder,
      });
      const err = await refusal(lock.ensureExclusive());
      expect(err.code).toBe("ERR_ROOTSTOCK_LOCK_LOST");
      expect(h.events).toContainEqual({
        type: "lock.recovery_refused",
        name: "beta-sync",
        attempt: 1,
        reason: "displaced",
      });
      expect(await refusal(lock.ensureExclusive())).toBe(err);
      await lock.release();
      expect(await held("beta-sync")).toBe(false);
    });
  }
});

describe("probes", () => {
  test("R6: locksHeld sees only the one-key lock in this database, and agrees with the predicate", async () => {
    const predicate = async (name: string) => {
      const [r] = await adminSql.unsafe<{ held: boolean }>(
        `SELECT ${LOCK_HELD_PREDICATE} AS held`,
        [name],
      );
      return r?.held === true;
    };
    const both = async (expected: boolean) => {
      expect(await held("alpha-sync")).toBe(expected);
      expect(await predicate("alpha-sync")).toBe(expected);
    };

    const lock = await take();
    await both(true);
    await lock.release();
    await both(false);

    const side = openRaw();
    try {
      // The two halves of the one-key form's split of hashtext('alpha-sync').
      await side.sql.unsafe(
        `SELECT pg_advisory_lock(
           ((hashtext($1)::bigint >> 32) & 4294967295)::bit(32)::int,
           (hashtext($1)::bigint & 4294967295)::bit(32)::int)`,
        ["alpha-sync"],
      );
      const [k] = await adminSql.unsafe<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2
           AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
           AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
        ["alpha-sync"],
      );
      expect(k?.n).toBe(1);
      await both(false);
    } finally {
      await side.end();
    }

    const [exists] = await adminSql.unsafe("SELECT 1 FROM pg_database WHERE datname = $1", [
      OTHER_DB,
    ]);
    if (exists === undefined) await adminSql.unsafe(`CREATE DATABASE ${OTHER_DB}`);
    const other = postgres(otherDatabaseUrl(OTHER_DB), { max: 1, onnotice: () => {} });
    try {
      await other.unsafe("SELECT pg_advisory_lock(hashtext($1))", ["alpha-sync"]);
      const [there] = await other.unsafe(`SELECT ${LOCK_HELD_PREDICATE} AS held`, ["alpha-sync"]);
      expect(there?.held).toBe(true);
      await both(false);
    } finally {
      await other.end({ timeout: 1 });
    }
  });

  test("locksHeld: input order, each name once, no query for an empty list", async () => {
    const lock = await take("beta-sync");
    const map = await locksHeld(adminSql, ["beta-sync", "alpha-sync", "beta-sync"]);
    expect([...map]).toEqual([
      ["beta-sync", true],
      ["alpha-sync", false],
    ]);
    await lock.release();
    expect((await locksHeld(adminSql, [])).size).toBe(0);
  });

  test("R12: lockNameCollisions reports a colliding pair and no distinct names", async () => {
    // The pair was found once with:
    //   SELECT min(a), max(a) FROM (SELECT 'c' || i AS a, hashtext('c' || i) AS h
    //     FROM generate_series(1, 300000) i) x GROUP BY h HAVING count(*) > 1 LIMIT 1
    // (equivalent to the contract's self-join, and fast).
    const [h] = await adminSql.unsafe<{ a: number; b: number }>(
      "SELECT hashtext('c14100') AS a, hashtext('c180248') AS b",
    );
    expect(h?.a).toBe(h?.b);
    expect(
      await lockNameCollisions(adminSql, ["alpha-sync", "c14100", "beta-sync", "c180248"]),
    ).toEqual([["c14100", "c180248"]]);
    expect(await lockNameCollisions(adminSql, ["alpha-sync", "beta-sync", "alpha-sync"])).toEqual(
      [],
    );
    expect(await lockNameCollisions(adminSql, [])).toEqual([]);
  });
});
