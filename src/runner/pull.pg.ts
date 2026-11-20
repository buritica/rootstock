import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { locksHeld, type RunLock } from "../lock/index.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { consecutiveBreaker } from "../runs/index.ts";
import { runnerErrorCode } from "./errors.ts";
import {
  cursorOf,
  docs,
  killLock,
  type MemSource,
  memSource,
  QuotaError,
  quarantineRows,
  type Rec,
  type RunnerEnv,
  runnerEnv,
  runRows,
} from "./fixtures.pg-support.ts";
import { planPull, runPull } from "./pull.ts";
import type { BeforeSettleContext, PullArgs, PullFailure, PullReport } from "./types.ts";

// R-D10 (contract §9): the pull runner against a real server, once per
// transactor kind, each case in a schema of its own with rootstock's
// migrations applied, on the real lock and run record.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_pull");
const held: RunLock[] = [];

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

const fresh = (): Promise<RunnerEnv> => runnerEnv(main.transactor, schema(), held);

async function pull(
  env: RunnerEnv,
  source: MemSource,
  over: Record<string, unknown> & { lock?: RunLock; since?: Date } = {},
): Promise<PullReport> {
  const own = over.lock === undefined;
  const lock = over.lock ?? (await env.acquire(source.job));
  try {
    return await runPull(
      {
        tx: main.transactor,
        runs: env.runs,
        quarantine: env.quarantine,
        cursors: env.cursors,
        source,
        mode: over.since ? "backfill" : "incremental",
        lock,
        batchSize: 2,
        fetchConcurrency: 1,
        ...over,
      } as unknown as PullArgs<never, never, unknown>,
      env.deps,
    );
  } finally {
    if (own) await lock.release();
  }
}

/** `real` with `before` awaited ahead of each of its gates. */
const gatedLock = (real: RunLock, before: () => Promise<void> | void): RunLock => ({
  name: real.name,
  holder: real.holder,
  ensureExclusive: async () => {
    await before();
    await real.ensureExclusive();
  },
  startKeepalive: () => real.startKeepalive(),
  stopKeepalive: () => real.stopKeepalive(),
  release: () => real.release(),
});

const recs = (n: number, extra: Partial<Rec> = {}): Rec[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, hash: `h${i + 1}`, ...extra }));

describe("RD1 a clean run", () => {
  test("two batches: rows, cursor, an ok run with buckets and counters", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, recs(3), {
      excluded: [{ reason: "out", count: 2 }],
    });
    const report = await pull(env, src);
    expect(report).toMatchObject({
      status: "ok",
      listed: 5,
      fetched: 3,
      written: 3,
      unchanged: 0,
      quarantined: 0,
      excluded: 2,
      repointed: 0,
      excludedReasons: [{ reason: "out", count: 2 }],
    });
    expect(await docs(sql, env)).toEqual(["r1", "r2", "r3"]);
    expect(await cursorOf(sql, env)).toBe(3);
    const [row] = await runRows(sql, env);
    expect(row).toMatchObject({
      status: "ok",
      listed: 5,
      written: 3,
      excluded: 2,
      reconciled: true,
    });
    expect(JSON.parse(String(row?.counts))).toEqual({ fetched: 3, repointed: 0 });
    expect(env.events.filter((e) => e.type === "runner.batch_committed")).toHaveLength(2);
  });

  test("RP2 a second run skips unchanged before fetching, and after fetching when only fetch knows the hash", async () => {
    const env = await fresh();
    const rs: Rec[] = [
      { id: "a", hash: "1" },
      { id: "b", hash: "2", hashAfterFetch: true },
    ];
    await pull(env, memSource(env, main.transactor, rs));
    const src = memSource(env, main.transactor, rs);
    const report = await pull(env, src);
    expect(report).toMatchObject({ status: "ok", listed: 2, unchanged: 2, written: 0, fetched: 1 });
    expect(src.fetches).toEqual(["b"]);
  });
});

describe("RP2 each branch counts", () => {
  test("fetch failure, wrong id and load failure quarantine; identity holds", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, [
      { id: "ok", hash: "1" },
      { id: "ff", hash: "2", failFetch: true },
      { id: "wi", hash: "3", wrongId: true },
      { id: "lf", hash: "4", failLoad: true },
    ]);
    const report = await pull(env, src, { batchSize: 10 });
    expect(report).toMatchObject({
      status: "ok",
      listed: 4,
      written: 1,
      quarantined: 3,
      fetched: 2,
    });
    const q = await quarantineRows(sql, env);
    expect(q.map((r) => [r.external_id, r.status])).toEqual([
      ["ff", "pending"],
      ["lf", "pending"],
      ["wi", "pending"],
    ]);
    expect(q.find((r) => r.external_id === "wi")?.reason).toBe(
      "fetched a doc for a different externalId: asked for wi, got wi-other",
    );
  });
});

describe("RP3 run-scoped duplicates", () => {
  test("a repeat in a later batch counts quarantined with no row and is never fetched", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, [
      { id: "d", hash: "1" },
      { id: "x", hash: "2" },
      { id: "d", hash: "1" },
    ]);
    const report = await pull(env, src);
    expect(report).toMatchObject({ status: "ok", listed: 3, written: 2, quarantined: 1 });
    expect(await quarantineRows(sql, env)).toEqual([]);
    // The repeat in the later batch was never fetched.
    expect(src.fetches).toEqual(["d", "x"]);
  });

  test("an in-batch repeat after a success is quarantined with no row (fetched once per occurrence, C2)", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, [
      { id: "d", hash: "1" },
      { id: "d", hash: "1" },
    ]);
    const report = await pull(env, src, { batchSize: 5 });
    expect(report).toMatchObject({
      status: "ok",
      listed: 2,
      written: 1,
      quarantined: 1,
      fetched: 1,
    });
    expect(src.fetches).toEqual(["d", "d"]);
    expect(await quarantineRows(sql, env)).toEqual([]);
  });
});

describe("RP4/RP7 options and texts", () => {
  test("a bad batchSize settles failed with rootstock's text", async () => {
    const env = await fresh();
    const report = await pull(env, memSource(env, main.transactor, recs(1)), { batchSize: 0 });
    expect(report.status).toBe("failed");
    expect(report.failure).toEqual({ kind: "options", field: "batchSize", value: 0 });
    const [row] = await runRows(sql, env);
    expect(row?.status).toBe("failed");
    expect(String(row?.reason)).toContain(
      "rootstock runner: batchSize must be an integer in 1–10000, got 0",
    );
  });

  test("RP8 reasonOf renders every failure", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, recs(1));
    src.list = async () => {
      throw new Error("listing down");
    };
    const report = await pull(env, src, { reasonOf: (f: PullFailure) => `mine: ${f.kind}` });
    expect(report.failure?.kind).toBe("list");
    const [row] = await runRows(sql, env);
    expect(row?.reason).toBe("mine: list");
  });
});

describe("RP5 refusals write nothing", () => {
  test("a backfill on a source without boundedBackfill refuses BACKFILL before any row", async () => {
    const env = await fresh();
    let err: unknown;
    try {
      await pull(env, memSource(env, main.transactor, recs(1)), { since: new Date(0) });
    } catch (e) {
      err = e;
    }
    expect(runnerErrorCode(err)).toBe("ERR_ROOTSTOCK_RUNNER_BACKFILL");
    expect(await runRows(sql, env)).toEqual([]);
  });
});

describe("RP12 backfill", () => {
  test("never reads or writes the cursor", async () => {
    const env = await fresh();
    await sql.unsafe(`INSERT INTO ${env.C} (name, value) VALUES ('alpha-sync', '7'::jsonb)`);
    const calls: { cursor: unknown; since: Date | undefined }[] = [];
    const src = memSource(env, main.transactor, recs(2), {
      boundedBackfill: true,
      listCalls: calls,
    });
    const report = await pull(env, src, { since: new Date(1000) });
    expect(report.status).toBe("ok");
    expect(calls).toEqual([{ cursor: undefined, since: new Date(1000) }]);
    expect(await cursorOf(sql, env)).toBe(7);
  });
});

describe("RP11 empty listing", () => {
  test("lands nextCursor, and not on a backfill", async () => {
    const env = await fresh();
    await pull(env, memSource(env, main.transactor, [], { nextCursor: { at: 9 } }));
    expect(await cursorOf(sql, env)).toEqual({ at: 9 });
  });
});

describe("RP6/RD6 quota breaker", () => {
  test("F6: a trip commits through the tripping ref and stops the run", async () => {
    const env = await fresh();
    const rs: Rec[] = [
      { id: "a", hash: "1" },
      { id: "b", hash: "2" },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, hash: `${i}`, quota: true })),
      { id: "z", hash: "z" },
    ];
    const src = memSource(env, main.transactor, rs);
    const report = await pull(env, src, {
      batchSize: 4,
      quota: {
        make: (d: Parameters<typeof consecutiveBreaker>[2]) =>
          consecutiveBreaker("alpha-quota", env.runs, d),
        isQuota: (e: unknown) => e instanceof QuotaError,
      },
    });
    expect(report.status).toBe("failed");
    expect(report.failure).toEqual({ kind: "quota", count: 5, externalId: "q4" });
    // Batch 1 (a, b, q0, q1) committed; batch 2 (q2, q3, q4, z) committed through q4.
    expect(report).toMatchObject({ listed: 8, written: 2, quarantined: 5 });
    expect(await docs(sql, env)).toEqual(["a", "b"]);
    expect((await quarantineRows(sql, env)).map((r) => r.external_id)).toEqual([
      "q0",
      "q1",
      "q2",
      "q3",
      "q4",
    ]);
    // The cursor is the tripping ref's, so the next run starts at z.
    expect(await cursorOf(sql, env)).toBe(7);
    expect(String((await runRows(sql, env))[0]?.reason)).toContain(
      "5 quota failures in a row; the run stopped after q4",
    );
    expect(env.events.some((e) => e.type === "runs.breaker_tripped")).toBe(true);
  });

  test("F1: quotaHit counts a hit and the doc stays written", async () => {
    const env = await fresh();
    const rs: Rec[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, hash: `${i}`, quotaHit: true })),
      { id: "z", hash: "z" },
    ];
    const report = await pull(env, memSource(env, main.transactor, rs), {
      batchSize: 10,
      quota: {
        make: (d: Parameters<typeof consecutiveBreaker>[2]) =>
          consecutiveBreaker("alpha-quota", env.runs, d),
        isQuota: () => false,
      },
    });
    expect(report.failure).toEqual({ kind: "quota", count: 5, externalId: "h4" });
    expect(report).toMatchObject({ written: 5, quarantined: 0 });
    expect(await docs(sql, env)).toEqual(["h0", "h1", "h2", "h3", "h4"]);
    expect(await cursorOf(sql, env)).toBe(5);
  });

  test("F1: meter and count reach the run row", async () => {
    const env = await fresh();
    const report = await pull(
      env,
      memSource(env, main.transactor, [
        { id: "m1", hash: "1", meter: true },
        { id: "m2", hash: "2", meter: true },
      ]),
    );
    expect(report.status).toBe("ok");
    const [row] = await sql.unsafe<{ counts: string; tokens: string }>(
      `SELECT counts::text AS counts, tokens::text AS tokens FROM ${env.R}`,
    );
    expect(JSON.parse(row?.counts ?? "{}")).toMatchObject({ calls: 2, fetched: 2 });
    expect(JSON.parse(row?.tokens ?? "{}")).toEqual({ "model-a": { input: 20, output: 40 } });
  });

  test("a success clears the count and other throws do not count", async () => {
    const env = await fresh();
    const rs: Rec[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, hash: `${i}`, quota: true })),
      { id: "ok", hash: "o" },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, hash: `${i}`, quota: true })),
      { id: "lf", hash: "l", failLoad: true },
    ];
    const report = await pull(env, memSource(env, main.transactor, rs), {
      batchSize: 20,
      quota: {
        make: (d: Parameters<typeof consecutiveBreaker>[2]) =>
          consecutiveBreaker("alpha-quota", env.runs, d),
        isQuota: (e: unknown) => e instanceof QuotaError,
      },
    });
    expect(report).toMatchObject({ status: "ok", written: 1, quarantined: 9 });
  });
});

describe("RD2 a failing batch transaction", () => {
  test("rolls back its loads, quarantine rows and cursor; prior batches stand", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, [
      { id: "a", hash: "1" },
      { id: "b", hash: "2" },
      { id: "c", hash: "3", failFetch: true },
      { id: "d", hash: "4", cursor: { bad: 1n } },
    ]);
    const report = await pull(env, src);
    expect(report.status).toBe("failed");
    expect(report.failure?.kind).toBe("batch");
    expect(report).toMatchObject({ written: 2, quarantined: 0 });
    expect(await docs(sql, env)).toEqual(["a", "b"]);
    expect(await quarantineRows(sql, env)).toEqual([]);
    expect(await cursorOf(sql, env)).toBe(2);
  });
});

describe("RD3 resolve", () => {
  test("a later success resolves the pending row", async () => {
    const env = await fresh();
    await pull(env, memSource(env, main.transactor, [{ id: "a", hash: "1", failLoad: true }]));
    expect((await quarantineRows(sql, env))[0]?.status).toBe("pending");
    await pull(env, memSource(env, main.transactor, [{ id: "a", hash: "1" }]));
    expect((await quarantineRows(sql, env))[0]?.status).toBe("resolved");
  });
});

describe("RD4 no transaction is open during a fetch", () => {
  test("the runner's backend is not idle in transaction while fetches run", async () => {
    const env = await fresh();
    const watcher = openSecond();
    const states: string[] = [];
    try {
      const src = memSource(env, main.transactor, recs(4));
      src.duringFetch = async () => {
        const rows = await watcher.transactor.sql.unsafe<{ state: string }>(
          `SELECT state FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
        );
        for (const r of rows) states.push(r.state ?? "null");
      };
      const report = await pull(env, src);
      expect(report.status).toBe("ok");
    } finally {
      await watcher.close();
    }
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((s) => s.startsWith("idle in transaction"))).toEqual([]);
  });
});

describe("RD7 a lost lock", () => {
  test("lost during the fetch pass: settles lost-lock and writes nothing", async () => {
    const env = await fresh();
    const lock = await env.acquire("alpha-sync");
    const src = memSource(env, main.transactor, recs(4));
    let n = 0;
    src.duringFetch = async () => {
      n += 1;
      if (n === 2) {
        // The lock's backend dies and a competitor takes the lock: the gate reads LOST.
        await killLock(sql, "alpha-sync");
        await env.acquire("alpha-sync");
      }
    };
    const report = await pull(env, src, { lock });
    expect(report.status).toBe("failed");
    expect(report.failure?.kind).toBe("lost-lock");
    expect(report.written).toBe(0);
    expect(await docs(sql, env)).toEqual([]);
  });

  test("P7.1: lost between batches, batch 1 stands and batch 2 is never read", async () => {
    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    let killed = false;
    // The first gate after batch 1 committed is batch 2's P7.1.
    const lock = gatedLock(real, async () => {
      if (killed || !env.events.some((e) => e.type === "runner.batch_committed")) return;
      killed = true;
      await killLock(sql, "alpha-sync");
      await env.acquire("alpha-sync");
    });
    const src = memSource(env, main.transactor, recs(4));
    const existing = src.existing.bind(src);
    let existingCalls = 0;
    src.existing = (ids) => {
      existingCalls += 1;
      return existing(ids);
    };
    const report = await pull(env, src, { lock });
    expect(report.failure?.kind).toBe("lost-lock");
    expect(report).toMatchObject({ status: "failed", written: 2 });
    // The gate refused before batch 2's existing, so nothing of batch 2 was touched.
    expect(existingCalls).toBe(1);
    expect(src.fetches).toEqual(["r1", "r2"]);
    expect(await docs(sql, env)).toEqual(["r1", "r2"]);
    expect(await cursorOf(sql, env)).toBe(2);
    const [row] = await runRows(sql, env);
    expect(row?.status).toBe("failed");
    expect(String(row?.reason)).toContain("rootstock runner: lost the run lock: ");
  });
});

describe("RD repoint", () => {
  test("a claimed rename counts unchanged and repointed; a throwing hook falls through to load", async () => {
    const env = await fresh();
    const src = memSource(
      env,
      main.transactor,
      [
        { id: "a", hash: "1" },
        { id: "b", hash: "2" },
      ],
      {
        repoint: (id) => (id === "a" ? true : "throw"),
      },
    );
    const report = await pull(env, src);
    expect(report).toMatchObject({ status: "ok", unchanged: 1, repointed: 1, written: 1 });
    expect(env.events.some((e) => e.type === "runner.repoint_failed")).toBe(true);
  });
});

describe("PL plan mode", () => {
  test("PL1/PL2 actions per branch, and nothing is written", async () => {
    const env = await fresh();
    await pull(
      env,
      memSource(env, main.transactor, [
        { id: "same", hash: "1" },
        { id: "chg", hash: "1", hashAfterFetch: true },
      ]),
    );
    const before = {
      docs: await docs(sql, env),
      runs: (await runRows(sql, env)).length,
      cursor: await cursorOf(sql, env),
    };
    const src = memSource(env, main.transactor, [
      { id: "same", hash: "1" },
      { id: "chg", hash: "2", hashAfterFetch: true },
      { id: "new", hash: "3" },
      { id: "ff", hash: "4", failFetch: true },
      { id: "wi", hash: "5", wrongId: true },
      { id: "new", hash: "3" },
    ]);
    const plan = await planPull(
      { tx: main.transactor, cursors: env.cursors, source: src, batchSize: 4, fetchConcurrency: 2 },
      env.deps,
    );
    expect(plan.items.map((i) => [i.externalId, i.action])).toEqual([
      ["same", "unchanged"],
      ["chg", "changed"],
      ["new", "new"],
      ["ff", "fetch-failed"],
      ["wi", "id-mismatch"],
      ["new", "duplicate"],
    ]);
    expect(plan.cursor).toEqual({ stored: 2, wouldStore: 6 });
    expect(plan.counts).toMatchObject({ unchanged: 1, changed: 1, new: 1, duplicate: 1 });
    expect({
      docs: await docs(sql, env),
      runs: (await runRows(sql, env)).length,
      cursor: await cursorOf(sql, env),
    }).toEqual(before);
    expect(await quarantineRows(sql, env)).toEqual([]);
  });

  test("PL3 planLoad runs read-only and rolls back", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, [{ id: "n", hash: "1" }], { planLoad: true });
    const plan = await planPull(
      { tx: main.transactor, cursors: env.cursors, source: src, batchSize: 1, fetchConcurrency: 1 },
      env.deps,
    );
    const item = plan.items[0];
    expect(item?.action).toBe("new");
    // The write inside the READ ONLY transaction is refused (25006), reported as the detail.
    expect(String((item?.detail as { error?: string })?.error)).toMatch(/read-only|Failed query/);
    expect(await docs(sql, env)).toEqual([]);
  });
});

describe("RD5 a killed run converges", () => {
  test("kill -9 idle in the batch transaction; the next pull completes and settles the row interrupted", async () => {
    const env = await fresh();
    const child = Bun.spawn(
      ["bun", new URL("./pull-child.pg-support.ts", import.meta.url).pathname, env.sc],
      { stdout: "pipe", stderr: "pipe", env: process.env },
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
    // Batch 1 committed (r1, r2, cursor 2); batch 2 is open, parked in r3's load.
    expect(await docs(sql, env)).toEqual(["r1", "r2"]);
    const idle = await sql.unsafe<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
       WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
    );
    expect(Number(idle[0]?.n)).toBeGreaterThan(0);
    child.kill(9);
    await child.exited;
    const released = Date.now() + 5_000;
    while ((await locksHeld(sql, ["alpha-sync"])).get("alpha-sync") === true) {
      if (Date.now() > released) throw new Error("the child's lock was never released");
      await Bun.sleep(20);
    }
    expect(await cursorOf(sql, env)).toBe(2);

    const recs4: Rec[] = ["r1", "r2", "r3", "r4"].map((id) => ({ id, hash: `h-${id}` }));
    const report = await pull(
      env,
      memSource(env, main.transactor, recs4, { fromCursor: "exclusive" }),
    );
    expect(report).toMatchObject({ status: "ok", listed: 2, written: 2 });
    expect(await docs(sql, env)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(await cursorOf(sql, env)).toBe(4);
    const rows = await runRows(sql, env);
    expect(rows.find((r) => r.id === childRun)?.status).toBe("interrupted");
    expect(rows.find((r) => r.id === report.runId)?.status).toBe("ok");
  }, 30_000);
});

describe("RD5b equal cursors across a batch boundary", () => {
  const recsEq: Rec[] = [
    { id: "e1", hash: "1", cursor: 1 },
    { id: "e2", hash: "2", cursor: 2 },
    { id: "e3", hash: "3", cursor: 2 },
    { id: "e4", hash: "4", cursor: 3 },
  ];
  const failSecondBatch = (src: MemSource): MemSource => {
    const existing = src.existing.bind(src);
    let calls = 0;
    src.existing = async (ids) => {
      calls += 1;
      if (calls === 2) throw new Error("batch 2 failed");
      return existing(ids);
    };
    return src;
  };

  test("an inclusive list converges", async () => {
    const env = await fresh();
    const first = await pull(
      env,
      failSecondBatch(memSource(env, main.transactor, recsEq, { fromCursor: "inclusive" })),
    );
    expect(first.failure?.kind).toBe("batch");
    expect(await cursorOf(sql, env)).toBe(2);
    const second = await pull(
      env,
      memSource(env, main.transactor, recsEq, { fromCursor: "inclusive" }),
    );
    expect(second).toMatchObject({ status: "ok", listed: 3, written: 2, unchanged: 1 });
    expect(await docs(sql, env)).toEqual(["e1", "e2", "e3", "e4"]);
  });

  test("an exclusive list loses the ref that shared the boundary's cursor (why the obligation exists)", async () => {
    const env = await fresh();
    await pull(
      env,
      failSecondBatch(memSource(env, main.transactor, recsEq, { fromCursor: "exclusive" })),
    );
    await pull(env, memSource(env, main.transactor, recsEq, { fromCursor: "exclusive" }));
    expect(await docs(sql, env)).toEqual(["e1", "e2", "e4"]);
  });
});

describe("the guard and the run record", () => {
  test("a throw outside every step settles threw with the committed totals and rethrows the original", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, recs(4));
    const existing = src.existing.bind(src);
    let calls = 0;
    src.existing = async (ids) => {
      calls += 1;
      return (calls === 2 ? null : await existing(ids)) as never;
    };
    const err = await pull(env, src).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    const [row] = await runRows(sql, env);
    expect(row).toMatchObject({ status: "failed", written: 2 });
    // runs prefixes its identity text: the batch-2 refs were never accounted.
    expect(String(row?.reason)).toContain("rootstock runner: run threw: ");
    expect(env.events.filter((e) => e.type === "runner.pull_finished")).toHaveLength(1);
  });

  test("afterRun is reached with the settled row", async () => {
    const env = await fresh();
    const seen: string[] = [];
    await pull(env, memSource(env, main.transactor, recs(2)), {
      afterRun: (row: { status: string }) => {
        seen.push(row.status);
      },
    });
    expect(seen).toEqual(["ok"]);
  });

  test("beforeSettle runs once on a clean run, gated, and its override and counter land on the row", async () => {
    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    let gates = 0;
    const lock = gatedLock(real, () => {
      gates += 1;
    });
    const seen: unknown[] = [];
    let kept: BeforeSettleContext | undefined;
    const report = await pull(env, memSource(env, main.transactor, recs(3)), {
      lock,
      beforeSettle: async (ctx: BeforeSettleContext) => {
        const before = gates;
        await ctx.ensureExclusive();
        seen.push({
          job: ctx.job,
          mode: ctx.mode,
          backfill: ctx.backfill,
          listed: ctx.counts.listed,
          written: ctx.counts.written,
          gatedByHook: gates === before + 1,
        });
        // A repeated flag is recorded once, and is on the running row at once.
        await ctx.override("brake.alpha-archive");
        await ctx.override("brake.alpha-archive");
        ctx.count("retracted", 4);
        ctx.meter("model-a", 10, 20);
        const [row] = await sql.unsafe(`SELECT status, overrides::text AS o FROM ${env.R}`);
        seen.push(`${row?.status} ${row?.o}`);
        kept = ctx;
      },
    });
    expect(report.status).toBe("ok");
    expect(seen).toEqual([
      {
        job: "alpha-sync",
        mode: "incremental",
        backfill: false,
        listed: 3,
        written: 3,
        gatedByHook: true,
      },
      'running ["brake.alpha-archive"]',
    ]);
    const [row] = await sql.unsafe(
      `SELECT status, phase, overrides::text AS overrides, counts->>'retracted' AS retracted, tokens->'model-a'->>'output' AS output FROM ${env.R}`,
    );
    expect(row).toMatchObject({
      status: "ok",
      phase: null,
      overrides: '["brake.alpha-archive"]',
      retracted: "4",
      output: "20",
    });
    // The context refuses once the hook has returned.
    expect(() => kept?.count("x")).toThrow(/ctx\.count\(\) called after the hook returned/);
    await expect(kept?.override("x") as Promise<void>).rejects.toThrow(/after the hook returned/);
    const bracket = env.events.filter((e) => e.type.startsWith("runner.before_settle"));
    expect(bracket.map((e) => e.type)).toEqual([
      "runner.before_settle_started",
      "runner.before_settle_finished",
    ]);
    expect(bracket[1]).toMatchObject({ outcome: "ok" });
  });

  test("beforeSettle: an override outlives a row settled interrupted; once the row is gone, override refuses", async () => {
    const env = await fresh();
    let refused: unknown;
    const report = await pull(env, memSource(env, main.transactor, recs(1)), {
      beforeSettle: async (ctx: BeforeSettleContext) => {
        await ctx.override("brake.alpha-archive");
        // What the next run does to a killed run's row: settles it interrupted.
        await sql.unsafe(`UPDATE ${env.R} SET status = 'interrupted', finished_at = now()`);
        refused = await ctx.override("brake.beta").then(
          () => undefined,
          (e: unknown) => e,
        );
      },
    });
    expect(String((refused as Error)?.message)).toContain("no longer running");
    expect(report.failure).toBeUndefined();
    expect(report.finish).toMatchObject({ written: false, why: "settled-elsewhere" });
    const [row] = await sql.unsafe(`SELECT status, overrides::text AS o FROM ${env.R}`);
    expect(row).toMatchObject({ status: "interrupted", o: '["brake.alpha-archive"]' });
  });

  test("beforeSettle: a throw settles before-settle, not rethrown; a bad flag is a throw", async () => {
    const env = await fresh();
    const report = await pull(env, memSource(env, main.transactor, recs(2)), {
      beforeSettle: async (ctx: BeforeSettleContext) => {
        await ctx.override("Not A Flag");
      },
    });
    expect(report.status).toBe("failed");
    expect(report.failure?.kind).toBe("before-settle");
    expect(report.written).toBe(2);
    const [row] = await sql.unsafe(`SELECT status, phase, written, reason FROM ${env.R}`);
    expect(row).toMatchObject({ status: "failed", phase: "before-settle", written: 2 });
    expect(String(row?.reason)).toStartWith("rootstock runner: beforeSettle failed: ");
    const finished = env.events.find((e) => e.type === "runner.before_settle_finished");
    expect(finished).toMatchObject({ outcome: "before-settle" });
    expect(String((finished as { error?: Error }).error?.message)).toContain("Not A Flag");
  });

  test("beforeSettle is not called on a failed run, and sees backfill", async () => {
    const env = await fresh();
    let called = 0;
    const failing = memSource(env, main.transactor, recs(2));
    failing.list = async () => {
      throw new Error("listing down");
    };
    const failed = await pull(env, failing, {
      beforeSettle: () => {
        called += 1;
      },
    });
    expect(failed.failure?.kind).toBe("list");
    // A quota trip on the listing's last ref: everything committed, still failed.
    const tripped = await pull(
      env,
      memSource(
        env,
        main.transactor,
        Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, hash: `${i}`, quota: true })),
      ),
      {
        quota: {
          make: (d: Parameters<typeof consecutiveBreaker>[2]) =>
            consecutiveBreaker("alpha-quota", env.runs, d),
          isQuota: (e: unknown) => e instanceof QuotaError,
        },
        beforeSettle: () => {
          called += 1;
        },
      },
    );
    expect(tripped.failure?.kind).toBe("quota");
    expect(called).toBe(0);
    const backfills: boolean[] = [];
    await pull(env, memSource(env, main.transactor, recs(1), { boundedBackfill: true }), {
      since: new Date(0),
      beforeSettle: (ctx: BeforeSettleContext) => {
        backfills.push(ctx.backfill);
      },
    });
    expect(backfills).toEqual([true]);
  });

  test("beforeSettle: the lock lost at the gate before the hook settles lost-lock and never calls it", async () => {
    // A probe run counts the gates up to the hook: the last is the hook's own.
    const probeEnv = await fresh();
    const probeReal = await probeEnv.acquire("alpha-sync");
    let probeGates = 0;
    let atHook = 0;
    await pull(probeEnv, memSource(probeEnv, main.transactor, recs(1)), {
      lock: gatedLock(probeReal, () => {
        probeGates += 1;
      }),
      beforeSettle: () => {
        atHook = probeGates;
      },
    });
    expect(atHook).toBeGreaterThan(1);
    await probeReal.release();

    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    let called = 0;
    let gates = 0;
    const lock = gatedLock(real, async () => {
      gates += 1;
      if (gates === atHook) {
        await killLock(sql, "alpha-sync");
        await env.acquire("alpha-sync");
      }
    });
    const report = await pull(env, memSource(env, main.transactor, recs(1)), {
      lock,
      beforeSettle: () => {
        called += 1;
      },
    });
    expect(report.failure?.kind).toBe("lost-lock");
    expect(report.written).toBe(1);
    expect(called).toBe(0);
  });

  test("beforeSettle: the lock lost at the hook's own gate settles lost-lock, even when the hook rethrows something else", async () => {
    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    let inHook = false;
    const lock = gatedLock(real, async () => {
      if (inHook) {
        await killLock(sql, "alpha-sync");
        await env.acquire("alpha-sync");
      }
    });
    const report = await pull(env, memSource(env, main.transactor, recs(1)), {
      lock,
      beforeSettle: async (ctx: BeforeSettleContext) => {
        inHook = true;
        await ctx.ensureExclusive().catch(() => {
          throw new Error("wrapped");
        });
      },
    });
    expect(report.failure?.kind).toBe("lost-lock");
    const [row] = await runRows(sql, env);
    expect(String(row?.reason)).toStartWith("rootstock runner: lost the run lock: ");
  });

  test("beforeSettle: a lock refusal the hook swallows still settles lost-lock", async () => {
    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    let inHook = false;
    const lock = gatedLock(real, async () => {
      if (inHook) {
        await killLock(sql, "alpha-sync");
        await env.acquire("alpha-sync");
      }
    });
    const report = await pull(env, memSource(env, main.transactor, recs(1)), {
      lock,
      beforeSettle: async (ctx: BeforeSettleContext) => {
        inHook = true;
        await ctx.ensureExclusive().catch(() => undefined);
      },
    });
    expect(report.status).toBe("failed");
    expect(report.failure?.kind).toBe("lost-lock");
  });

  test("beforeSettle: a gate the hook never awaited still settles lost-lock", async () => {
    const env = await fresh();
    const real = await env.acquire("alpha-sync");
    let inHook = false;
    const lock = gatedLock(real, async () => {
      if (inHook) {
        await killLock(sql, "alpha-sync");
        await env.acquire("alpha-sync");
      }
    });
    const report = await pull(env, memSource(env, main.transactor, recs(1)), {
      lock,
      beforeSettle: (ctx: BeforeSettleContext) => {
        inHook = true;
        void ctx.ensureExclusive().catch(() => undefined);
      },
    });
    expect(report.failure?.kind).toBe("lost-lock");
    const [row] = await sql.unsafe(`SELECT phase FROM ${env.R}`);
    expect(row?.phase).toBe("before-settle");
  });

  test("beforeSettle: the counts are a frozen copy; the runner's own counters and a bad name refuse", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, recs(1), {
      excluded: [{ reason: "draft", count: 2 }],
    });
    const refusals: string[] = [];
    const report = await pull(env, src, {
      beforeSettle: (ctx: BeforeSettleContext) => {
        const entry = ctx.counts.excludedReasons[0] as { count: number };
        expect(() => {
          entry.count = 999;
        }).toThrow(TypeError);
        for (const name of ["fetched", "repointed", "Bad Name"]) {
          try {
            ctx.count(name);
          } catch (e) {
            refusals.push(`${name}: ${String(runnerErrorCode(e) ?? (e as Error).name)}`);
          }
        }
      },
    });
    expect(report.status).toBe("ok");
    expect(report.excludedReasons).toEqual([{ reason: "draft", count: 2 }]);
    expect(refusals).toEqual([
      "fetched: ERR_ROOTSTOCK_RUNNER_INPUT",
      "repointed: ERR_ROOTSTOCK_RUNNER_INPUT",
      expect.stringMatching(/^Bad Name: /),
    ]);
    const [row] = await runRows(sql, env);
    expect(JSON.parse(String(row?.counts))).toMatchObject({ fetched: 1 });
  });

  test("F2: a run record that cannot start is START, cause kept, nothing listed", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, recs(2), { job: "zeta-sync" });
    const lock = await env.acquire("alpha-sync");
    const err = (await pull(env, src, { lock }).catch((e: unknown) => e)) as Error;
    expect(runnerErrorCode(err)).toBe("ERR_ROOTSTOCK_RUNNER_START");
    expect(err.message).toStartWith("rootstock runner: could not start the run record: ");
    expect(err.cause).toBeDefined();
    expect(await runRows(sql, env)).toEqual([]);
  });

  test("F3: describe and mismatchReason shape the quarantine reasons", async () => {
    const env = await fresh();
    await pull(
      env,
      memSource(env, main.transactor, [
        { id: "ff", hash: "1", failFetch: true },
        { id: "wi", hash: "2", wrongId: true },
      ]),
      {
        describe: (e: unknown) => `D(${(e as Error).message})`,
        mismatchReason: (a: string, g: unknown) => `M(${a},${String(g)})`,
      },
    );
    expect((await quarantineRows(sql, env)).map((r) => r.reason)).toEqual([
      "D(fetch failed for ff)",
      "M(wi,wi-other)",
    ]);
  });

  test("F7: the lock lost inside the batch transaction rolls the batch back", async () => {
    const env = await fresh();
    const lock = await env.acquire("alpha-sync");
    const src = memSource(env, main.transactor, recs(2));
    // The batch transaction holds the main pool's connection: kill from a second session.
    const killer = openSecond();
    src.beforeLoad = async (id) => {
      if (id !== "r1") return;
      await killLock(killer.transactor.sql, "alpha-sync");
      await env.acquire("alpha-sync");
    };
    const report = await pull(env, src, { lock }).finally(() => killer.close());
    expect(report.failure?.kind).toBe("lost-lock");
    expect(report.written).toBe(0);
    expect(await docs(sql, env)).toEqual([]);
    expect(await cursorOf(sql, env)).toBeUndefined();
    const rolled = env.events.find((e) => e.type === "runner.batch_rolled_back");
    expect(rolled).toMatchObject({
      type: "runner.batch_rolled_back",
      job: "alpha-sync",
      runId: report.runId,
      batch: 1,
      kind: "lost-lock",
    });
    expect((rolled as { error?: unknown }).error).toBeDefined();
  });
});

describe("RP3 a failed first occurrence", () => {
  test("in the same batch: the later occurrence fetches fresh and writes", async () => {
    const env = await fresh();
    const d: Rec = { id: "d", hash: "1", failFetchOnce: true };
    const src = memSource(env, main.transactor, [d, d]);
    const report = await pull(env, src, { batchSize: 5 });
    expect(report).toMatchObject({ status: "ok", listed: 2, written: 1, quarantined: 1 });
    expect(src.fetches).toEqual(["d", "d"]);
    expect(await docs(sql, env)).toEqual(["d"]);
  });

  test("across batches: the later occurrence writes and resolves the earlier batch's row", async () => {
    const env = await fresh();
    const d: Rec = { id: "d", hash: "1", failFetchOnce: true };
    const src = memSource(env, main.transactor, [d, { id: "x", hash: "2" }, d]);
    const report = await pull(env, src);
    expect(report).toMatchObject({ status: "ok", listed: 3, written: 2, quarantined: 1 });
    expect(src.fetches).toEqual(["d", "x", "d"]);
    expect(await docs(sql, env)).toEqual(["d", "x"]);
    expect((await quarantineRows(sql, env)).map((r) => [r.external_id, r.status])).toEqual([
      ["d", "resolved"],
    ]);
  });
});

describe("RD3 a pending row the batch also failed", () => {
  test("a repeat failure keeps it pending with the new reason; a later success resolves it", async () => {
    const env = await fresh();
    await pull(env, memSource(env, main.transactor, [{ id: "x", hash: "1", failFetch: true }]));
    await pull(env, memSource(env, main.transactor, [{ id: "x", hash: "1", failLoad: true }]));
    expect(await quarantineRows(sql, env)).toEqual([
      { external_id: "x", status: "pending", reason: "load failed for x" },
    ]);
    await pull(env, memSource(env, main.transactor, [{ id: "x", hash: "1" }]));
    expect((await quarantineRows(sql, env))[0]?.status).toBe("resolved");
  });

  test("quarantined and then written in one batch: the row stays pending", async () => {
    const env = await fresh();
    await pull(env, memSource(env, main.transactor, [{ id: "x", hash: "1", failLoad: true }]));
    const x: Rec = { id: "x", hash: "1", failFetchOnce: true };
    const report = await pull(env, memSource(env, main.transactor, [x, x]), { batchSize: 5 });
    expect(report).toMatchObject({ status: "ok", written: 1, quarantined: 1 });
    expect(await docs(sql, env)).toEqual(["x"]);
    expect(await quarantineRows(sql, env)).toEqual([
      { external_id: "x", status: "pending", reason: "fetch failed once for x" },
    ]);
  });
});

describe("RP6 other throws leave the count", () => {
  test("3 quota throws, a plain load failure, 2 quota throws: trips on the fifth hit", async () => {
    const env = await fresh();
    const q = (id: string): Rec => ({ id, hash: id, quota: true });
    const rs: Rec[] = [
      q("q0"),
      q("q1"),
      q("q2"),
      { id: "lf", hash: "l", failLoad: true },
      q("q3"),
      q("q4"),
      { id: "z", hash: "z" },
    ];
    const report = await pull(env, memSource(env, main.transactor, rs), {
      batchSize: 10,
      quota: {
        make: (d: Parameters<typeof consecutiveBreaker>[2]) =>
          consecutiveBreaker("alpha-quota", env.runs, d),
        isQuota: (e: unknown) => e instanceof QuotaError,
      },
    });
    // A clearing failLoad would leave 2 hits (no trip); a counting one would trip at q3.
    expect(report.failure).toEqual({ kind: "quota", count: 5, externalId: "q4" });
    expect(report).toMatchObject({ written: 0, quarantined: 6 });
    expect(await cursorOf(sql, env)).toBe(6);
  });
});

describe("RP11 an empty listing on a backfill", () => {
  test("leaves the stored cursor alone", async () => {
    const env = await fresh();
    await sql.unsafe(`INSERT INTO ${env.C} (name, value) VALUES ('alpha-sync', '7'::jsonb)`);
    const src = memSource(env, main.transactor, [], {
      boundedBackfill: true,
      nextCursor: { at: 9 },
    });
    const report = await pull(env, src, { since: new Date(1000) });
    expect(report.status).toBe("ok");
    expect(await cursorOf(sql, env)).toBe(7);
  });
});

describe("RD repoint, an id already stored", () => {
  test("is never offered to tryRepoint: a changed doc loads", async () => {
    const env = await fresh();
    await pull(env, memSource(env, main.transactor, [{ id: "a", hash: "1" }]));
    const offered: string[] = [];
    const src = memSource(env, main.transactor, [{ id: "a", hash: "2" }], {
      repoint: (id) => {
        offered.push(id);
        return true;
      },
    });
    const report = await pull(env, src);
    expect(report).toMatchObject({ status: "ok", written: 1, repointed: 0, unchanged: 0 });
    expect(offered).toEqual([]);
    const [row] = await sql.unsafe<{ h: string }>(`SELECT content_hash AS h FROM ${env.D}`);
    expect(row?.h).toBe("2");
  });
});

describe("F17 an empty hash is no hash", () => {
  test('a fetched doc with contentHash "" loads even when the stored hash is ""', async () => {
    const env = await fresh();
    await sql.unsafe(`INSERT INTO ${env.D} (external_id, content_hash) VALUES ('e', '')`);
    const report = await pull(
      env,
      memSource(env, main.transactor, [{ id: "e", hash: "", hashAfterFetch: true }]),
    );
    expect(report).toMatchObject({ status: "ok", fetched: 1, written: 1, unchanged: 0 });
  });
});

describe("list: a NUL externalId", () => {
  test("settles failed list (INPUT) and writes nothing", async () => {
    const env = await fresh();
    const src = memSource(env, main.transactor, recs(2));
    src.list = async () => ({
      refs: [
        { externalId: "r1", contentHash: "h1", cursor: 1 },
        { externalId: "r\u00002", contentHash: "h2", cursor: 2 },
      ],
    });
    const report = await pull(env, src);
    expect(report.failure?.kind).toBe("list");
    expect(runnerErrorCode((report.failure as { error: unknown }).error)).toBe(
      "ERR_ROOTSTOCK_RUNNER_INPUT",
    );
    expect(src.fetches).toEqual([]);
    expect(await docs(sql, env)).toEqual([]);
    expect(await cursorOf(sql, env)).toBeUndefined();
    expect((await runRows(sql, env))[0]?.status).toBe("failed");
  });
});

describe("RP9/RP10 the fetch pass", () => {
  test("RP9 fetchConcurrency bounds in-flight fetches, each fetch gated first", async () => {
    const env = await fresh();
    const log: string[] = [];
    const lock = gatedLock(await env.acquire("alpha-sync"), () => {
      log.push("gate");
    });
    const src = memSource(env, main.transactor, recs(10));
    const list = src.list.bind(src);
    src.list = (c, s) => {
      log.push("list");
      return list(c, s);
    };
    let inFlight = 0;
    let most = 0;
    src.duringFetch = async () => {
      log.push("fetch");
      inFlight += 1;
      most = Math.max(most, inFlight);
    };
    src.fetchGate = async () => {
      await Bun.sleep(15);
      inFlight -= 1;
    };
    src.beforeLoad = async () => {
      log.push("load");
    };
    const report = await pull(env, src, { lock, batchSize: 10, fetchConcurrency: 3 });
    expect(report).toMatchObject({ status: "ok", written: 10 });
    expect(most).toBe(3);
    const pass = log.slice(log.indexOf("list") + 1, log.indexOf("load"));
    // P7.1, one per fetch, the gate after the pass, and r1's gate before its load.
    expect(pass.filter((x) => x === "gate")).toHaveLength(13);
    expect(pass.filter((x) => x === "fetch")).toHaveLength(10);
    // The k-th fetch starts after at least k + 1 gates (P7.1 and its own).
    let gates = 0;
    let fetches = 0;
    for (const x of pass) {
      if (x === "gate") gates += 1;
      else {
        fetches += 1;
        expect(gates).toBeGreaterThanOrEqual(fetches + 1);
      }
    }
  });

  test("RP10 a gate throw while two fetches are parked settles lost-lock only after both resolve", async () => {
    const env = await fresh();
    let listed = false;
    let gatesAfterList = 0;
    const refusal = new Error("lock gone");
    const lock = gatedLock(await env.acquire("alpha-sync"), () => {
      if (!listed) return;
      gatesAfterList += 1;
      // P7.1, r1's gate, r2's gate, then r3's: refused.
      if (gatesAfterList === 4) throw refusal;
    });
    const src = memSource(env, main.transactor, recs(3));
    const list = src.list.bind(src);
    src.list = async (c, s) => {
      const out = await list(c, s);
      listed = true;
      return out;
    };
    const parked = new Map<string, () => void>();
    src.fetchGate = (id) =>
      new Promise<void>((resolve) => {
        parked.set(id, resolve);
      });
    let done = false;
    const running = pull(env, src, { lock, batchSize: 3, fetchConcurrency: 3 }).finally(() => {
      done = true;
    });
    const deadline = Date.now() + 5_000;
    while ((parked.size < 2 || gatesAfterList < 4) && Date.now() < deadline) await Bun.sleep(5);
    expect([...parked.keys()]).toEqual(["r1", "r2"]);
    await Bun.sleep(50);
    expect(done).toBe(false);
    expect((await runRows(sql, env))[0]?.status).toBe("running");
    parked.get("r1")?.();
    await Bun.sleep(50);
    expect(done).toBe(false);
    parked.get("r2")?.();
    const report = await running;
    expect(report.failure).toEqual({ kind: "lost-lock", error: refusal });
    expect(src.fetches).toEqual(["r1", "r2"]);
    expect(await docs(sql, env)).toEqual([]);
    expect((await runRows(sql, env))[0]?.status).toBe("failed");
  });
});
