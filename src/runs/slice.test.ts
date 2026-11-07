import { describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import type { RunLock } from "../lock/index.ts";
import { RUNS_INPUT, runsInput } from "./fixtures.test-support.ts";
import { startRun } from "./record.ts";
import { jobDecl, lockNameFor, priceMicros, type RunsSlice, runsSlice } from "./slice.ts";

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};
const parse = (path: string[], value?: unknown) => runsSlice(runsInput(path, value));
const refuses = (path: string[], value: unknown) => refusal(() => parse(path, value));

const job = (key: string, over: Record<string, unknown>) => ({
  ...(RUNS_INPUT.jobs[key] as object),
  ...over,
});

describe("runsSlice", () => {
  test("the synthetic slice parses, resolved, frozen, defaults applied", () => {
    const s = runsSlice(runsInput());
    expect(s.table).toEqual({ schema: "rootstock", name: "runs" });
    expect(s.lockTable).toEqual({ schema: "rootstock", name: "run_locks" });
    expect(s.quarantine).toBeNull();
    expect(Object.keys(s.jobs)).toEqual(["alpha-sync", "beta-sync", "gamma-push", "delta:*"]);
    expect(s.jobs["alpha-sync"]).toEqual({
      key: "alpha-sync",
      lock: "alpha-sync",
      modes: ["incremental", "backfill"],
      reconciles: true,
      metered: true,
      maxAgeHours: 24,
      interruptedGraceHours: 2,
      push: null,
      counters: { archived: "archived", written: "written" },
      spike: { share: 0.1, allowance: 50 },
    });
    expect(s.jobs["beta-sync"]?.counters).toEqual({});
    expect(s.prices["model-a"]).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.4 });
    const app = runsSlice(runsInput(), { schema: "app" });
    expect(app.table).toEqual({ schema: "app", name: "runs" });
    expect(app.lockTable).toEqual({ schema: "app", name: "run_locks" });
    const bare = parse(["brakes"], undefined);
    expect(bare.brakes).toEqual({});
    expect(runsSlice({ ...runsInput(["budgets"]), breakers: undefined }).budgets).toEqual({});
  });

  test("a given quarantine parses through the quarantine parser, bounds required", () => {
    const s = parse(["quarantine"], { maxPayloadBytes: 1024, maxReasonChars: 16 });
    expect(s.quarantine?.table).toEqual({ schema: "rootstock", name: "quarantine" });
    expect(s.quarantine?.columns.runId).toBe("run_id");
    expect(refuses(["quarantine"], { maxPayloadBytes: 1024 })).toBe(
      "runsSlice: quarantine.maxReasonChars is required",
    );
    expect(refuses(["quarantine"], { maxPayloadBytes: 1023, maxReasonChars: 16 })).toBe(
      "runsSlice: quarantine.maxPayloadBytes must be an integer from 1024 to 16777216 — got 1023",
    );
    expect(refuses(["quarantine"], "x")).toBe('runsSlice: quarantine must be an object — got "x"');
  });

  describe("RS1: every bound refuses one step past it and accepts the bound itself", () => {
    const J = "jobs.alpha-sync";
    // [label, path, accepted values, refused value, refusal text tail]
    const cases: [string, string[], unknown[], unknown, string][] = [
      [
        "modes 16",
        ["modes"],
        [Array.from({ length: 16 }, (_, i) => (i < 4 ? RUNS_INPUT.modes[i] : `m${i}`))],
        Array.from({ length: 17 }, (_, i) => (i < 4 ? RUNS_INPUT.modes[i] : `m${i}`)),
        "modes must be an array of 1 to 16 names",
      ],
      ["modes empty", ["modes"], [], [], "modes must be an array of 1 to 16 names — got []"],
      [
        "mode name shape",
        ["modes", "0"],
        ["incremental"],
        "Incremental",
        'modes[0] must be a unique name matching [a-z0-9][a-z0-9_.:-]{0,63} — got "Incremental"',
      ],
      [
        "mode name length",
        ["modes"],
        [[...RUNS_INPUT.modes, "m".repeat(64)]],
        [...RUNS_INPUT.modes, "m".repeat(65)],
        "modes[4] must be a unique name",
      ],
      [
        "maxAgeHours",
        ["jobs", "alpha-sync", "maxAgeHours"],
        [8760, 2],
        8760.5,
        `${J}.maxAgeHours must be a finite number above 0 and at most 8760 — got 8760.5`,
      ],
      [
        "maxAgeHours 0",
        ["jobs", "alpha-sync", "maxAgeHours"],
        [2.5],
        0,
        `${J}.maxAgeHours must be a finite number above 0 and at most 8760 — got 0`,
      ],
      [
        "maxAgeHours Infinity",
        ["jobs", "alpha-sync", "maxAgeHours"],
        [],
        Number.POSITIVE_INFINITY,
        `${J}.maxAgeHours must be a finite number above 0 and at most 8760 — got Infinity`,
      ],
      [
        "grace ≤ maxAge",
        ["jobs", "alpha-sync", "interruptedGraceHours"],
        [24, 0],
        24.01,
        `${J}.interruptedGraceHours must be a finite number from 0 to maxAgeHours (24) — got 24.01`,
      ],
      [
        "grace ≥ 0",
        ["jobs", "alpha-sync", "interruptedGraceHours"],
        [],
        -0.5,
        `${J}.interruptedGraceHours must be a finite number from 0 to maxAgeHours (24) — got -0.5`,
      ],
      [
        "push.maxAgeHours",
        ["jobs", "gamma-push", "push", "maxAgeHours"],
        [8760],
        8761,
        "jobs.gamma-push.push.maxAgeHours must be a finite number above 0 and at most 8760 — got 8761",
      ],
      [
        "spike.share",
        ["jobs", "alpha-sync", "spike", "share"],
        [0.5, 0.0001],
        0.5001,
        `${J}.spike.share must be a number above 0 and at most 0.5 with at most 4 decimal places — got 0.5001`,
      ],
      [
        "spike.share 0",
        ["jobs", "alpha-sync", "spike", "share"],
        [],
        0,
        `${J}.spike.share must be a number above 0`,
      ],
      [
        "spike.allowance",
        ["jobs", "alpha-sync", "spike", "allowance"],
        [0, 1_000_000],
        1_000_001,
        `${J}.spike.allowance must be an integer from 0 to 1000000 — got 1000001`,
      ],
      [
        "spike.allowance -1",
        ["jobs", "alpha-sync", "spike", "allowance"],
        [],
        -1,
        `${J}.spike.allowance must be an integer from 0 to 1000000 — got -1`,
      ],
      [
        "brake share",
        ["brakes", "alpha-archive", "share"],
        [0.5],
        0.51,
        "brakes.alpha-archive.share must be a number above 0 and at most 0.5",
      ],
      [
        "brake allowance",
        ["brakes", "alpha-archive", "allowance"],
        [0, 1_000_000],
        1_000_001,
        "brakes.alpha-archive.allowance must be an integer from 0 to 1000000",
      ],
      [
        "brake armAt",
        ["brakes", "alpha-archive", "armAt"],
        [0, 1_000_000],
        1.5,
        "brakes.alpha-archive.armAt must be an integer from 0 to 1000000 — got 1.5",
      ],
      [
        "brake rounding",
        ["brakes", "alpha-archive", "rounding"],
        ["none", "ceil"],
        "floor",
        'brakes.alpha-archive.rounding must be "ceil" or "none" — got "floor"',
      ],
      [
        "price max",
        ["prices", "model-a", "inputPerMTok"],
        [10_000, 0],
        10_000.000001,
        "prices.model-a.inputPerMTok must be a finite number from 0 to 10000",
      ],
      [
        "price negative",
        ["prices", "model-a", "outputPerMTok"],
        [],
        -0.000001,
        "prices.model-a.outputPerMTok must be a finite number from 0 to 10000",
      ],
      [
        "price NaN",
        ["prices", "model-a", "outputPerMTok"],
        [],
        Number.NaN,
        "prices.model-a.outputPerMTok must be a finite number from 0 to 10000 — got NaN",
      ],
      [
        "budget limit",
        ["budgets", "alpha-calls", "limit"],
        [1, 1_000_000],
        0,
        "budgets.alpha-calls.limit must be an integer from 1 to 1000000 — got 0",
      ],
      [
        "budget limit high",
        ["budgets", "alpha-calls", "limit"],
        [],
        1_000_001,
        "budgets.alpha-calls.limit must be an integer from 1 to 1000000",
      ],
      [
        "budget window",
        ["budgets", "alpha-calls", "windowMinutes"],
        [1, 10_080],
        10_081,
        "budgets.alpha-calls.windowMinutes must be an integer from 1 to 10080 — got 10081",
      ],
      [
        "budget window 0",
        ["budgets", "alpha-calls", "windowMinutes"],
        [],
        0,
        "budgets.alpha-calls.windowMinutes must be an integer from 1 to 10080",
      ],
      [
        "breaker limit",
        ["breakers", "alpha-quota", "limit"],
        [1, 100],
        101,
        "breakers.alpha-quota.limit must be an integer from 1 to 100 — got 101",
      ],
      [
        "breaker limit 0",
        ["breakers", "alpha-quota", "limit"],
        [],
        0,
        "breakers.alpha-quota.limit must be an integer from 1 to 100",
      ],
      [
        "keepDays",
        ["retention", "keepDays"],
        [7, 3_650],
        6,
        "retention.keepDays must be an integer from 7 to 3650 — got 6",
      ],
      [
        "keepDays high",
        ["retention", "keepDays"],
        [],
        3_651,
        "retention.keepDays must be an integer from 7 to 3650",
      ],
      [
        "maxCountKeys",
        ["maxCountKeys"],
        [1, 500],
        501,
        "maxCountKeys must be an integer from 1 to 500 — got 501",
      ],
      ["maxCountKeys 0", ["maxCountKeys"], [], 0, "maxCountKeys must be an integer from 1 to 500"],
      [
        "maxReasonChars",
        ["maxReasonChars"],
        [64, 10_000],
        63,
        "maxReasonChars must be an integer from 64 to 10000 — got 63",
      ],
      [
        "maxReasonChars high",
        ["maxReasonChars"],
        [],
        10_001,
        "maxReasonChars must be an integer from 64 to 10000",
      ],
      [
        "maxScopeBytes",
        ["maxScopeBytes"],
        [1_024, 4_194_304],
        4_194_305,
        "maxScopeBytes must be an integer from 1024 to 4194304 — got 4194305",
      ],
      [
        "maxScopeBytes low",
        ["maxScopeBytes"],
        [],
        1_023,
        "maxScopeBytes must be an integer from 1024 to 4194304",
      ],
    ];
    for (const [label, path, ok, bad, text] of cases) {
      test(label, () => {
        for (const v of ok) expect(() => parse(path, v)).not.toThrow();
        expect(refuses(path, bad)).toStartWith(`runsSlice: ${text}`);
      });
    }

    test("jobs: 1 to 200; names and model keys follow their rules", () => {
      const many = (n: number) =>
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`job-${i}`, RUNS_INPUT.jobs["beta-sync"]]),
        );
      expect(() => parse(["jobs"], many(200))).not.toThrow();
      expect(refuses(["jobs"], many(201))).toBe(
        "runsSlice: jobs must be an object of 1 to 200 jobs — got 201",
      );
      expect(refuses(["jobs"], {})).toBe(
        "runsSlice: jobs must be an object of 1 to 200 jobs — got 0",
      );
      const named = (key: string) => ({ [key]: RUNS_INPUT.jobs["beta-sync"] });
      expect(() => parse(["jobs"], named("a".repeat(64)))).not.toThrow();
      expect(() => parse(["jobs"], named(`${"a".repeat(64)}*`))).not.toThrow();
      expect(refuses(["jobs"], named("a".repeat(65)))).toStartWith(
        `runsSlice: jobs.${"a".repeat(65)} must be a job name matching`,
      );
      expect(refuses(["jobs"], named("Alpha"))).toStartWith(
        "runsSlice: jobs.Alpha must be a job name",
      );
      expect(refuses(["jobs"], named("a*b*"))).toStartWith(
        "runsSlice: jobs.a*b* must be a job name",
      );
      expect(refuses(["jobs"], named("*"))).toStartWith("runsSlice: jobs.* must be a job name");
      const model = (key: string) => ({ [key]: { inputPerMTok: 1, outputPerMTok: 1 } });
      expect(() => parse(["prices"], model("M".repeat(128)))).not.toThrow();
      expect(() => parse(["prices"], model("org/Model-1.5:latest_x"))).not.toThrow();
      expect(refuses(["prices"], model("M".repeat(129)))).toStartWith(
        `runsSlice: prices.${"M".repeat(129)} must be a model key matching [A-Za-z0-9_./:-]{1,128}`,
      );
      expect(refuses(["prices"], model("model a"))).toStartWith(
        "runsSlice: prices.model a must be a model key",
      );
      expect(refuses(["brakes"], { Alpha: {} })).toStartWith(
        'runsSlice: brakes.Alpha must be a unique name matching [a-z0-9][a-z0-9_.:-]{0,63} — got "Alpha"',
      );
      expect(() => parse(["prices"], {})).not.toThrow();
    });

    test("a job's modes: 1 to 8", () => {
      const modes = Array.from({ length: 9 }, (_, i) => `m${i}`);
      const s = runsInput(["modes"], modes);
      const withModes = (n: number) =>
        runsSlice({
          ...s,
          jobs: { "alpha-sync": job("alpha-sync", { modes: modes.slice(0, n) }) },
        } as never);
      expect(() => withModes(8)).not.toThrow();
      expect(refusal(() => withModes(9))).toStartWith(
        "runsSlice: jobs.alpha-sync.modes must be an array of 1 to 8 names",
      );
      expect(refusal(() => withModes(0))).toStartWith(
        "runsSlice: jobs.alpha-sync.modes must be an array of 1 to 8 names",
      );
    });
  });

  describe("RS2: a missing policy number refuses (each required key)", () => {
    for (const key of [
      "modes",
      "jobs",
      "prices",
      "retention",
      "maxCountKeys",
      "maxReasonChars",
      "maxScopeBytes",
    ]) {
      test(key, () => expect(refuses([key], undefined)).toBe(`runsSlice: ${key} is required`));
    }
    for (const key of [
      "lock",
      "modes",
      "reconciles",
      "metered",
      "maxAgeHours",
      "interruptedGraceHours",
    ]) {
      test(`jobs.*.${key}`, () =>
        expect(refuses(["jobs", "beta-sync", key], undefined)).toBe(
          `runsSlice: jobs.beta-sync.${key} is required`,
        ));
    }
    const nested: [string[], string][] = [
      [["retention", "keepDays"], "retention.keepDays"],
      [["prices", "model-a", "inputPerMTok"], "prices.model-a.inputPerMTok"],
      [["prices", "model-a", "outputPerMTok"], "prices.model-a.outputPerMTok"],
      [["brakes", "alpha-archive", "share"], "brakes.alpha-archive.share"],
      [["brakes", "alpha-archive", "allowance"], "brakes.alpha-archive.allowance"],
      [["brakes", "alpha-archive", "armAt"], "brakes.alpha-archive.armAt"],
      [["brakes", "alpha-archive", "rounding"], "brakes.alpha-archive.rounding"],
      [["budgets", "alpha-calls", "limit"], "budgets.alpha-calls.limit"],
      [["budgets", "alpha-calls", "windowMinutes"], "budgets.alpha-calls.windowMinutes"],
      [["breakers", "alpha-quota", "limit"], "breakers.alpha-quota.limit"],
      [["jobs", "alpha-sync", "spike", "share"], "jobs.alpha-sync.spike.share"],
      [["jobs", "alpha-sync", "spike", "allowance"], "jobs.alpha-sync.spike.allowance"],
      [["jobs", "gamma-push", "push", "maxAgeHours"], "jobs.gamma-push.push.maxAgeHours"],
      [["jobs", "gamma-push", "push", "heartbeat"], "jobs.gamma-push.push.heartbeat"],
    ];
    for (const [path, text] of nested) {
      test(text, () => expect(refuses(path, undefined)).toBe(`runsSlice: ${text} is required`));
    }

    test("unknown keys refuse first, at every level, without echoing values", () => {
      expect(refusal(() => runsSlice({ bogus: "secret" } as never))).toBe(
        "runsSlice: bogus is not a known key",
      );
      expect(refuses(["jobs", "beta-sync", "extra"], 1)).toBe(
        "runsSlice: jobs.beta-sync.extra is not a known key",
      );
      expect(refuses(["retention", "keepWeeks"], 1)).toBe(
        "runsSlice: retention.keepWeeks is not a known key",
      );
      expect(refuses(["lockTable"], { table: "x" })).toBe(
        "runsSlice: lockTable.table is not a known key",
      );
      expect(refuses(["lockTable"], { name: "Bad" })).toStartWith(
        'runsSlice: lockTable.name must be an identifier matching [a-z_][a-z0-9_]* of at most 63 bytes — got "Bad"',
      );
      expect(refuses(["jobs", "alpha-sync", "counters", "other"], "x")).toBe(
        "runsSlice: jobs.alpha-sync.counters.other is not a known key",
      );
      expect(refuses(["jobs", "alpha-sync", "reconciles"], "yes")).toBe(
        'runsSlice: jobs.alpha-sync.reconciles must be true or false — got "yes"',
      );
      expect(refuses(["jobs", "alpha-sync", "counters", "archived"], "Archived")).toBe(
        'runsSlice: jobs.alpha-sync.counters.archived must be a counter name matching [a-z0-9_.:-]{1,64} — got "Archived"',
      );
    });
  });

  test("RS3: interruptedGraceHours non-null with maxAgeHours null refuses, and the reverse", () => {
    expect(refuses(["jobs", "beta-sync", "interruptedGraceHours"], 1)).toBe(
      "runsSlice: jobs.beta-sync.interruptedGraceHours must be null when maxAgeHours is null — got 1",
    );
    expect(refuses(["jobs", "alpha-sync", "interruptedGraceHours"], null)).toBe(
      "runsSlice: jobs.alpha-sync.interruptedGraceHours must be a finite number from 0 to maxAgeHours (24) — got null",
    );
  });

  test("RS4: spike without counters.archived refuses, and the reverse", () => {
    expect(refuses(["jobs", "alpha-sync", "counters"], { written: "written" })).toBe(
      'runsSlice: jobs.alpha-sync.spike must be absent unless counters.archived is declared — got {"share":0.1,"allowance":50}',
    );
    expect(refuses(["jobs", "alpha-sync", "spike"], undefined)).toBe(
      "runsSlice: jobs.alpha-sync.spike is required",
    );
  });

  test("RS5: a job mode not in modes refuses; a duplicate mode refuses", () => {
    expect(refuses(["jobs", "beta-sync", "modes"], ["sometimes"])).toBe(
      'runsSlice: jobs.beta-sync.modes[0] must be a unique mode the slice\'s modes list — got "sometimes"',
    );
    expect(refuses(["jobs", "beta-sync", "modes"], ["incremental", "incremental"])).toBe(
      'runsSlice: jobs.beta-sync.modes[1] must be a unique mode the slice\'s modes list — got "incremental"',
    );
    expect(refuses(["modes"], ["incremental", "backfill", "push", "manual", "push"])).toBe(
      'runsSlice: modes[4] must be a unique name matching [a-z0-9][a-z0-9_.:-]{0,63} — got "push"',
    );
  });

  test("RS6: the slice is frozen and branded; a hand-built literal refuses at startRun", async () => {
    const s = runsSlice(runsInput());
    for (const part of [
      s,
      s.table,
      s.lockTable,
      s.modes,
      s.jobs,
      s.jobs["alpha-sync"],
      s.jobs["alpha-sync"]?.modes,
      s.jobs["alpha-sync"]?.counters,
      s.jobs["alpha-sync"]?.spike,
      s.jobs["gamma-push"]?.push,
      s.prices,
      s.prices["model-a"],
      s.brakes,
      s.brakes["alpha-archive"],
      s.budgets,
      s.budgets["alpha-calls"],
      s.breakers,
      s.breakers["alpha-quota"],
      s.retention,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    const copy = { ...s } as RunsSlice;
    const sql = { unsafe: async () => [] } as unknown as Sql;
    const lock = { name: "alpha-sync", holder: "h", ensureExclusive: async () => {} } as RunLock;
    const deps = { now: () => 0, randomUUID: () => "x" };
    await expect(
      startRun(sql, copy, { job: "alpha-sync", mode: "incremental", lock }, deps),
    ).rejects.toThrow(
      "startRun: expected a RunsSlice built by runsSlice() — got an object that parser did not return",
    );
    expect(() => jobDecl(copy, "alpha-sync")).toThrow("jobDecl: expected a RunsSlice");
  });

  test("RS7: share and price decimals; a price parses to integer micro-dollars", () => {
    expect(refuses(["jobs", "alpha-sync", "spike", "share"], 0.12345)).toBe(
      "runsSlice: jobs.alpha-sync.spike.share must be a number above 0 and at most 0.5 with at most 4 decimal places — got 0.12345",
    );
    expect(refuses(["brakes", "alpha-archive", "share"], 0.00001)).toStartWith(
      "runsSlice: brakes.alpha-archive.share must be a number above 0 and at most 0.5 with at most 4 decimal places",
    );
    expect(() => parse(["brakes", "alpha-archive", "share"], 0.1234)).not.toThrow();
    expect(refuses(["prices", "model-a", "inputPerMTok"], 0.1234567)).toBe(
      "runsSlice: prices.model-a.inputPerMTok must be a number with at most 6 decimal places — got 0.1234567",
    );
    expect(refuses(["prices", "model-a", "inputPerMTok"], 1e-7)).toBe(
      "runsSlice: prices.model-a.inputPerMTok must be a number with at most 6 decimal places — got 1e-7",
    );
    const s = parse(["prices", "model-a", "inputPerMTok"], 0.123456);
    expect(priceMicros(s).get("model-a")).toEqual({ input: 123456n, output: 400000n });
    expect(s.prices["model-a"]?.inputPerMTok).toBe(0.123456);
    expect(
      priceMicros(parse(["prices", "model-b", "outputPerMTok"], 10_000)).get("model-b"),
    ).toEqual({
      input: 1_250_000n,
      output: 10_000_000_000n,
    });
  });

  test("RS8: job families", () => {
    const s = runsSlice(runsInput());
    expect(jobDecl(s, "delta:one").key).toBe("delta:*");
    expect(jobDecl(s, "delta:two").key).toBe("delta:*");
    expect(() => jobDecl(s, "delta:")).toThrow(
      'rootstock runs: "delta:" is not a job this config declares — declared: alpha-sync, beta-sync, gamma-push, delta:*',
    );
    expect(() => jobDecl(s, "delta:*")).toThrow("is not a job this config declares");
    expect(() => jobDecl(s, "delta:One")).toThrow("is not a job this config declares");
    // Exact before family.
    const both = runsSlice({
      ...runsInput(),
      jobs: {
        "delta:*": RUNS_INPUT.jobs["delta:*"],
        "delta-x": RUNS_INPUT.jobs["beta-sync"],
        "epsilon:*": RUNS_INPUT.jobs["beta-sync"],
      },
    } as never);
    expect(jobDecl(both, "delta-x").key).toBe("delta-x");
    expect(jobDecl(both, "epsilon:a").key).toBe("epsilon:*");
    expect(jobDecl(both, "delta:a").key).toBe("delta:*");
    // Overlaps refuse, in both orders.
    const jobsOf = (keys: string[]) =>
      refusal(() =>
        runsSlice({
          ...runsInput(),
          jobs: Object.fromEntries(keys.map((k) => [k, RUNS_INPUT.jobs["beta-sync"]])),
        } as never),
      );
    expect(jobsOf(["delta:*", "delta:o*"])).toBe("runsSlice: jobs: delta:o* overlaps delta:*");
    expect(jobsOf(["delta:o*", "delta:*"])).toBe("runsSlice: jobs: delta:* overlaps delta:o*");
    expect(jobsOf(["delta:*", "delta:one"])).toBe("runsSlice: jobs: delta:one overlaps delta:*");
    expect(jobsOf(["delta:one", "delta:*"])).toBe("runsSlice: jobs: delta:* overlaps delta:one");
    expect(() => jobsOf(["delta:*", "delta:"])).toThrow("expected a refusal");
    // A family job under a family lock derives its lock by prefix swap.
    const fam = runsSlice({
      ...runsInput(),
      jobs: {
        "delta:*": job("delta:*", { lock: "shared-delta:*" }),
        "alpha-sync": RUNS_INPUT.jobs["alpha-sync"],
      },
    } as never);
    expect(lockNameFor(jobDecl(fam, "delta:one"), "delta:one")).toBe("shared-delta:one");
    expect(lockNameFor(jobDecl(s, "delta:two"), "delta:two")).toBe("delta:two");
    expect(lockNameFor(jobDecl(s, "gamma-push"), "gamma-push")).toBe("shared-write");
    // A family under an exact lock runs every member under it.
    const exact = runsSlice({
      ...runsInput(),
      jobs: { "delta:*": job("delta:*", { lock: "shared-write" }) },
    } as never);
    expect(lockNameFor(jobDecl(exact, "delta:one"), "delta:one")).toBe("shared-write");
    // An exact job cannot name a family lock.
    expect(refuses(["jobs", "beta-sync", "lock"], "shared-*")).toBe(
      'runsSlice: jobs.beta-sync.lock must be an exact lock name for an exact job — got "shared-*"',
    );
  });
});
