import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import {
  killBackend,
  lockDriver,
  openBunSqlClient,
  openPostgresJsClient,
} from "../lock/fixtures.pg-support.ts";
import {
  acquireRunLock,
  bunSqlLockSession,
  type LockDeps,
  type LockSlice,
  lockSlice,
  locksHeld,
  postgresJsLockSession,
  type RunLock,
} from "../lock/index.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import type { RunsEvent } from "./events.ts";
import { runsInput } from "./fixtures.test-support.ts";
import { pruneRuns, type RunRow, runsSnapshot, startRun } from "./record.ts";
import { type RunsSlice, type RunsSliceInput, runsSlice } from "./slice.ts";

// R-D2 (contract §13.3): the run record against a real server and the real
// 0.7.0 lock, once per transactor kind, each case in a schema of its own
// with rootstock's migrations applied.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_rr");
const held: RunLock[] = [];
const ZERO = "00000000-0000-0000-0000-000000000000";
const SETTLE_MS = 50;

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

const lockDeps: LockDeps = {
  now: () => Date.now(),
  setInterval: () => {
    throw new Error("the run record suite starts no keepalive");
  },
  clearInterval: () => {},
  randomUUID: () => crypto.randomUUID(),
  sleep: (ms) => Bun.sleep(ms),
};

interface Env {
  sc: string;
  lock: LockSlice;
  runs: RunsSlice;
  R: string;
  L: string;
  events: RunsEvent[];
  deps: { now: () => number; randomUUID: () => string; onEvent: (e: RunsEvent) => void };
  acquire: (name: string) => Promise<RunLock>;
}

async function fresh(over: Partial<RunsSliceInput> = {}): Promise<Env> {
  const sc = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: sc }));
  const lock = lockSlice({
    table: { schema: sc },
    profile: "lock",
    names: ["alpha-sync", "beta-sync", "shared-write", "delta:*"],
    heartbeatSeconds: 5,
    probeStallSeconds: 10,
    maxRecoveries: 3,
    endTimeoutSeconds: 1,
    wait: { maxMs: 0, pollIntervalMs: 10 },
  });
  const events: RunsEvent[] = [];
  return {
    sc,
    lock,
    runs: runsSlice({ ...runsInput(), ...over }, { schema: sc }),
    R: `"${sc}".runs`,
    L: `"${sc}".run_locks`,
    events,
    deps: {
      now: () => Date.now(),
      randomUUID: () => crypto.randomUUID(),
      onEvent: (e) => events.push(e),
    },
    acquire: async (name) => {
      const run = await acquireRunLock(
        () =>
          lockDriver() === "bun-sql"
            ? bunSqlLockSession(openBunSqlClient(), lock)
            : postgresJsLockSession(openPostgresJsClient(), lock),
        lock,
        name,
        lockDeps,
      );
      held.push(run);
      return run;
    },
  };
}

interface Seed {
  id?: string;
  job: string;
  lockName: string;
  holder?: string;
  status?: string;
  daysAgo?: number;
  reason?: string | null;
}

/** Inserts a row directly, as a copied or crashed run would have left it. */
async function seed(env: Env, s: Seed): Promise<string> {
  const id = s.id ?? crypto.randomUUID();
  const status = s.status ?? "running";
  await sql.unsafe(
    `INSERT INTO ${env.R} (id, job, mode, status, lock_name, holder, started_at, finished_at, reason)
     VALUES ($1::uuid, $2, 'incremental', $3, $4, $5::uuid,
             clock_timestamp() - make_interval(days => $6::int),
             CASE WHEN $3 = 'running' THEN NULL
                  ELSE clock_timestamp() - make_interval(days => $6::int) + interval '1 minute' END,
             $7)`,
    [
      id,
      s.job,
      status,
      s.lockName,
      s.holder ?? crypto.randomUUID(),
      s.daysAgo ?? 0,
      s.reason ?? null,
    ],
  );
  return id;
}

async function rowOf(env: Env, id: string): Promise<Record<string, unknown> | undefined> {
  const [r] = await sql.unsafe(
    `SELECT status, reason, finished_at IS NULL AS open, holder::text AS holder FROM ${env.R} WHERE id = $1::uuid`,
    [id],
  );
  return r === undefined ? undefined : { ...r, open: r.open === true || r.open === "t" };
}

/** The backend pid holding the one-key advisory lock `name`, if any. */
async function holderPid(name: string): Promise<number | undefined> {
  const [r] = await sql.unsafe(
    `SELECT pid FROM pg_locks
     WHERE locktype = 'advisory' AND granted AND objsubid = 1
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
       AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
    [name],
  );
  return r === undefined ? undefined : Number(r.pid);
}

const ACC = { listed: 10, written: 4, unchanged: 3, quarantined: 2, excluded: 1 };

describe("record", () => {
  test("RD1: start → finish round trip; the row read back through R4 equals what was written", async () => {
    const env = await fresh();
    const lock = await env.acquire("alpha-sync");
    let after: RunRow | undefined;
    const run = await startRun(
      sql,
      env.runs,
      {
        job: "alpha-sync",
        mode: "backfill",
        lock,
        afterRun: (row) => {
          after = row;
        },
      },
      env.deps,
    );
    const during = (await runsSnapshot(sql, env.runs, ["alpha-sync"])).get("alpha-sync");
    expect(during?.total).toBe(1);
    expect(during?.newestSettled).toBeNull();
    expect(during?.running).toEqual([
      {
        id: run.id,
        job: "alpha-sync",
        mode: "backfill",
        status: "running",
        phase: null,
        lockName: "alpha-sync",
        holder: lock.holder,
        startedAt: run.startedAt,
        finishedAt: null,
        listed: null,
        written: null,
        unchanged: null,
        quarantined: null,
        excluded: null,
        reconciled: null,
        excludedReasons: {},
        counts: {},
        tokens: {},
        costUsd: null,
        costNote: null,
        scope: null,
        scopeExcluded: null,
        overrides: [],
        reason: null,
        live: true,
      },
    ]);
    run.count("seen", 10);
    run.count("archived", 2);
    run.meter("model-a", 1000, 2000, { estimated: true });
    run.account({ ...ACC, excludedReasons: { "too-big": 1 } });
    run.override("brake.alpha-archive");
    run.scope({ roots: ["a", "b"] }, ["c"]);
    const result = await run.finish("ok", { reason: "done", phase: "load" });
    expect(result).toEqual({
      written: true,
      status: "ok",
      reconciled: true,
      costUsd: "0.000900",
      costNote: "estimated",
    });
    const snap = (await runsSnapshot(sql, env.runs, ["alpha-sync"])).get("alpha-sync");
    const row = snap?.newestSettled as RunRow;
    expect(row).toEqual(after as RunRow);
    expect(snap?.newestOk).toEqual(row);
    expect(snap?.running).toEqual([]);
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect((row.finishedAt as Date).getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
    expect({ ...row, finishedAt: null }).toEqual({
      id: run.id,
      job: "alpha-sync",
      mode: "backfill",
      status: "ok",
      phase: "load",
      lockName: "alpha-sync",
      holder: lock.holder,
      startedAt: run.startedAt,
      finishedAt: null,
      listed: 10,
      written: 4,
      unchanged: 3,
      quarantined: 2,
      excluded: 1,
      reconciled: true,
      excludedReasons: { "too-big": 1 },
      counts: { seen: 10, archived: 2 },
      tokens: { "model-a": { input: 1000, output: 2000 } },
      costUsd: "0.000900",
      costNote: "estimated",
      scope: { roots: ["a", "b"] },
      scopeExcluded: ["c"],
      overrides: ["brake.alpha-archive"],
      reason: "done",
    });
    expect(env.events.map((e) => e.type)).toEqual(["runs.started", "runs.finished"]);
  });

  test("RD2: settle — other holders' running rows under the lock, in id-text order", async () => {
    const env = await fresh();
    const b = await seed(env, {
      id: "00000000-0000-4000-8000-00000000000b",
      job: "gamma-push",
      lockName: "shared-write",
      reason: "kept",
    });
    const a = await seed(env, {
      id: "00000000-0000-4000-8000-00000000000a",
      job: "beta-sync",
      lockName: "shared-write",
    });
    const other = await seed(env, { job: "alpha-sync", lockName: "alpha-sync" });
    const lock = await env.acquire("shared-write");
    const same = await seed(env, {
      job: "gamma-push",
      lockName: "shared-write",
      holder: lock.holder,
    });
    const run = await startRun(
      sql,
      env.runs,
      { job: "beta-sync", mode: "incremental", lock },
      env.deps,
    );
    expect(env.events).toEqual([
      { type: "runs.settled_interrupted", id: a, job: "beta-sync", by: run.id },
      { type: "runs.settled_interrupted", id: b, job: "gamma-push", by: run.id },
      {
        type: "runs.started",
        id: run.id,
        job: "beta-sync",
        mode: "incremental",
        lockName: "shared-write",
        settled: 2,
      },
    ]);
    expect(await rowOf(env, a)).toMatchObject({
      status: "interrupted",
      open: false,
      reason: `interrupted: still running when run ${run.id} took the shared-write lock`,
    });
    expect(await rowOf(env, b)).toMatchObject({
      status: "interrupted",
      open: false,
      reason: "kept",
    });
    expect(await rowOf(env, other)).toMatchObject({ status: "running", open: true });
    expect(await rowOf(env, same)).toMatchObject({ status: "running", open: true });
    expect(await rowOf(env, run.id)).toMatchObject({ status: "running", open: true });
  });

  test("RD3: live while the holder fences and holds; not live once killed or displaced", async () => {
    const env = await fresh();
    const first = await env.acquire("alpha-sync");
    const run = await startRun(
      sql,
      env.runs,
      { job: "alpha-sync", mode: "incremental", lock: first },
      env.deps,
    );
    const live = async () =>
      (await runsSnapshot(sql, env.runs, ["alpha-sync"]))
        .get("alpha-sync")
        ?.running.map((r) => [r.id, r.live]);
    expect(await live()).toEqual([[run.id, true]]);
    const pid = await holderPid("alpha-sync");
    expect(pid).toBeDefined();
    await killBackend(sql, pid as number);
    await Bun.sleep(SETTLE_MS);
    // The fence still names the holder, but nobody holds the advisory lock.
    const [fence] = await sql.unsafe(
      `SELECT holder::text AS holder FROM ${env.L} WHERE name = 'alpha-sync'`,
    );
    expect(fence?.holder).toBe(first.holder);
    expect(await live()).toEqual([[run.id, false]]);
    const second = await env.acquire("alpha-sync");
    expect((await locksHeld(sql, ["alpha-sync"])).get("alpha-sync")).toBe(true);
    expect(second.holder).not.toBe(first.holder);
    // Held again, but the fence names the new holder.
    expect(await live()).toEqual([[run.id, false]]);
  });

  test("RD4: kill -9 mid-run; the next start settles the child's row; the batch never commits", async () => {
    const env = await fresh();
    const child = Bun.spawn(
      ["bun", new URL("./record-child.pg-support.ts", import.meta.url).pathname, env.sc],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      },
    );
    const reader = child.stdout.getReader();
    let out = "";
    const deadline = Date.now() + 15_000;
    while (!out.includes("\n") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const match = /^ready ([0-9a-f-]{36})\n/.exec(out);
    if (match === null) {
      child.kill(9);
      throw new Error(`child did not start: ${out} ${await new Response(child.stderr).text()}`);
    }
    const childRun = match[1] as string;
    expect(await rowOf(env, childRun)).toMatchObject({ status: "running", open: true });
    child.kill(9);
    await child.exited;
    const released = Date.now() + 5_000;
    while ((await locksHeld(sql, ["alpha-sync"])).get("alpha-sync") === true) {
      if (Date.now() > released) throw new Error("the child's lock was never released");
      await Bun.sleep(20);
    }
    const lock = await env.acquire("alpha-sync");
    const run = await startRun(
      sql,
      env.runs,
      { job: "alpha-sync", mode: "incremental", lock },
      env.deps,
    );
    expect(env.events[0]).toEqual({
      type: "runs.settled_interrupted",
      id: childRun,
      job: "alpha-sync",
      by: run.id,
    });
    expect(await rowOf(env, childRun)).toMatchObject({
      status: "interrupted",
      open: false,
      reason: `interrupted: still running when run ${run.id} took the alpha-sync lock`,
    });
    const batch = await sql.unsafe(
      `SELECT 1 FROM "${env.sc}".quarantine WHERE external_id = 'child-batch'`,
    );
    expect(batch).toEqual([]);
  }, 30_000);

  test("RD5: finish after a successor settled the row → settled-elsewhere, row unchanged", async () => {
    const env = await fresh();
    const first = await env.acquire("alpha-sync");
    const run = await startRun(
      sql,
      env.runs,
      { job: "alpha-sync", mode: "incremental", lock: first },
      env.deps,
    );
    await first.release();
    const second = await env.acquire("alpha-sync");
    const next = await startRun(
      sql,
      env.runs,
      { job: "alpha-sync", mode: "incremental", lock: second },
      env.deps,
    );
    const before = await rowOf(env, run.id);
    run.account(ACC);
    expect(await run.finish("ok")).toEqual({ written: false, why: "settled-elsewhere" });
    expect(env.events.at(-1)).toEqual({
      type: "runs.settled_elsewhere",
      id: run.id,
      job: "alpha-sync",
    });
    expect(await rowOf(env, run.id)).toEqual(before as Record<string, unknown>);
    expect(before).toMatchObject({
      status: "interrupted",
      reason: `interrupted: still running when run ${next.id} took the alpha-sync lock`,
    });
    // The successor's own discard still works.
    expect(await next.discard()).toEqual({ written: false, why: "discarded" });
  });

  test("RD6: prune keeps running rows, each job's newest ok and newest settled", async () => {
    const env = await fresh({ retention: { keepDays: 7 } });
    const A = (s: Partial<Seed>) => seed(env, { job: "alpha-sync", lockName: "alpha-sync", ...s });
    const B = (s: Partial<Seed>) => seed(env, { job: "beta-sync", lockName: "shared-write", ...s });
    const G = (s: Partial<Seed>) =>
      seed(env, { job: "gamma-push", lockName: "shared-write", ...s });
    const aOk1 = await A({ status: "ok", daysAgo: 30 });
    const aOk2 = await A({ status: "ok", daysAgo: 20 });
    const aFailed = await A({ status: "failed", daysAgo: 10 });
    const aRunning = await A({ status: "running", daysAgo: 40 });
    const aRecent = await A({ status: "ok", daysAgo: 1 });
    const bOk = await B({ status: "ok", daysAgo: 30 });
    const bFailedOld = await B({ status: "failed", daysAgo: 20 });
    const bFailedNew = await B({ status: "failed", daysAgo: 15 });
    const gFailed = await G({ status: "failed", daysAgo: 30 });
    const gInterrupted = await G({ status: "interrupted", daysAgo: 20 });
    expect(await pruneRuns(sql, env.runs, env.deps)).toBe(5);
    expect(env.events).toEqual([{ type: "runs.pruned", deleted: 5 }]);
    const left = (await sql.unsafe(`SELECT id::text AS id FROM ${env.R}`)).map((r) => r.id);
    expect(new Set(left)).toEqual(new Set([aRunning, aRecent, bOk, bFailedNew, gInterrupted]));
    for (const gone of [aOk1, aOk2, aFailed, bFailedOld, gFailed]) expect(left).not.toContain(gone);
    expect(await pruneRuns(sql, env.runs)).toBe(0);
  });

  test("RD7: NOTABLE on a missing runs table, and on a missing lock table", async () => {
    const env = await fresh({ table: { name: "runs_missing" } });
    const text = (t: string) =>
      `rootstock runs: ${env.sc}.${t} does not exist — run the migrations (the table ships with rootstock 0.8.0, or is your own)`;
    const lock = await env.acquire("alpha-sync");
    const start = (runs: RunsSlice) =>
      startRun(sql, runs, { job: "alpha-sync", mode: "incremental", lock }, env.deps);
    for (const mk of [
      () => start(env.runs),
      () => runsSnapshot(sql, env.runs, ["alpha-sync"]),
      () => pruneRuns(sql, env.runs),
    ]) {
      const err = (await mk().then(
        () => {
          throw new Error("expected NOTABLE");
        },
        (e: unknown) => e,
      )) as { code: string; message: string };
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
      expect(err.message).toBe(text("runs_missing"));
    }
    const noLocks = runsSlice(
      { ...runsInput(), lockTable: { name: "locks_missing" } },
      { schema: env.sc },
    );
    for (const mk of [() => start(noLocks), () => runsSnapshot(sql, noLocks, ["alpha-sync"])]) {
      const err = (await mk().then(
        () => {
          throw new Error("expected NOTABLE");
        },
        (e: unknown) => e,
      )) as { code: string; message: string };
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
      expect(err.message).toBe(text("locks_missing"));
    }
    // A refusal never touches the lock: it is still held.
    expect(await holderPid("alpha-sync")).toBeDefined();
  });

  test("RD8: cost_usd 123456.789012 round-trips as the same string", async () => {
    const env = await fresh({
      prices: { "model-a": { inputPerMTok: 10_000, outputPerMTok: 1 } },
    });
    const lock = await env.acquire("shared-write");
    const run = await startRun(sql, env.runs, { job: "gamma-push", mode: "push", lock }, env.deps);
    run.meter("model-a", 12_345_678, 9_012);
    expect(await run.finish("ok")).toMatchObject({ costUsd: "123456.789012" });
    const snap = (await runsSnapshot(sql, env.runs, ["gamma-push"])).get("gamma-push");
    expect(snap?.newestOk?.costUsd).toBe("123456.789012");
    const [raw] = await sql.unsafe(`SELECT cost_usd::text AS c FROM ${env.R} WHERE id = $1::uuid`, [
      run.id,
    ]);
    expect(raw?.c).toBe("123456.789012");
  });

  test("RD9: the fence is rewritten between the gate and R1 → FENCE; nothing settled or inserted", async () => {
    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    const second = crypto.randomUUID();
    const theirs = await seed(env, { job: "alpha-sync", lockName: "alpha-sync", holder: second });
    const lock: RunLock = {
      name: real.name,
      holder: real.holder,
      ensureExclusive: async () => {
        await real.ensureExclusive();
        await sql.unsafe(`UPDATE ${env.L} SET holder = $1::uuid WHERE name = 'alpha-sync'`, [
          second,
        ]);
      },
      startKeepalive: () => real.startKeepalive(),
      stopKeepalive: () => real.stopKeepalive(),
      release: () => real.release(),
    };
    const err = (await startRun(
      sql,
      env.runs,
      { job: "alpha-sync", mode: "incremental", lock },
      env.deps,
    ).then(
      () => {
        throw new Error("expected FENCE");
      },
      (e: unknown) => e,
    )) as { code: string };
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_FENCE");
    expect(env.events).toEqual([
      { type: "runs.refused", job: "alpha-sync", code: "ERR_ROOTSTOCK_RUNS_FENCE" },
    ]);
    expect(await rowOf(env, theirs)).toMatchObject({ status: "running", open: true, reason: null });
    const [n] = await sql.unsafe(`SELECT count(*)::text AS n FROM ${env.R}`);
    expect(n?.n).toBe("1");
  });

  test("RD10: a copied history row (zero holder) is never live and never settled", async () => {
    const env = await fresh();
    const history = await seed(env, {
      job: "alpha-sync",
      lockName: "alpha-sync",
      holder: ZERO,
      status: "ok",
      daysAgo: 2,
    });
    const copiedRunning = await seed(env, {
      job: "beta-sync",
      lockName: "shared-write",
      holder: ZERO,
      status: "running",
    });
    // shared-write is held and fenced by a live holder; the zero holder is still not live.
    await env.acquire("shared-write");
    const beta = (await runsSnapshot(sql, env.runs, ["beta-sync"])).get("beta-sync");
    expect(beta?.running.map((r) => [r.id, r.live])).toEqual([[copiedRunning, false]]);
    const before = (await runsSnapshot(sql, env.runs, ["alpha-sync"])).get("alpha-sync")?.newestOk;
    expect(before?.id).toBe(history);
    const lock = await env.acquire("alpha-sync");
    const run = await startRun(
      sql,
      env.runs,
      { job: "alpha-sync", mode: "incremental", lock },
      env.deps,
    );
    expect(env.events.map((e) => e.type)).toEqual(["runs.started"]);
    const after = (await runsSnapshot(sql, env.runs, ["alpha-sync"])).get("alpha-sync");
    expect(after?.newestOk).toEqual(before as RunRow);
    expect(after?.running.map((r) => [r.id, r.live])).toEqual([[run.id, true]]);
  });
});
