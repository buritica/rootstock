import { describe, expect, test } from "bun:test";
import type { Row, Sql } from "../db/index.ts";
import { LOCK_HELD_PREDICATE, type RunLock } from "../lock/index.ts";
import type { RunsEvent } from "./events.ts";
import { runsInput } from "./fixtures.test-support.ts";
import { pruneRuns, type RunRow, runsSnapshot, startRun } from "./record.ts";
import { type RunsSlice, runsSlice } from "./slice.ts";
import { PROJECTION, runsStatements } from "./statements.ts";

// R-D2 (contract §13.2): the run record against a fake Sql that records every
// statement it is sent and answers from a script.

type Id = "R1" | "R2" | "R3" | "R4" | "R5";
type Answer = Row[] | Error | ((params: readonly unknown[]) => Row[]);

const HOLDER = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const STARTED_MS = 1_700_000_000_000;

/** A row of `<P(r)>` as R2 would return it, built from R2's params. */
function finishedRow(p: readonly unknown[]): Row[] {
  const json = (v: unknown, empty: unknown) => (v === null ? empty : JSON.parse(String(v)));
  return [
    {
      row: JSON.stringify({
        id: p[0],
        job: "alpha-sync",
        mode: "incremental",
        status: p[2],
        phase: p[3],
        lockName: "alpha-sync",
        holder: p[1],
        startedAtMs: String(STARTED_MS),
        finishedAtMs: String(STARTED_MS + 1000),
        listed: p[4],
        written: p[5],
        unchanged: p[6],
        quarantined: p[7],
        excluded: p[8],
        reconciled: p[9],
        excludedReasons: json(p[10], {}),
        counts: json(p[11], {}),
        tokens: json(p[12], {}),
        costUsd: p[13],
        costNote: p[14],
        scope: json(p[15], null),
        scopeExcluded: json(p[16], null),
        overrides: json(p[17], []),
        reason: p[18],
      }),
    },
  ];
}

interface Fake {
  sql: Sql;
  calls: { id: Id; params: readonly unknown[] }[];
  answer(id: Id, ...answers: Answer[]): void;
}

function fakeSql(slice: RunsSlice): Fake {
  const s = runsStatements(slice.table, slice.lockTable);
  const ids = new Map<string, Id>([
    [s.start, "R1"],
    [s.finish, "R2"],
    [s.discard, "R3"],
    [s.snapshot, "R4"],
    [s.prune, "R5"],
  ]);
  const defaults: Record<Id, Answer> = {
    R1: [{ inserted: true, started_at_ms: String(STARTED_MS), settled: "[]" }],
    R2: finishedRow,
    R3: [{ ok: 1 }],
    R4: [],
    R5: [{ deleted: "0" }],
  };
  const queues = new Map<Id, Answer[]>();
  const calls: { id: Id; params: readonly unknown[] }[] = [];
  const unsafe = async (query: string, params?: readonly unknown[]): Promise<Row[]> => {
    const id = ids.get(query);
    if (id === undefined) throw new Error(`fake sql: unknown statement ${query}`);
    calls.push({ id, params: [...(params ?? [])] });
    const a = queues.get(id)?.shift() ?? defaults[id];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(params ?? []) : a;
  };
  const sql = Object.assign(
    async () => {
      throw new Error("fake sql: runs sends no tagged query");
    },
    { unsafe },
  ) as unknown as Sql;
  return {
    sql,
    calls,
    answer(id, ...answers) {
      queues.set(id, [...(queues.get(id) ?? []), ...answers]);
    },
  };
}

function fakeLock(name: string, gate: () => Promise<void> = async () => {}): RunLock {
  return {
    name,
    holder: HOLDER,
    ensureExclusive: gate,
    startKeepalive: () => {},
    stopKeepalive: () => {},
    release: async () => {},
  };
}

const SLICE = runsSlice(runsInput());

async function setup(
  job = "alpha-sync",
  over: { slice?: RunsSlice; afterRun?: (row: RunRow) => void | Promise<void>; mode?: string } = {},
) {
  const slice = over.slice ?? SLICE;
  const fake = fakeSql(slice);
  const events: RunsEvent[] = [];
  const decl = job.startsWith("delta:") ? "delta:one" : job;
  const lockName =
    decl === "alpha-sync" ? "alpha-sync" : decl === "delta:one" ? "delta:one" : "shared-write";
  const mode =
    over.mode ??
    (job === "gamma-push" ? "push" : job.startsWith("delta:") ? "manual" : "incremental");
  const run = await startRun(
    fake.sql,
    slice,
    {
      job,
      mode,
      lock: fakeLock(lockName),
      ...(over.afterRun === undefined ? {} : { afterRun: over.afterRun }),
    },
    { now: () => STARTED_MS, randomUUID: () => ID.toUpperCase(), onEvent: (e) => events.push(e) },
  );
  return { run, fake, events, types: () => events.map((e) => e.type) };
}

const r2 = (f: Fake) => f.calls.filter((c) => c.id === "R2").map((c) => c.params);
const caught = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw");
};
/** The rejection of `p`, which must reject. */
const refusedWith = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e as { code: string; message: string },
  );
const ACC = { listed: 10, written: 4, unchanged: 3, quarantined: 2, excluded: 1 };

describe("startRun", () => {
  test("the id is lowercased, R1 is sent with its params, and started is emitted", async () => {
    const { run, fake, events } = await setup();
    expect(run.id).toBe(ID);
    expect(run.holder).toBe(HOLDER);
    expect(run.startedAt.getTime()).toBe(STARTED_MS);
    expect(fake.calls).toEqual([
      { id: "R1", params: [ID, "alpha-sync", "incremental", "alpha-sync", HOLDER] },
    ]);
    expect(events).toEqual([
      {
        type: "runs.started",
        id: ID,
        job: "alpha-sync",
        mode: "incremental",
        lockName: "alpha-sync",
        settled: 0,
      },
    ]);
  });

  test("settled rows are reported in R1's order before started", async () => {
    const fake = fakeSql(SLICE);
    fake.answer("R1", [
      {
        inserted: "t",
        started_at_ms: String(STARTED_MS),
        settled: JSON.stringify([
          { id: "a1", job: "beta-sync" },
          { id: "b2", job: "gamma-push" },
        ]),
      },
    ]);
    const events: RunsEvent[] = [];
    await startRun(
      fake.sql,
      SLICE,
      { job: "beta-sync", mode: "incremental", lock: fakeLock("shared-write") },
      { now: () => 0, randomUUID: () => ID, onEvent: (e) => events.push(e) },
    );
    expect(events).toEqual([
      { type: "runs.settled_interrupted", id: "a1", job: "beta-sync", by: ID },
      { type: "runs.settled_interrupted", id: "b2", job: "gamma-push", by: ID },
      {
        type: "runs.started",
        id: ID,
        job: "beta-sync",
        mode: "incremental",
        lockName: "shared-write",
        settled: 2,
      },
    ]);
  });

  test("JOB, MODE and LOCK refuse before any I/O, each with runs.refused", async () => {
    const cases: [string, string, string, string, string][] = [
      [
        "omega",
        "incremental",
        "alpha-sync",
        "ERR_ROOTSTOCK_RUNS_JOB",
        'rootstock runs: "omega" is not a job this config declares — declared: alpha-sync, beta-sync, gamma-push, delta:*',
      ],
      [
        "alpha-sync",
        "push",
        "alpha-sync",
        "ERR_ROOTSTOCK_RUNS_MODE",
        'rootstock runs: alpha-sync declares modes incremental, backfill — got "push"',
      ],
      [
        "beta-sync",
        "incremental",
        "beta-sync",
        "ERR_ROOTSTOCK_RUNS_LOCK",
        'rootstock runs: beta-sync runs under the shared-write lock — got a lock named "beta-sync"',
      ],
      [
        "delta:one",
        "manual",
        "delta:two",
        "ERR_ROOTSTOCK_RUNS_LOCK",
        'rootstock runs: delta:one runs under the delta:one lock — got a lock named "delta:two"',
      ],
    ];
    for (const [job, mode, lockName, code, text] of cases) {
      const fake = fakeSql(SLICE);
      const events: RunsEvent[] = [];
      let gated = false;
      const lock = fakeLock(lockName, async () => {
        gated = true;
      });
      const err = await refusedWith(
        startRun(
          fake.sql,
          SLICE,
          { job, mode, lock },
          { now: () => 0, randomUUID: () => ID, onEvent: (e) => events.push(e) },
        ),
      );
      expect(err.code).toBe(code);
      expect(err.message).toBe(text);
      expect(events).toEqual([{ type: "runs.refused", job, code } as RunsEvent]);
      expect(fake.calls).toEqual([]);
      expect(gated).toBe(false);
    }
  });

  test("a gate that throws propagates untouched, and nothing is written", async () => {
    const fake = fakeSql(SLICE);
    const lost = new Error("lost");
    const err = await startRun(
      fake.sql,
      SLICE,
      {
        job: "alpha-sync",
        mode: "incremental",
        lock: fakeLock("alpha-sync", async () => {
          throw lost;
        }),
      },
      { now: () => 0, randomUUID: () => ID },
    ).catch((e: unknown) => e);
    expect(err).toBe(lost);
    expect(fake.calls).toEqual([]);
  });

  test("R1's 42P01 refuses NOTABLE naming the runs table, or the lock table when named", async () => {
    const missing = (message: string) => Object.assign(new Error(message), { code: "42P01" });
    for (const [message, table] of [
      ['relation "rootstock.runs" does not exist', "rootstock.runs"],
      ['relation "rootstock.run_locks" does not exist', "rootstock.run_locks"],
    ] as const) {
      const fake = fakeSql(SLICE);
      fake.answer("R1", missing(message));
      const err = await refusedWith(
        startRun(
          fake.sql,
          SLICE,
          { job: "alpha-sync", mode: "incremental", lock: fakeLock("alpha-sync") },
          { now: () => 0, randomUUID: () => ID },
        ),
      );
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
      expect(err.message).toBe(
        `rootstock runs: ${table} does not exist — run the migrations (the table ships with rootstock 0.8.0, or is your own)`,
      );
    }
    // A query builder's wrapper quotes the whole statement (naming both
    // tables); the server's own message on its cause decides.
    const wrapped = Object.assign(
      new Error(`Failed query: ${runsStatements(SLICE.table, SLICE.lockTable).start}`),
      {
        cause: Object.assign(new Error('relation "rootstock.runs" does not exist'), {
          code: "42P01",
        }),
      },
    );
    const viaBuilder = fakeSql(SLICE);
    viaBuilder.answer("R1", wrapped);
    expect(
      (
        await refusedWith(
          startRun(
            viaBuilder.sql,
            SLICE,
            { job: "alpha-sync", mode: "incremental", lock: fakeLock("alpha-sync") },
            { now: () => 0, randomUUID: () => ID },
          ),
        )
      ).message,
    ).toStartWith("rootstock runs: rootstock.runs does not exist");
    const other = new Error("boom");
    const fake = fakeSql(SLICE);
    fake.answer("R1", other);
    expect(
      await startRun(
        fake.sql,
        SLICE,
        { job: "alpha-sync", mode: "incremental", lock: fakeLock("alpha-sync") },
        { now: () => 0, randomUUID: () => ID },
      ).catch((e: unknown) => e),
    ).toBe(other);
  });

  test("RR12: R1 answering inserted = false refuses FENCE, runs.refused, no runs.started", async () => {
    for (const inserted of [false, "f", "false"]) {
      const fake = fakeSql(SLICE);
      fake.answer("R1", [{ inserted, started_at_ms: null, settled: "[]" }]);
      const events: RunsEvent[] = [];
      const err = await refusedWith(
        startRun(
          fake.sql,
          SLICE,
          { job: "alpha-sync", mode: "incremental", lock: fakeLock("alpha-sync") },
          { now: () => 0, randomUUID: () => ID, onEvent: (e) => events.push(e) },
        ),
      );
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_FENCE");
      expect(err.message).toBe(
        `rootstock runs: the alpha-sync fence no longer names holder ${HOLDER} — the lock was lost between the gate and the run record; nothing was written`,
      );
      expect(events).toEqual([
        { type: "runs.refused", job: "alpha-sync", code: "ERR_ROOTSTOCK_RUNS_FENCE" },
      ]);
      expect(fake.calls.map((c) => c.id)).toEqual(["R1"]);
    }
  });

  test("the fence is read after the gate, in the same R1 (deterministic order)", async () => {
    // The fake session rewrites the fence inside the gate; R1 is sent only after it resolves.
    const order: string[] = [];
    const fake = fakeSql(SLICE);
    fake.answer("R1", () => {
      order.push("R1");
      return [{ inserted: false, started_at_ms: null, settled: "[]" }];
    });
    const lock = fakeLock("alpha-sync", async () => {
      order.push("gate");
      order.push("fence rewritten by another holder");
    });
    await expect(
      startRun(
        fake.sql,
        SLICE,
        { job: "alpha-sync", mode: "incremental", lock },
        { now: () => 0, randomUUID: () => ID },
      ),
    ).rejects.toThrow("fence no longer names holder");
    expect(order).toEqual(["gate", "fence rewritten by another holder", "R1"]);
  });
});

describe("RR1: count, meter, account, override and scope validation", () => {
  const INPUT = "ERR_ROOTSTOCK_RUNS_INPUT";
  test("count", async () => {
    const { run } = await setup();
    run.count("files.seen");
    run.count("files.seen", 0);
    run.count("files.seen", 4);
    for (const [args, text] of [
      [["Files"], 'count("Files"): name must match [a-z0-9_.:-]{1,64}'],
      [["a".repeat(65)], `count("${"a".repeat(65)}"): name must match [a-z0-9_.:-]{1,64}`],
      [["x", -1], 'count("x"): n must be a non-negative integer — got -1'],
      [["x", 1.5], 'count("x"): n must be a non-negative integer — got 1.5'],
      [["x", Number.NaN], 'count("x"): n must be a non-negative integer — got NaN'],
    ] as const) {
      const err = caught(() => (run.count as (...a: unknown[]) => void)(...args));
      expect((err as { code?: string }).code).toBe(INPUT);
      expect(err.message).toBe(`rootstock runs: ${text}`);
    }
  });

  test("count: more than maxCountKeys distinct names", async () => {
    const slice = runsSlice({ ...runsInput(), maxCountKeys: 2 });
    const { run } = await setup("alpha-sync", { slice });
    run.count("a");
    run.count("b");
    run.count("a", 3);
    expect(caught(() => run.count("c")).message).toBe(
      'rootstock runs: count("c"): more than maxCountKeys 2 distinct counter names',
    );
  });

  test("meter", async () => {
    const { run } = await setup();
    run.meter("model-a", 1, 2);
    for (const [args, text] of [
      [["model a", 1, 1], 'meter("model a"): model must match [A-Za-z0-9_./:-]{1,128}'],
      [["model-a", -1, 1], 'meter("model-a"): input must be a non-negative integer — got -1'],
      [["model-a", 1, 0.5], 'meter("model-a"): output must be a non-negative integer — got 0.5'],
      [
        ["model-a", 1, 1, { estimated: "yes" }],
        'meter("model-a"): opts.estimated must be true or false — got "yes"',
      ],
    ] as const) {
      const err = caught(() => (run.meter as (...a: unknown[]) => void)(...args));
      expect((err as { code?: string }).code).toBe(INPUT);
      expect(err.message).toBe(`rootstock runs: ${text}`);
    }
    const unmetered = await setup("beta-sync");
    expect(caught(() => unmetered.run.meter("model-a", 1, 1)).message).toBe(
      'rootstock runs: meter("model-a"): beta-sync is declared metered: false',
    );
  });

  test("account", async () => {
    const { run } = await setup();
    run.account({ ...ACC, excludedReasons: { "too-big": 1 } });
    for (const [a, text] of [
      [
        { ...ACC, listed: -1 },
        "listed must be a non-negative integer of at most 2147483647 — got -1",
      ],
      [
        { ...ACC, written: undefined },
        "written must be a non-negative integer of at most 2147483647 — got undefined",
      ],
      [
        { ...ACC, excluded: 2 ** 31 },
        "excluded must be a non-negative integer of at most 2147483647 — got 2147483648",
      ],
      [{ ...ACC, excludedReasons: { a: 2 } }, "excludedReasons sum to 2, not excluded 1"],
      [
        { ...ACC, excludedReasons: { a: 0.5, b: 0.5 } },
        'excludedReasons["a"] must be a non-negative integer of at most 2147483647 — got 0.5',
      ],
      [{ ...ACC, excludedReasons: [] }, "excludedReasons must be an object — got []"],
      [null, "the accounting must be an object — got null"],
    ] as const) {
      const err = caught(() => run.account(a as never));
      expect((err as { code?: string }).code).toBe(INPUT);
      expect(err.message).toBe(`rootstock runs: account(): ${text}`);
    }
    for (const key of ["", "a\u0000", "\ud800x"]) {
      const err = caught(() => run.account({ ...ACC, excludedReasons: { [key]: 1 } }));
      expect((err as { code?: string }).code).toBe(INPUT);
      expect(err.message).toStartWith(
        "rootstock runs: account(): excludedReasons keys must be non-empty with no NUL or lone surrogate — got ",
      );
    }
    expect(() => run.account({ ...ACC, excludedReasons: { "😀": 1 } })).not.toThrow();
  });

  test("RR4: a non-reconciling job: account throws INPUT", async () => {
    const { run } = await setup("beta-sync");
    const err = caught(() => run.account(ACC));
    expect((err as { code?: string }).code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(err.message).toBe("rootstock runs: account(): beta-sync is declared reconciles: false");
  });

  test("override", async () => {
    const { run } = await setup();
    run.override("brake.alpha-archive");
    expect(caught(() => run.override("Brake")).message).toBe(
      'rootstock runs: override("Brake"): flag must match [a-z0-9_.:-]{1,64}',
    );
  });

  test("scope", async () => {
    const slice = runsSlice({ ...runsInput(), maxScopeBytes: 1024 });
    const { run } = await setup("alpha-sync", { slice });
    run.scope(["a", "b"], ["c"]);
    run.scope("x".repeat(1022));
    // Bytes, not characters: "é" is two bytes of UTF-8.
    expect(caught(() => run.scope("é".repeat(512))).message).toBe(
      "rootstock runs: scope(): value is 1026 bytes of JSON, over maxScopeBytes 1024",
    );
    expect(() => run.scope("é".repeat(511))).not.toThrow();
    expect(caught(() => run.scope(["a"], "x".repeat(1023))).message).toBe(
      "rootstock runs: scope(): excluded is 1025 bytes of JSON, over maxScopeBytes 1024",
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(caught(() => run.scope(cycle)).message).toStartWith(
      "rootstock runs: scope(): value is not JSON-serializable — ",
    );
    expect(caught(() => run.scope(10n)).message).toStartWith(
      "rootstock runs: scope(): value is not JSON-serializable",
    );
    expect(caught(() => run.scope(() => 1)).message).toBe(
      "rootstock runs: scope(): value is not JSON-serializable",
    );
    expect(caught(() => run.scope(["a\u0000b"])).message).toBe(
      "rootstock runs: scope(): value contains a NUL character",
    );
    expect(caught(() => run.scope(["a", "\ud800"])).message).toBe(
      "rootstock runs: scope(): value contains a lone UTF-16 surrogate",
    );
    expect(caught(() => run.scope(["a"], { k: "\udc00x" })).message).toBe(
      "rootstock runs: scope(): excluded contains a lone UTF-16 surrogate",
    );
    // A literal backslash before "u0000" is not an escape; a paired surrogate is fine.
    expect(() => run.scope(["a\\u0000", "\\\\u0000", "😀"])).not.toThrow();
  });
});

describe("finish", () => {
  test("R2 is sent with every param, none undefined, maps in first-use order", async () => {
    const { run, fake } = await setup();
    run.count("zeta", 2);
    run.count("alpha");
    run.meter("model-b", 1_000_000, 0);
    run.meter("model-a", 1_000_000, 1_000_000);
    run.override("one");
    run.override("two");
    run.override("one");
    run.account({ ...ACC, excludedReasons: { dup: 1 } });
    run.scope(["x"], ["y"]);
    const result = await run.finish("ok", { reason: "done", phase: "load" });
    expect(result).toEqual({
      written: true,
      status: "ok",
      reconciled: true,
      costUsd: "1.750000",
      costNote: null,
    });
    expect(r2(fake)).toEqual([
      [
        ID,
        HOLDER,
        "ok",
        "load",
        10,
        4,
        3,
        2,
        1,
        true,
        '{"dup":1}',
        '{"zeta":2,"alpha":1}',
        '{"model-b":{"input":1000000,"output":0},"model-a":{"input":1000000,"output":1000000}}',
        "1.750000",
        null,
        '["x"]',
        '["y"]',
        '["one","two"]',
        "done",
      ],
    ]);
  });

  test("RR2: identity balanced → reconciled true; unbalanced ok → failed with the frozen reason", async () => {
    const a = await setup();
    a.run.account(ACC);
    expect(await a.run.finish("ok")).toMatchObject({ status: "ok", reconciled: true });
    expect(r2(a.fake)[0]?.[18]).toBeNull();

    const b = await setup();
    b.run.account({ ...ACC, listed: 11 });
    expect(await b.run.finish("ok")).toMatchObject({
      written: true,
      status: "failed",
      reconciled: false,
    });
    const reason =
      "rootstock runs: listed 11 != accounted 10 (written 4 + unchanged 3 + quarantined 2 + excluded 1)";
    expect(r2(b.fake)[0]?.[2]).toBe("failed");
    expect(r2(b.fake)[0]?.[18]).toBe(reason);
    expect(b.events.find((e) => e.type === "runs.identity_failed")).toEqual({
      type: "runs.identity_failed",
      id: ID,
      job: "alpha-sync",
      listed: 11,
      accounted: 10,
    });
    expect(b.types().slice(-2)).toEqual(["runs.identity_failed", "runs.finished"]);

    // Over-accounted is unbalanced too (the `===`, not `>=`).
    const over = await setup();
    over.run.account({ ...ACC, listed: 9 });
    expect(await over.run.finish("ok")).toMatchObject({ status: "failed", reconciled: false });

    const c = await setup();
    c.run.account({ ...ACC, listed: 12 });
    expect(await c.run.finish("failed", { reason: "source timed out" })).toMatchObject({
      status: "failed",
      reconciled: false,
    });
    expect(r2(c.fake)[0]?.[18]).toBe(
      "rootstock runs: listed 12 != accounted 10 (written 4 + unchanged 3 + quarantined 2 + excluded 1); source timed out",
    );
  });

  test("RR3: a reconciling job finishing without account → failed, NULL buckets, reconciled false", async () => {
    const { run, fake, events } = await setup();
    expect(await run.finish("ok", { reason: "x" })).toMatchObject({
      status: "failed",
      reconciled: false,
    });
    const p = r2(fake)[0] ?? [];
    expect(p.slice(2, 11)).toEqual(["failed", null, null, null, null, null, null, false, null]);
    expect(p[18]).toBe("rootstock runs: alpha-sync reconciles but finished without accounting; x");
    expect(events.find((e) => e.type === "runs.identity_failed")).toEqual({
      type: "runs.identity_failed",
      id: ID,
      job: "alpha-sync",
      listed: null,
      accounted: null,
    });
  });

  test("RR4: a non-reconciling job: buckets NULL", async () => {
    const { run, fake } = await setup("beta-sync");
    expect(await run.finish("ok")).toEqual({
      written: true,
      status: "ok",
      reconciled: null,
      costUsd: null,
      costNote: "unmetered",
    });
    expect((r2(fake)[0] ?? []).slice(4, 11)).toEqual([null, null, null, null, null, null, null]);
  });

  test("RR6c: a refused finish on a reconciling job without account: NULL buckets, reconciled NULL", async () => {
    const { run, fake, events } = await setup();
    expect(await run.finish("refused", { reason: "brake" })).toMatchObject({
      status: "refused",
      reconciled: null,
    });
    const p = r2(fake)[0] ?? [];
    expect(p.slice(2, 11)).toEqual(["refused", null, null, null, null, null, null, null, null]);
    expect(p[18]).toBe("brake");
    expect(events.some((e) => e.type === "runs.identity_failed")).toBe(false);
  });

  test("RR6c: a refused finish after account(): buckets and reconciled NULL, counts, tokens and cost kept (A11)", async () => {
    const { run, fake, events } = await setup();
    run.account({ listed: 3, written: 1, unchanged: 0, quarantined: 0, excluded: 0 });
    run.count("pages", 2);
    run.meter("model-a", 1_000_000, 0);
    expect(await run.finish("refused")).toMatchObject({
      status: "refused",
      reconciled: null,
      costUsd: "0.100000",
    });
    const p = r2(fake)[0] ?? [];
    expect(p.slice(2, 11)).toEqual(["refused", null, null, null, null, null, null, null, null]);
    expect(p[11]).toBe('{"pages":2}');
    expect(p[12]).toBe('{"model-a":{"input":1000000,"output":0}}');
    expect(events.some((e) => e.type === "runs.identity_failed")).toBe(false);
  });

  test("RR5: cost", async () => {
    const unmetered = await setup("beta-sync");
    expect(await unmetered.run.finish("ok")).toMatchObject({
      costUsd: null,
      costNote: "unmetered",
    });

    const none = await setup("gamma-push");
    expect(await none.run.finish("ok")).toMatchObject({ costUsd: "0.000000", costNote: null });

    // 3 × 0.1 drifts in floats (0.30000000000000004); micro-dollars do not.
    const drift = await setup("gamma-push");
    for (let i = 0; i < 3; i++) drift.run.meter("model-a", 1, 0);
    drift.run.meter("model-a", 999_999, 0);
    expect(await drift.run.finish("ok")).toMatchObject({ costUsd: "0.100000", costNote: null });
    // 0.7 $/MTok × 45 tokens is 31.5 micro: half up gives 32, while the float
    // product 31.499999999999996 would round to 31.
    const divergent = await setup("gamma-push");
    divergent.run.meter("model-c", 45, 0);
    expect(await divergent.run.finish("ok")).toMatchObject({ costUsd: "0.000032" });
    const exact = await setup("gamma-push");
    exact.run.meter("model-a", 3_000_000, 0);
    expect(await exact.run.finish("ok")).toMatchObject({ costUsd: "0.300000" });

    const unpriced = await setup("gamma-push");
    unpriced.run.meter("model-x", 10, 10);
    unpriced.run.meter("model-a", 10, 10);
    expect(await unpriced.run.finish("ok")).toMatchObject({
      costUsd: null,
      costNote: "unpriced:model-x",
    });
    expect(r2(unpriced.fake)[0]?.[12]).toBe(
      '{"model-x":{"input":10,"output":10},"model-a":{"input":10,"output":10}}',
    );

    const many = await setup("gamma-push");
    many.run.meter("model-z", 1, 1);
    many.run.meter("model-y", 1, 1);
    expect(await many.run.finish("ok")).toMatchObject({ costNote: "unpriced:model-y,model-z" });

    const long = await setup("gamma-push");
    for (const m of ["b", "a", "c"]) long.run.meter(m.repeat(128), 1, 1);
    const note = ((await long.run.finish("ok")) as { costNote: string }).costNote;
    expect(note).toBe(`unpriced:${`${"a".repeat(128)},${"b".repeat(128)}`.slice(0, 200)}`);

    const estimated = await setup("gamma-push");
    estimated.run.meter("model-b", 2_000_000, 100_000, { estimated: true });
    estimated.run.meter("model-b", 0, 0, { estimated: false });
    expect(await estimated.run.finish("ok")).toMatchObject({
      costUsd: "3.500000",
      costNote: "estimated",
    });
  });

  test("RR11: cost precedence and half-up rounding", async () => {
    const both = await setup("gamma-push");
    both.run.meter("model-a", 1, 1, { estimated: true });
    both.run.meter("model-x", 1, 1);
    expect(await both.run.finish("ok")).toMatchObject({
      costUsd: null,
      costNote: "unpriced:model-x",
    });
    // model-a input 0.1 $/MTok = 100 000 micro per MTok: 5 tokens = 0.5 micro → 1 (half up).
    const half = await setup("gamma-push");
    half.run.meter("model-a", 5, 0);
    expect(await half.run.finish("ok")).toMatchObject({ costUsd: "0.000001" });
    const below = await setup("gamma-push");
    below.run.meter("model-a", 4, 0);
    expect(await below.run.finish("ok")).toMatchObject({ costUsd: "0.000000" });
  });

  test("reason is cut to maxReasonChars by code point; NUL becomes U+FFFD; phase validated", async () => {
    const slice = runsSlice({ ...runsInput(), maxReasonChars: 64 });
    const a = await setup("beta-sync", { slice });
    await a.run.finish("failed", { reason: `${"x".repeat(63)}😀tail` });
    expect(r2(a.fake)[0]?.[18]).toBe(`${"x".repeat(63)}😀`);
    const b = await setup("beta-sync");
    await b.run.finish("failed", { reason: "a\u0000b" });
    expect(r2(b.fake)[0]?.[18]).toBe("a�b");

    const c = await setup("beta-sync");
    await expect(c.run.finish("ok", { phase: "Load" })).rejects.toThrow(
      'rootstock runs: finish(): phase must match [a-z0-9_.:-]{1,32} — got "Load"',
    );
    await expect(c.run.finish("interrupted" as never)).rejects.toThrow(
      'rootstock runs: finish(): status must be "ok", "failed" or "refused" — got "interrupted"',
    );
    await expect(c.run.finish("ok", { reason: 1 as never })).rejects.toThrow(
      "rootstock runs: finish(): reason must be a string — got 1",
    );
    // A refused argument does not begin the finish.
    c.run.count("still-open");
    expect(await c.run.finish("ok", { phase: "load" })).toMatchObject({ written: true });
    expect(c.fake.calls.map((x) => x.id)).toEqual(["R1", "R2"]);
  });

  test("RR6: finish twice returns the first result and sends one R2; calls after finish throw FINISHED", async () => {
    const { run, fake } = await setup("beta-sync");
    const first = run.finish("ok");
    const second = run.finish("failed");
    expect(second).toBe(first);
    expect(await second).toMatchObject({ status: "ok" });
    expect(r2(fake)).toHaveLength(1);
    expect(await run.discard()).toMatchObject({ status: "ok" });
    for (const [call, fn] of [
      ["count", () => run.count("x")],
      ["meter", () => run.meter("model-a", 1, 1)],
      ["account", () => run.account(ACC)],
      ["override", () => run.override("x")],
      ["scope", () => run.scope([])],
    ] as const) {
      const err = caught(fn);
      expect((err as { code?: string }).code).toBe("ERR_ROOTSTOCK_RUNS_FINISHED");
      expect(err.message).toBe(
        `rootstock runs: run ${ID} (beta-sync) already finished — ${call}() after finish() or discard()`,
      );
    }
  });

  test("RR6: discard then finish → discarded", async () => {
    const { run, fake, types } = await setup();
    const d = run.discard();
    expect(caught(() => run.count("x")).message).toContain("count() after finish() or discard()");
    expect(await run.finish("ok")).toEqual({ written: false, why: "discarded" });
    expect(await d).toEqual({ written: false, why: "discarded" });
    expect(fake.calls).toEqual([
      { id: "R1", params: [ID, "alpha-sync", "incremental", "alpha-sync", HOLDER] },
      { id: "R3", params: [ID, HOLDER] },
    ]);
    expect(types()).toEqual(["runs.started", "runs.discarded"]);
  });

  test("RR6b: a discard whose R3 deletes no row → settled-elsewhere, never runs.discarded", async () => {
    const { run, fake, events } = await setup();
    fake.answer("R3", []);
    expect(await run.discard()).toEqual({ written: false, why: "settled-elsewhere" });
    expect(events.slice(1)).toEqual([
      { type: "runs.settled_elsewhere", id: ID, job: "alpha-sync" },
    ]);
  });

  test("a discard whose R3 rejects → record_failed, why error, never throws", async () => {
    const { run, fake, events } = await setup();
    const boom = Object.assign(new Error("gone"), { code: "57P01" });
    fake.answer("R3", boom);
    expect(await run.discard()).toEqual({ written: false, why: "error", error: boom });
    expect(events.slice(1)).toEqual([
      {
        type: "runs.record_failed",
        id: ID,
        job: "alpha-sync",
        operation: "discard",
        error: boom,
        code: "57P01",
      },
    ]);
  });

  test("RR7: finish with R2 rejecting → { written: false, why: error }, runs.record_failed, never throws", async () => {
    const { run, fake, events } = await setup("beta-sync");
    const boom = Object.assign(new Error("check"), { code: "23514" });
    fake.answer("R2", boom);
    expect(await run.finish("ok")).toEqual({ written: false, why: "error", error: boom });
    expect(r2(fake)).toHaveLength(1);
    expect(events.slice(1)).toEqual([
      {
        type: "runs.record_failed",
        id: ID,
        job: "beta-sync",
        operation: "finish",
        error: boom,
        code: "23514",
      },
    ]);
    const missing = await setup("beta-sync");
    missing.fake.answer("R2", Object.assign(new Error("no table"), { code: "42P01" }));
    expect(await missing.run.finish("ok")).toMatchObject({ written: false, why: "error" });
  });

  test("A13: one connection failure on R2 is retried once after sleep(1000) and the row settles ok", async () => {
    const lost = [
      Object.assign(new Error("admin shutdown"), { code: "57P01" }),
      Object.assign(new Error("socket"), { code: "08006" }),
      Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" }),
      Object.assign(new Error("closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" }),
      new Error("wrapped", { cause: Object.assign(new Error("reset"), { errno: "ECONNRESET" }) }),
    ];
    for (const failure of lost) {
      const fake = fakeSql(SLICE);
      const events: RunsEvent[] = [];
      const slept: number[] = [];
      const run = await startRun(
        fake.sql,
        SLICE,
        { job: "beta-sync", mode: "incremental", lock: fakeLock("shared-write") },
        {
          now: () => STARTED_MS,
          randomUUID: () => ID,
          sleep: async (ms) => void slept.push(ms),
          onEvent: (e) => events.push(e),
        },
      );
      fake.answer("R2", failure);
      expect(await run.finish("ok")).toMatchObject({ written: true, status: "ok" });
      expect(slept).toEqual([1000]);
      expect(r2(fake)).toHaveLength(2);
      expect(events.map((e) => e.type)).toEqual(["runs.started", "runs.finished"]);
    }
  });

  test("A13: a second connection failure is cached; without deps.sleep the retry runs at once", async () => {
    const { run, fake, events } = await setup("beta-sync");
    const first = Object.assign(new Error("conn"), { code: "08006" });
    const second = Object.assign(new Error("conn"), { code: "08003" });
    fake.answer("R2", first, second);
    expect(await run.finish("ok")).toEqual({ written: false, why: "error", error: second });
    expect(await run.finish("ok")).toEqual({ written: false, why: "error", error: second });
    expect(r2(fake)).toHaveLength(2);
    expect(events.slice(1).map((e) => e.type)).toEqual(["runs.record_failed"]);
  });

  test("RR8: finish with R2 returning no row → settled-elsewhere", async () => {
    const after: RunRow[] = [];
    const { run, fake, events } = await setup("alpha-sync", {
      afterRun: (r) => void after.push(r),
    });
    fake.answer("R2", []);
    run.account(ACC);
    expect(await run.finish("ok")).toEqual({ written: false, why: "settled-elsewhere" });
    expect(events.slice(1)).toEqual([
      { type: "runs.settled_elsewhere", id: ID, job: "alpha-sync" },
    ]);
    expect(after).toEqual([]);
  });

  test("RR10: afterRun throwing → runs.after_run_failed, finish still resolves written", async () => {
    const boom = new Error("ledger down");
    const seen: RunRow[] = [];
    const sync = await setup("beta-sync", {
      afterRun: (r) => {
        seen.push(r);
        throw boom;
      },
    });
    expect(await sync.run.finish("ok")).toMatchObject({ written: true, status: "ok" });
    expect(sync.events.slice(-2)).toEqual([
      {
        type: "runs.finished",
        id: ID,
        job: "beta-sync",
        status: "ok",
        reconciled: null,
        costUsd: null,
        costNote: "unmetered",
      },
      { type: "runs.after_run_failed", id: ID, job: "beta-sync", error: boom },
    ]);
    expect(seen[0]).toMatchObject({ id: ID, status: "ok", costNote: "unmetered" });
    expect(seen[0]?.startedAt).toEqual(new Date(STARTED_MS));

    const rejecting = await setup("beta-sync", { afterRun: async () => Promise.reject(boom) });
    expect(await rejecting.run.finish("ok")).toMatchObject({ written: true });
    expect(rejecting.types().at(-1)).toBe("runs.after_run_failed");

    // Awaited before finish resolves.
    let done = false;
    const slow = await setup("beta-sync", {
      afterRun: async () => {
        await Bun.sleep(5);
        done = true;
      },
    });
    await slow.run.finish("ok");
    expect(done).toBe(true);

    // Never after discard or settled-elsewhere.
    const calls: string[] = [];
    const d = await setup("beta-sync", { afterRun: () => void calls.push("d") });
    await d.run.discard();
    const e = await setup("beta-sync", { afterRun: () => void calls.push("e") });
    e.fake.answer("R2", []);
    await e.run.finish("ok");
    expect(calls).toEqual([]);
  });
});

describe("runsSnapshot and pruneRuns", () => {
  const row = (over: Record<string, unknown>) => ({
    id: ID,
    job: "beta-sync",
    mode: "incremental",
    status: "ok",
    phase: null,
    lockName: "shared-write",
    holder: HOLDER,
    startedAtMs: "1000",
    finishedAtMs: "2000",
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
    costNote: "unmetered",
    scope: null,
    scopeExcluded: null,
    overrides: [],
    reason: null,
    ...over,
  });

  test("an empty list sends nothing; an undeclared job refuses JOB; rows parse in input order", async () => {
    const fake = fakeSql(SLICE);
    expect((await runsSnapshot(fake.sql, SLICE, [])).size).toBe(0);
    expect(fake.calls).toEqual([]);
    await expect(runsSnapshot(fake.sql, SLICE, ["beta-sync", "omega"])).rejects.toThrow(
      '"omega" is not a job this config declares',
    );
    expect(fake.calls).toEqual([]);
    fake.answer("R4", [
      {
        job: "delta:one",
        total: "3",
        newest_settled: JSON.stringify(row({ status: "failed", job: "delta:one" })),
        newest_ok: null,
        running: JSON.stringify([
          { ...row({ status: "running", finishedAtMs: null }), live: true, heartbeatAtMs: "5000" },
          {
            ...row({ status: "running", finishedAtMs: null, id: "x" }),
            live: false,
            heartbeatAtMs: null,
          },
        ]),
      },
      { job: "beta-sync", total: "0", newest_settled: null, newest_ok: null, running: null },
    ]);
    const snap = await runsSnapshot(fake.sql, SLICE, ["delta:one", "beta-sync"]);
    expect([...snap.keys()]).toEqual(["delta:one", "beta-sync"]);
    expect(fake.calls).toEqual([{ id: "R4", params: ['["delta:one","beta-sync"]'] }]);
    const d = snap.get("delta:one");
    expect(d?.total).toBe(3);
    expect(d?.newestSettled?.status).toBe("failed");
    expect(d?.newestSettled?.finishedAt).toEqual(new Date(2000));
    expect(d?.newestOk).toBeNull();
    expect(d?.running.map((r) => [r.id, r.live, r.finishedAt, r.heartbeatAt])).toEqual([
      [ID, true, null, new Date(5000)],
      ["x", false, null, null],
    ]);
    expect(snap.get("beta-sync")).toEqual({
      total: 0,
      newestSettled: null,
      newestOk: null,
      running: [],
    });
  });

  test("R4 and R5 42P01 refuse NOTABLE; prune emits runs.pruned", async () => {
    const fake = fakeSql(SLICE);
    const missing = Object.assign(new Error('relation "rootstock.runs" does not exist'), {
      code: "42P01",
    });
    fake.answer("R4", missing);
    fake.answer("R5", missing);
    await expect(runsSnapshot(fake.sql, SLICE, ["beta-sync"])).rejects.toMatchObject({
      code: "ERR_ROOTSTOCK_RUNS_NOTABLE",
    });
    await expect(pruneRuns(fake.sql, SLICE)).rejects.toMatchObject({
      code: "ERR_ROOTSTOCK_RUNS_NOTABLE",
    });
    fake.answer("R5", [{ deleted: "7" }]);
    const events: RunsEvent[] = [];
    expect(await pruneRuns(fake.sql, SLICE, { onEvent: (e) => events.push(e) })).toBe(7);
    expect(fake.calls.at(-1)).toEqual({ id: "R5", params: [30] });
    expect(events).toEqual([{ type: "runs.pruned", deleted: 7 }]);
  });
});

describe("RR9: statements", () => {
  const T = runsStatements({ schema: "rs_a", name: "rr" }, { schema: "rs_b", name: "ll" });
  const ALL: [string, string, number][] = [
    ["R1", T.start, 5],
    ["R2", T.finish, 19],
    ["R3", T.discard, 2],
    ["R4", T.snapshot, 1],
    ["R5", T.prune, 1],
  ];
  for (const [id, text, params] of ALL) {
    test(`${id}: placeholders 1..${params} only, each referenced, no comment`, () => {
      const used = new Set<number>();
      const stripped = text.replace(/\$([1-9][0-9]*)/g, (m, n: string) => {
        const i = Number(n);
        if (i > params) return m;
        used.add(i);
        return "";
      });
      expect(stripped).not.toMatch(/\$\d/);
      expect([...used].sort((a, b) => a - b)).toEqual(
        Array.from({ length: params }, (_, i) => i + 1),
      );
      expect(text).not.toContain("--");
    });
    test(`${id}: the tables appear only quoted`, () => {
      const rest = text.replaceAll('"rs_a"."rr"', "").replaceAll('"rs_b"."ll"', "");
      expect(rest).not.toMatch(/\brs_a\b|\brs_b\b|\brr\b|\bll\b/);
    });
  }

  test("every call binds its statement's param count and no undefined", async () => {
    const { run, fake } = await setup();
    run.account(ACC);
    await run.finish("ok");
    const d = await setup();
    await d.run.discard();
    await runsSnapshot(fake.sql, SLICE, ["alpha-sync"]);
    await pruneRuns(fake.sql, SLICE);
    const counts: Record<Id, number> = { R1: 5, R2: 19, R3: 2, R4: 1, R5: 1 };
    const calls = [...fake.calls, ...d.fake.calls];
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(["R1", "R2", "R3", "R4", "R5"]));
    for (const c of calls) {
      expect(c.params).toHaveLength(counts[c.id]);
      expect(c.params.includes(undefined)).toBe(false);
    }
  });

  /** The text of contract §3.2–§3.4, verbatim, with `<R>`, `<L>`, `<P(r)>` and `<HELD(x)>` as written there. */
  const FROZEN = {
    P: `jsonb_build_object(
  'id', r.id::text, 'job', r.job, 'mode', r.mode, 'status', r.status, 'phase', r.phase,
  'lockName', r.lock_name, 'holder', r.holder::text,
  'startedAtMs', floor(extract(epoch FROM r.started_at) * 1000)::text,
  'finishedAtMs', floor(extract(epoch FROM r.finished_at) * 1000)::text,
  'listed', r.listed, 'written', r.written, 'unchanged', r.unchanged,
  'quarantined', r.quarantined, 'excluded', r.excluded_count, 'reconciled', r.reconciled,
  'excludedReasons', r.excluded_reasons, 'counts', r.counts, 'tokens', r.tokens,
  'costUsd', r.cost_usd::text, 'costNote', r.cost_note,
  'scope', r.scope, 'scopeExcluded', r.scope_excluded, 'overrides', r.overrides,
  'reason', r.reason)`,
    R1: `WITH fence AS (
  SELECT 1 AS ok FROM <L> l WHERE l.name = $4::text AND l.holder = $5::uuid
),
settled AS (
  UPDATE <R> SET status = 'interrupted', finished_at = clock_timestamp(),
    reason = coalesce(reason, 'interrupted: still running when run ' || $1::text || ' took the ' || $4::text || ' lock')
  WHERE lock_name = $4::text AND status = 'running' AND holder <> $5::uuid
    AND EXISTS (SELECT 1 FROM fence)
  RETURNING id::text AS id, job
),
ins AS (
  INSERT INTO <R> (id, job, mode, status, lock_name, holder, started_at)
  SELECT $1::uuid, $2::text, $3::text, 'running', $4::text, $5::uuid, clock_timestamp()
  WHERE EXISTS (SELECT 1 FROM fence)
  RETURNING floor(extract(epoch FROM started_at) * 1000)::text AS started_at_ms
)
SELECT EXISTS (SELECT 1 FROM ins) AS inserted,
       (SELECT started_at_ms FROM ins) AS started_at_ms,
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'job', job) ORDER BY id) FROM settled),
                '[]'::jsonb)::text AS settled`,
    R2: `UPDATE <R> AS r SET
  status = $3::text, phase = $4::text, finished_at = clock_timestamp(),
  listed = $5::int, written = $6::int, unchanged = $7::int, quarantined = $8::int,
  excluded_count = $9::int, reconciled = $10::boolean,
  excluded_reasons = coalesce($11::text::jsonb, '{}'::jsonb),
  counts = coalesce($12::text::jsonb, '{}'::jsonb),
  tokens = coalesce($13::text::jsonb, '{}'::jsonb),
  cost_usd = $14::text::numeric, cost_note = $15::text,
  scope = $16::text::jsonb, scope_excluded = $17::text::jsonb,
  overrides = coalesce($18::text::jsonb, '[]'::jsonb),
  reason = $19::text
WHERE r.id = $1::uuid AND r.holder = $2::uuid AND r.status = 'running'
RETURNING <P(r)>::text AS row`,
    R3: "DELETE FROM <R> WHERE id = $1::uuid AND holder = $2::uuid AND status = 'running' RETURNING 1 AS ok",
    // R4 as amended by §20 A9: each running row also carries its fence's last beat.
    R4: `SELECT j.job,
  (SELECT count(*) FROM <R> r WHERE r.job = j.job)::text AS total,
  (SELECT <P(r)> FROM <R> r WHERE r.job = j.job AND r.status <> 'running'
     ORDER BY r.started_at DESC, r.id DESC LIMIT 1)::text AS newest_settled,
  (SELECT <P(r)> FROM <R> r WHERE r.job = j.job AND r.status = 'ok'
     ORDER BY r.started_at DESC, r.id DESC LIMIT 1)::text AS newest_ok,
  (SELECT jsonb_agg(<P(r)> || jsonb_build_object('live',
            EXISTS (SELECT 1 FROM <L> l WHERE l.name = r.lock_name AND l.holder = r.holder)
            AND <HELD(r.lock_name)>,
            'heartbeatAtMs', (SELECT floor(extract(epoch FROM l.heartbeat_at) * 1000)::text
              FROM <L> l WHERE l.name = r.lock_name AND l.holder = r.holder))
          ORDER BY r.started_at, r.id)
     FROM <R> r WHERE r.job = j.job AND r.status = 'running')::text AS running
FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS j(job, i)
ORDER BY j.i`,
    R5: `WITH d AS (
  DELETE FROM <R> r
  WHERE r.status <> 'running'
    AND r.started_at < clock_timestamp() - make_interval(days => $1::int)
    AND r.id IS DISTINCT FROM (
      SELECT k.id FROM <R> k WHERE k.job = r.job AND k.status = 'ok'
      ORDER BY k.started_at DESC, k.id DESC LIMIT 1)
    AND r.id IS DISTINCT FROM (
      SELECT k.id FROM <R> k WHERE k.job = r.job AND k.status <> 'running'
      ORDER BY k.started_at DESC, k.id DESC LIMIT 1)
  RETURNING 1
)
SELECT count(*)::text AS deleted FROM d`,
  };
  const fill = (text: string) =>
    text
      .replaceAll("<P(r)>", FROZEN.P)
      .replaceAll("<HELD(r.lock_name)>", LOCK_HELD_PREDICATE.replaceAll("$1", "r.lock_name"))
      .replaceAll("<R>", '"rs_a"."rr"')
      .replaceAll("<L>", '"rs_b"."ll"');

  test("each statement is the frozen text", () => {
    expect(PROJECTION).toBe(FROZEN.P);
    expect(T.start).toBe(fill(FROZEN.R1));
    expect(T.finish).toBe(fill(FROZEN.R2));
    expect(T.discard).toBe(fill(FROZEN.R3));
    expect(T.snapshot).toBe(fill(FROZEN.R4));
    expect(T.prune).toBe(fill(FROZEN.R5));
    expect(Object.isFrozen(T)).toBe(true);
  });
});
