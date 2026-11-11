import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgCode, type Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { quoteTable } from "../internal/slice.ts";
import {
  lockDriver,
  openBunSqlClient,
  openPostgresJsClient,
  openRaw,
  rawSql,
  testUrl,
} from "../lock/fixtures.pg-support.ts";
import {
  acquireRunLock,
  createTurnQueue,
  LOCK_HELD_PREDICATE,
  type LockDeps,
  type LockEvent,
  type LockSlice,
  lockSlice,
  RootstockLockError,
} from "../lock/index.ts";
import { startStallProxy } from "../lock/proxy.pg-support.ts";
import { bunSqlLockSession, postgresJsLockSession } from "../lock/session.ts";
import { L1, tableStatements } from "../lock/statements.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";

// D-S1 (contract §14): the run-record hypotheses H1–H4, and H8 and H9, measured
// with raw SQL before the record exists: R1 is §3.3's frozen text, LIVE is
// R4's `live` expression (§3.4) over the same tables. The bounds are about
// twice what was measured locally.

const driver = lockDriver();
let main: TestTransactor;
let admin: TestTransactor;
let adminSql: Sql;
const { schema, dropAll } = schemaFactory("rs_spk");
let s: string;
let R: string;
let L: string;
let Q: string;
let fence: string;
let slice: LockSlice;

const r1 = (r: string, l: string) => `WITH fence AS (
  SELECT 1 AS ok FROM ${l} l WHERE l.name = $4::text AND l.holder = $5::uuid
),
settled AS (
  UPDATE ${r} SET status = 'interrupted', finished_at = clock_timestamp(),
    reason = coalesce(reason, 'interrupted: still running when run ' || $1::text || ' took the ' || $4::text || ' lock')
  WHERE lock_name = $4::text AND status = 'running' AND holder <> $5::uuid
    AND EXISTS (SELECT 1 FROM fence)
  RETURNING id::text AS id, job
),
ins AS (
  INSERT INTO ${r} (id, job, mode, status, lock_name, holder, started_at)
  SELECT $1::uuid, $2::text, $3::text, 'running', $4::text, $5::uuid, clock_timestamp()
  WHERE EXISTS (SELECT 1 FROM fence)
  RETURNING floor(extract(epoch FROM started_at) * 1000)::text AS started_at_ms
)
SELECT EXISTS (SELECT 1 FROM ins) AS inserted,
       (SELECT started_at_ms FROM ins) AS started_at_ms,
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'job', job) ORDER BY id) FROM settled),
                '[]'::jsonb)::text AS settled`;

const live = (r: string, l: string) => `SELECT r.id::text AS id, r.status,
  (EXISTS (SELECT 1 FROM ${l} l WHERE l.name = r.lock_name AND l.holder = r.holder)
   AND ${LOCK_HELD_PREDICATE.replaceAll("$1", "r.lock_name")}) AS live
FROM ${r} r WHERE r.id = $1::uuid`;

/** C's Q2 with §9.3's claim_token clause, and claim_token added to what it returns. */
const q2 = (t: string) => `WITH candidates AS (
  SELECT key, claimed_at AS prev_claimed_at, claimed_by AS prev_claimed_by
  FROM ${t}
  WHERE source = $1
    AND dead_at IS NULL
    AND not_before <= clock_timestamp()
    AND (claimed_at IS NULL
         OR claimed_at < clock_timestamp() - make_interval(mins => $2::int))
  ORDER BY not_before
  LIMIT $3::int
  FOR UPDATE SKIP LOCKED
),
taken AS (
  UPDATE ${t} q SET
    attempts = q.attempts + CASE WHEN c.prev_claimed_at IS NULL THEN 0 ELSE 1 END,
    last_error = CASE WHEN c.prev_claimed_at IS NULL THEN q.last_error
                      ELSE coalesce(q.last_error, $4::text) END,
    dead_at = CASE WHEN c.prev_claimed_at IS NOT NULL
                    AND q.attempts + 1 >= $5::int
                   THEN clock_timestamp() ELSE q.dead_at END,
    claimed_at = CASE WHEN c.prev_claimed_at IS NOT NULL
                       AND q.attempts + 1 >= $5::int
                      THEN NULL ELSE clock_timestamp() END,
    claimed_by = CASE WHEN c.prev_claimed_at IS NOT NULL
                       AND q.attempts + 1 >= $5::int
                      THEN NULL ELSE $6::text END,
    claim_token = CASE WHEN c.prev_claimed_at IS NOT NULL
                        AND q.attempts + 1 >= $5::int
                       THEN NULL ELSE gen_random_uuid() END
  FROM candidates c
  WHERE q.key = c.key
  RETURNING q.key, q.claim_token
)
SELECT key, claim_token::text AS claim_token FROM taken ORDER BY key`;

const truthy = (v: unknown) => v === true || v === "t" || v === "true";

/** R1 for `holder` under `name`, as `{ inserted, settled }`. */
async function start(sql: Sql, id: string, name: string, holder: string) {
  const [row] = await sql.unsafe(r1(R, L), [id, "alpha-sync", "incremental", name, holder]);
  return {
    inserted: truthy(row?.inserted),
    settled: JSON.parse(String(row?.settled)) as { id: string; job: string }[],
  };
}

async function liveOf(id: string): Promise<{ status: string; live: boolean }> {
  const [row] = await adminSql.unsafe(live(R, L), [id]);
  return { status: String(row?.status), live: truthy(row?.live) };
}

async function held(name: string): Promise<boolean> {
  const [row] = await adminSql.unsafe(`SELECT ${LOCK_HELD_PREDICATE} AS held`, [name]);
  return truthy(row?.held);
}

async function alive(pid: number): Promise<boolean> {
  const rows = await adminSql.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
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

/** A raw session that takes `name`, fences `holder` and starts run `id`: what a run does before its work. */
async function holdAndStart(sql: Sql, name: string, holder: string, id: string) {
  const [l1] = await sql.unsafe(L1, [name]);
  expect(truthy(l1?.locked)).toBe(true);
  await sql.unsafe(fence, [name, holder]);
  expect((await start(sql, id, name, holder)).inserted).toBe(true);
  return Number(l1?.pid);
}

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  main = openTestTransactor();
  admin = openSecond();
  adminSql = admin.transactor.sql;
  s = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
  R = quoteTable({ schema: s, name: "runs" });
  L = quoteTable({ schema: s, name: "run_locks" });
  Q = quoteTable({ schema: s, name: "work_queue" });
  fence = tableStatements({ schema: s, name: "run_locks" }).fence;
  slice = lockSlice({
    table: { schema: s },
    profile: "lock",
    names: ["alpha-sync", "beta-sync", "shared-write"],
    heartbeatSeconds: 5,
    probeStallSeconds: 6,
    maxRecoveries: 3,
    endTimeoutSeconds: 1,
    wait: { maxMs: 10_000, pollIntervalMs: 50 },
  });
});

afterAll(async () => {
  await dropAll(main.transactor.sql);
  await admin.close();
  await main.close();
});

describe("D-S1 run-record hypotheses (§14)", () => {
  // H1 is false as worded: pg_terminate_backend(pid) only signals, so the
  // next statement can still see the dying backend's lock (locally from 0 to
  // 74 rounds in 200, depending on the reading driver). The row reads not-live
  // within a few ms, and always once the backend has left pg_stat_activity;
  // pg_terminate_backend(pid, timeout) waits for that exit (the next case).
  test("H1: after pg_terminate_backend of the holder, the row reads not-live once the backend is gone, within 100 ms", async () => {
    for (let i = 0; i < 20; i += 1) {
      const holder = openRaw();
      const id = uuid();
      try {
        const pid = await holdAndStart(holder.sql, "alpha-sync", uuid(), id);
        expect(await liveOf(id)).toEqual({ status: "running", live: true });
        const terminated = performance.now();
        await adminSql.unsafe("SELECT pg_terminate_backend($1)", [pid]);
        const notLiveMs = await msUntil(async () => !(await liveOf(id)).live, terminated, 5_000);
        expect(notLiveMs).toBeLessThan(100);
        await msUntil(async () => !(await alive(pid)), terminated, 5_000);
        expect(await liveOf(id)).toEqual({ status: "running", live: false });
      } finally {
        await holder.end().catch(() => {});
      }
    }
  });

  test("H1: with pg_terminate_backend's wait form, the very next statement reads not-live", async () => {
    for (let i = 0; i < 10; i += 1) {
      const holder = openRaw();
      const id = uuid();
      try {
        const pid = await holdAndStart(holder.sql, "alpha-sync", uuid(), id);
        const [t] = await adminSql.unsafe("SELECT pg_terminate_backend($1, 5000) AS ok", [pid]);
        expect(truthy(t?.ok)).toBe(true);
        expect(await liveOf(id)).toEqual({ status: "running", live: false });
      } finally {
        await holder.end().catch(() => {});
      }
    }
  });

  test("H2: after kill -9 of the holder's process, the server drops its backend and the lock within 1 s, and the next start settles its row", async () => {
    const holder = uuid();
    const id = uuid();
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./spike-child.pg-support.ts", import.meta.url).pathname,
        driver,
        s,
        "beta-sync",
        holder,
        id,
      ],
      {
        env: { ...process.env, ROOTSTOCK_TEST_DATABASE_URL: testUrl() },
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    try {
      const reader = child.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      const { locked, pid } = JSON.parse(text) as { locked: unknown; pid: number };
      expect(truthy(locked)).toBe(true);
      expect(await liveOf(id)).toEqual({ status: "running", live: true });
      const killed = performance.now();
      child.kill(9);
      const freedMs = await msUntil(async () => !(await held("beta-sync")), killed, 10_000);
      const goneMs = await msUntil(async () => !(await alive(pid)), killed, 10_000);
      expect(freedMs).toBeLessThan(1_000);
      expect(goneMs).toBeLessThan(1_000);
      expect(await liveOf(id)).toEqual({ status: "running", live: false });
      const next = openRaw();
      try {
        const [l1] = await next.sql.unsafe(L1, ["beta-sync"]);
        expect(truthy(l1?.locked)).toBe(true);
        const successor = uuid();
        await next.sql.unsafe(fence, ["beta-sync", successor]);
        const started = await start(next.sql, uuid(), "beta-sync", successor);
        expect(started).toEqual({ inserted: true, settled: [{ id, job: "alpha-sync" }] });
        expect((await liveOf(id)).status).toBe("interrupted");
      } finally {
        await next.end();
      }
    } finally {
      child.kill(9);
      await child.exited;
    }
  });

  test("H3: a black-holed holder keeps the lock until the proxy closes; its row reads live meanwhile, and no successor can start", async () => {
    const proxy = startStallProxy();
    const client =
      driver === "bun-sql" ? openBunSqlClient(1, proxy.url) : openPostgresJsClient(1, proxy.url);
    const sql = rawSql(client);
    const id = uuid();
    try {
      const pid = await holdAndStart(sql, "shared-write", uuid(), id);
      proxy.freeze({ forwardClose: false });
      const other = openRaw();
      try {
        const frozen = performance.now();
        while (performance.now() - frozen < 2_000) {
          expect(await held("shared-write")).toBe(true);
          expect(await liveOf(id)).toEqual({ status: "running", live: true });
          const [l1] = await other.sql.unsafe(L1, ["shared-write"]);
          expect(truthy(l1?.locked)).toBe(false);
          // A would-be successor that never fenced starts nothing and settles nothing.
          expect(await start(other.sql, uuid(), "shared-write", uuid())).toEqual({
            inserted: false,
            settled: [],
          });
          await Bun.sleep(200);
        }
        expect(await alive(pid)).toBe(true);
        const stopped = performance.now();
        proxy.stop();
        const freedMs = await msUntil(async () => !(await held("shared-write")), stopped, 5_000);
        expect(freedMs).toBeLessThan(1_000);
        expect(await liveOf(id)).toEqual({ status: "running", live: false });
      } finally {
        await other.end();
      }
    } finally {
      proxy.stop();
      await (driver === "bun-sql"
        ? (client as ReturnType<typeof openBunSqlClient>).close({ timeout: 0 })
        : (client as ReturnType<typeof openPostgresJsClient>).end({ timeout: 0 })
      ).catch(() => {});
    }
  }, 30_000);

  test("H4: in a rolling-deploy overlap, a waiting second process never settles the first's row", async () => {
    const open = () =>
      driver === "bun-sql"
        ? bunSqlLockSession(openBunSqlClient(1), slice)
        : postgresJsLockSession(openPostgresJsClient(1), slice);
    const events: LockEvent[] = [];
    const first = await acquireRunLock(open, slice, "shared-write", lockDeps(events));
    const firstRun = uuid();
    try {
      expect((await start(adminSql, firstRun, "shared-write", first.holder)).inserted).toBe(true);
      // The second process waits and times out: the first's row is never touched.
      const waiting = acquireRunLock(open, slice, "shared-write", lockDeps(events), {
        wait: { mode: "poll", ms: 600, turns: createTurnQueue() },
      }).then(
        () => null,
        (e: unknown) => e,
      );
      const err = await waiting;
      expect(err).toBeInstanceOf(RootstockLockError);
      expect((err as RootstockLockError).code).toBe("ERR_ROOTSTOCK_LOCK_HELD");
      expect(await liveOf(firstRun)).toEqual({ status: "running", live: true });
      // It waits again; the first finishes its row and releases; the second starts and settles nothing.
      const second = acquireRunLock(open, slice, "shared-write", lockDeps(events), {
        wait: { mode: "poll", ms: 5_000, turns: createTurnQueue() },
      });
      await Bun.sleep(300);
      expect(await liveOf(firstRun)).toEqual({ status: "running", live: true });
      await adminSql.unsafe(
        `UPDATE ${R} SET status = 'ok', finished_at = clock_timestamp() WHERE id = $1::uuid AND holder = $2::uuid`,
        [firstRun, first.holder],
      );
      await first.release();
      const lock = await second;
      try {
        expect(await start(adminSql, uuid(), "shared-write", lock.holder)).toEqual({
          inserted: true,
          settled: [],
        });
        expect((await liveOf(firstRun)).status).toBe("ok");
      } finally {
        await lock.release();
      }
    } finally {
      await first.release();
    }
  }, 30_000);

  test("H8 (for D2): a write inside SET TRANSACTION READ ONLY raises 25006 through the transactor, and savepoints work inside it", async () => {
    const id = uuid();
    const insert = `INSERT INTO ${R} (id, job, mode, status, lock_name, holder) VALUES ($1::uuid, 'alpha-sync', 'manual', 'running', 'alpha-sync', $1::uuid)`;
    const inside = await main.transactor.begin(async (tx) => {
      await tx.unsafe("SET TRANSACTION READ ONLY");
      const [ro] = await tx.unsafe("SELECT current_setting('transaction_read_only') AS ro");
      const read = await tx.savepoint(async (sp) => {
        const nested = await sp.savepoint(async (inner) => inner.unsafe("SELECT 2 AS two"));
        return [...(await sp.unsafe("SELECT 1 AS one")), ...nested];
      });
      const write = await tx
        .savepoint(async (sp) => sp.unsafe(insert, [id]))
        .then(
          () => "wrote",
          (e: unknown) => pgCode(e),
        );
      const after = await tx.unsafe("SELECT 3 AS three");
      return { ro: ro?.ro, read, write, after };
    });
    expect(inside).toEqual({
      ro: "on",
      read: [{ one: 1 }, { two: 2 }],
      write: "25006",
      after: [{ three: 3 }],
    });
    const direct = await main.transactor
      .begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY");
        await tx.unsafe(insert, [id]);
      })
      .then(
        () => "committed",
        (e: unknown) => pgCode(e),
      );
    expect(direct).toBe("25006");
    expect(await adminSql.unsafe(`SELECT 1 FROM ${R} WHERE id = $1::uuid`, [id])).toEqual([]);
  });

  test("H9: gen_random_uuid() in Q2's UPDATE gives a distinct token per row in one statement", async () => {
    await adminSql.unsafe(
      `INSERT INTO ${Q} (key, source, kind) SELECT 'alpha:' || i, 'alpha', 'put' FROM generate_series(1, 50) AS i`,
    );
    const first = await adminSql.unsafe(q2(Q), ["alpha", 30, 50, "expired", 5, "worker-a"]);
    expect(first).toHaveLength(50);
    const firstTokens = new Set(first.map((r) => String(r.claim_token)));
    expect(firstTokens.size).toBe(50);
    // A reclaim of every expired claim (timeout 0 minutes) mints 50 new distinct tokens.
    const again = await adminSql.unsafe(q2(Q), ["alpha", 0, 50, "expired", 5, "worker-b"]);
    const againTokens = new Set(again.map((r) => String(r.claim_token)));
    expect(againTokens.size).toBe(50);
    expect([...againTokens].filter((t) => firstTokens.has(t))).toEqual([]);
  });
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
