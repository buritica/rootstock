import { describe, expect, test } from "bun:test";
import { proportionalBrake, scopeGuard, windowedBudget } from "./brakes.ts";
import { RootstockRunsError } from "./errors.ts";
import type { RunsEvent } from "./events.ts";
import { runsInput } from "./fixtures.test-support.ts";
import type { RunRow } from "./record.ts";
import { type RunsSlice, runsSlice } from "./slice.ts";

// R-D4 (contract §6, §13.6): the proportional brake, the windowed budget and
// the scope guard, all pure.

type Shape = { share: number; allowance: number; armAt: number; rounding: "ceil" | "none" };
const sliceWith = (shape: Shape): RunsSlice =>
  runsSlice(runsInput(["brakes"], { "alpha-archive": shape }));
const brake = (shape: Shape) => proportionalBrake("alpha-archive", sliceWith(shape));

const thrown = (fn: () => unknown): RootstockRunsError => {
  try {
    fn();
  } catch (err) {
    return err as RootstockRunsError;
  }
  throw new Error("expected a refusal");
};

/** Every (held, planned) where the brake and the origin's predicate disagree. */
function sweep(
  shape: Shape,
  maxHeld: number,
  origin: (planned: number, held: number) => boolean,
): [number, number][] {
  const { judge } = brake(shape);
  const out: [number, number][] = [];
  for (let held = 0; held <= maxHeld; held++) {
    for (let planned = 0; planned <= held; planned++) {
      if (judge({ planned, held, override: false }).wouldRefuse !== origin(planned, held)) {
        out.push([held, planned]);
      }
    }
  }
  return out;
}

describe("proportionalBrake", () => {
  test("RB1: {0.1, 50, 0, ceil} and {0.1, 0, 0, ceil} match the origin over held 0..100 000", () => {
    for (const allowance of [50, 0]) {
      const { judge } = brake({ share: 0.1, allowance, armAt: 0, rounding: "ceil" });
      const wrong: unknown[] = [];
      for (let held = 0; held <= 100_000; held++) {
        const cap = Math.max(allowance, Math.ceil(held * 0.1));
        for (const planned of [cap, cap + 1]) {
          const j = judge({ planned, held, override: false });
          const origin = planned > Math.max(allowance, Math.ceil(held * 0.1));
          if (j.cap !== cap || j.wouldRefuse !== origin || !j.armed) {
            wrong.push({ allowance, held, planned, j });
          }
        }
      }
      expect(wrong.slice(0, 5)).toEqual([]);
    }
  });

  test("RB2: {0.5, 0, 10, none} matches held >= 10 && planned/held > 0.5", () => {
    const shape: Shape = { share: 0.5, allowance: 0, armAt: 10, rounding: "none" };
    expect(sweep(shape, 200, (p, h) => h >= 10 && p / h > 0.5)).toEqual([]);
    const { judge } = brake(shape);
    // The strict ratio refuses 6 of 11, which a ceil cap of 6 would allow (C3).
    expect(judge({ planned: 6, held: 11, override: false })).toMatchObject({
      armed: true,
      cap: 5.5,
      wouldRefuse: true,
    });
    expect(judge({ planned: 9, held: 9, override: false })).toEqual({
      planned: 9,
      held: 9,
      armed: false,
      cap: null,
      wouldRefuse: false,
      allowed: true,
      overridden: false,
    });
  });

  test("RB3: {0.5, 50, 0, none} matches planned > 50 && planned > held·0.5", () => {
    const shape: Shape = { share: 0.5, allowance: 50, armAt: 0, rounding: "none" };
    expect(sweep(shape, 400, (p, h) => p > 50 && p > h * 0.5)).toEqual([]);
    expect(brake(shape).judge({ planned: 10, held: 10, override: false }).cap).toBe(50);
  });

  test("RB4: {0.5, 10, 0, none} matches planned > 10 && planned > held·0.5", () => {
    const shape: Shape = { share: 0.5, allowance: 10, armAt: 0, rounding: "none" };
    expect(sweep(shape, 200, (p, h) => p > 10 && p > h * 0.5)).toEqual([]);
  });

  test("RB4: a 4-decimal share in none mode compares as an exact fraction", () => {
    const { judge } = brake({ share: 0.0003, allowance: 0, armAt: 0, rounding: "none" });
    // 3 of 10 000 is exactly at the share: not over it. 4 is.
    expect(judge({ planned: 3, held: 10_000, override: false }).wouldRefuse).toBe(false);
    expect(judge({ planned: 4, held: 10_000, override: false }).wouldRefuse).toBe(true);
  });

  test("RB5: override allows and reports; assert refuses BRAKE without it; events", () => {
    const events: RunsEvent[] = [];
    const deps = { onEvent: (e: RunsEvent) => events.push(e) };
    const b = brake({ share: 0.1, allowance: 50, armAt: 0, rounding: "ceil" });
    const over = { planned: 101, held: 1000 };
    expect(b.judge({ ...over, override: true })).toEqual({
      ...over,
      armed: true,
      cap: 100,
      wouldRefuse: true,
      allowed: true,
      overridden: true,
    });
    expect(events).toEqual([]);
    expect(b.assert({ ...over, override: true }, deps).overridden).toBe(true);
    expect(events).toEqual([
      { type: "runs.brake_overridden", brake: "alpha-archive", planned: 101, held: 1000, cap: 100 },
    ]);
    events.length = 0;
    const err = thrown(() => b.assert({ ...over, override: false }, deps));
    expect(err).toBeInstanceOf(RootstockRunsError);
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_BRAKE");
    expect(err.message).toBe(
      "rootstock runs: alpha-archive would archive 101 of 1000 (cap 100) — refusing; pass the override to allow it",
    );
    expect(err.judgement).toMatchObject({ wouldRefuse: true, allowed: false, overridden: false });
    expect(events).toEqual([
      { type: "runs.brake_refused", brake: "alpha-archive", planned: 101, held: 1000, cap: 100 },
    ]);
    events.length = 0;
    expect(b.assert({ planned: 100, held: 1000, override: true }, deps)).toMatchObject({
      allowed: true,
      overridden: false,
    });
    expect(b.assert({ planned: 100, held: 1000, override: false })).toMatchObject({
      allowed: true,
    });
    expect(events).toEqual([]);
    // A hook that throws changes nothing.
    const quiet = {
      onEvent: () => {
        throw new Error("hook");
      },
    };
    expect(b.assert({ ...over, override: true }, quiet).allowed).toBe(true);
  });

  test("RB5: inputs and the brand refuse INPUT", () => {
    const s = sliceWith({ share: 0.1, allowance: 50, armAt: 0, rounding: "ceil" });
    expect(thrown(() => proportionalBrake("omega", s)).message).toBe(
      'rootstock runs: proportionalBrake("omega"): not a brake this slice declares — declared: alpha-archive',
    );
    const { judge } = proportionalBrake("alpha-archive", s);
    for (const [field, bad, got] of [
      ["planned", -1, "-1"],
      ["held", 1.5, "1.5"],
      ["held", Number.NaN, "NaN"],
    ] as const) {
      const err = thrown(() => judge({ planned: 1, held: 10, override: false, [field]: bad }));
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
      expect(err.message).toBe(
        `rootstock runs: proportionalBrake("alpha-archive"): ${field} must be a non-negative integer — got ${got}`,
      );
    }
    expect(() => proportionalBrake("alpha-archive", { ...s } as RunsSlice)).toThrow(
      "proportionalBrake",
    );
  });

  test("RB6: held 30, share 0.1, ceil: cap 50 (allowance), and 3 with allowance 0", () => {
    expect(30 * 0.1).toBe(3);
    expect(
      brake({ share: 0.1, allowance: 50, armAt: 0, rounding: "ceil" }).judge({
        planned: 50,
        held: 30,
        override: false,
      }),
    ).toMatchObject({ cap: 50, wouldRefuse: false });
    const zero = brake({ share: 0.1, allowance: 0, armAt: 0, rounding: "ceil" });
    expect(zero.judge({ planned: 3, held: 30, override: false })).toMatchObject({
      cap: Math.ceil(30 * 0.1),
      wouldRefuse: false,
    });
    expect(zero.judge({ planned: 4, held: 30, override: false }).wouldRefuse).toBe(true);
  });
});

describe("windowedBudget", () => {
  test("RB7: charges in and out of the window with an injected clock; assert at, over", () => {
    const slice = runsSlice(runsInput());
    let now = 1_000_000;
    const events: RunsEvent[] = [];
    const b = windowedBudget("alpha-calls", slice, {
      now: () => now,
      onEvent: (e) => events.push(e),
    });
    expect(b.remaining()).toBe(100);
    b.charge(40);
    now += 30 * 60_000;
    b.charge(50);
    expect(b.remaining()).toBe(10);
    expect(b.spent()).toBe(false);
    expect(() => b.assert(10)).not.toThrow();
    const err = thrown(() => b.assert(11));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_BUDGET");
    expect(err.message).toBe(
      "rootstock runs: alpha-calls is spent (100 per 60 min) — refusing 11 more",
    );
    expect(events).toEqual([
      { type: "runs.budget_refused", budget: "alpha-calls", planned: 11, remaining: 10 },
    ]);
    // The first charge leaves the window exactly 60 minutes after it was made.
    now += 30 * 60_000 - 1;
    expect(b.remaining()).toBe(10);
    now += 1;
    expect(b.remaining()).toBe(50);
    now += 30 * 60_000;
    expect(b.remaining()).toBe(100);
    b.charge(150);
    expect(b.remaining()).toBe(0);
    expect(b.spent()).toBe(true);
    expect(() => b.assert(0)).not.toThrow();
    expect(thrown(() => b.assert(1)).code).toBe("ERR_ROOTSTOCK_RUNS_BUDGET");
    b.charge(0);
    expect(thrown(() => b.charge(-1)).message).toBe(
      'rootstock runs: charge("alpha-calls"): n must be a non-negative integer — got -1',
    );
    expect(thrown(() => b.assert(0.5)).code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(thrown(() => windowedBudget("omega", slice, { now: () => now })).message).toBe(
      'rootstock runs: windowedBudget("omega"): not a budget this slice declares — declared: alpha-calls',
    );
  });

  test("RB7: a clock that is not a finite number refuses INPUT rather than failing open", () => {
    const slice = runsSlice(runsInput());
    let now: number = 1_000;
    const b = windowedBudget("alpha-calls", slice, { now: () => now });
    b.charge(100);
    now = Number.NaN;
    const err = thrown(() => b.assert(100));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(err.message).toBe(
      'rootstock runs: windowedBudget("alpha-calls"): deps.now() must be a finite number of ms — got NaN',
    );
    expect(thrown(() => b.charge(1)).code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    now = 2_000;
    expect(b.remaining()).toBe(0);
  });

  test("RB7: many charges stay linear and expire in order", () => {
    const slice = runsSlice(
      runsInput(["budgets", "alpha-calls"], { limit: 1_000_000, windowMinutes: 1 }),
    );
    let now = 0;
    const b = windowedBudget("alpha-calls", slice, { now: () => now });
    const started = performance.now();
    for (let i = 0; i < 100_000; i += 1) {
      now += 1;
      b.charge(1);
      b.assert(0);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
    // One charge per ms: those made in the last 60 000 ms are in the window.
    expect(b.remaining()).toBe(1_000_000 - 60_000);
    now += 60_000;
    expect(b.remaining()).toBe(1_000_000);
  });
});

const ROW: RunRow = {
  id: "00000000-0000-4000-8000-000000000001",
  job: "alpha-sync",
  mode: "incremental",
  status: "ok",
  phase: null,
  lockName: "alpha-sync",
  holder: "00000000-0000-4000-8000-0000000000aa",
  startedAt: new Date(1000),
  finishedAt: new Date(2000),
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
  scope: ["a", "b", "c"],
  scopeExcluded: ["x"],
  overrides: [],
  reason: null,
};
const NONE = { allowShrink: false, allowNewExclusions: false, firstRun: false };

describe("scopeGuard", () => {
  test("RB8: no baseline refuses unless firstRun", () => {
    for (const previous of [null, { ...ROW, scope: null }, { ...ROW, scope: [1, 2] }]) {
      const events: RunsEvent[] = [];
      const err = thrown(() =>
        scopeGuard("alpha-sync", previous, { items: ["a"] }, NONE, {
          onEvent: (e) => events.push(e),
        }),
      );
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_SCOPE");
      expect(err.message).toBe(
        "rootstock runs: alpha-sync has no successful run to compare its scope against — refusing; pass firstRun: true for a job's first run",
      );
      expect(err.judgement).toEqual({
        baseline: "none",
        lost: [],
        newlyExcluded: [],
        wouldRefuse: true,
        allowed: false,
      });
      expect(events).toEqual([{ type: "runs.scope_refused", job: "alpha-sync", kind: "baseline" }]);
    }
    const events: RunsEvent[] = [];
    expect(
      scopeGuard(
        "alpha-sync",
        null,
        { items: ["a"] },
        { ...NONE, firstRun: true },
        {
          onEvent: (e) => events.push(e),
        },
      ),
    ).toEqual({ baseline: "none", lost: [], newlyExcluded: [], wouldRefuse: true, allowed: true });
    expect(events).toEqual([
      {
        type: "runs.scope_checked",
        job: "alpha-sync",
        baseline: "none",
        lost: 0,
        newlyExcluded: 0,
      },
    ]);
  });

  test("RB8: compared, with lost items, newly excluded items, and both (shrink first)", () => {
    const events: RunsEvent[] = [];
    const deps = { onEvent: (e: RunsEvent) => events.push(e) };
    expect(
      scopeGuard("alpha-sync", ROW, { items: ["c", "b", "a", "d"], excluded: ["x"] }, NONE, deps),
    ).toEqual({
      baseline: "compared",
      lost: [],
      newlyExcluded: [],
      wouldRefuse: false,
      allowed: true,
    });
    expect(events).toEqual([
      {
        type: "runs.scope_checked",
        job: "alpha-sync",
        baseline: "compared",
        lost: 0,
        newlyExcluded: 0,
      },
    ]);
    events.length = 0;

    const shrink = thrown(() => scopeGuard("alpha-sync", ROW, { items: ["b"] }, NONE, deps));
    expect(shrink.message).toBe(
      "rootstock runs: alpha-sync scope lost 2 item(s) since the last successful run (a, c) — refusing; pass the override to allow it",
    );
    expect(events).toEqual([{ type: "runs.scope_refused", job: "alpha-sync", kind: "shrink" }]);
    events.length = 0;
    expect(
      scopeGuard("alpha-sync", ROW, { items: ["b"] }, { ...NONE, allowShrink: true }, deps),
    ).toEqual({
      baseline: "compared",
      lost: ["a", "c"],
      newlyExcluded: [],
      wouldRefuse: true,
      allowed: true,
    });
    events.length = 0;

    const excl = thrown(() =>
      scopeGuard(
        "alpha-sync",
        ROW,
        { items: ["a", "b", "c"], excluded: ["y", "x", "z"] },
        NONE,
        deps,
      ),
    );
    expect(excl.message).toBe(
      "rootstock runs: alpha-sync scope newly excludes 2 item(s) since the last successful run (y, z) — refusing; pass the override to allow it",
    );
    expect(events).toEqual([{ type: "runs.scope_refused", job: "alpha-sync", kind: "exclusion" }]);
    events.length = 0;

    // Both: shrink is reported first; allowing it surfaces the exclusion.
    const both = { items: ["a"], excluded: ["y"] };
    const first = thrown(() => scopeGuard("alpha-sync", ROW, both, NONE, deps));
    expect(first.message).toContain("scope lost 2 item(s)");
    expect(first.judgement).toEqual({
      baseline: "compared",
      lost: ["b", "c"],
      newlyExcluded: ["y"],
      wouldRefuse: true,
      allowed: false,
    });
    const second = thrown(() =>
      scopeGuard("alpha-sync", ROW, both, { ...NONE, allowShrink: true }, deps),
    );
    expect(second.message).toContain("scope newly excludes 1 item(s)");
    expect(
      scopeGuard(
        "alpha-sync",
        ROW,
        both,
        { ...NONE, allowShrink: true, allowNewExclusions: true },
        deps,
      ),
    ).toMatchObject({ wouldRefuse: true, allowed: true });
    // An absent previous exclusion list is empty.
    expect(
      scopeGuard(
        "alpha-sync",
        { ...ROW, scopeExcluded: null },
        { items: ["a", "b", "c"], excluded: ["x"] },
        {
          ...NONE,
          allowNewExclusions: true,
        },
      ).newlyExcluded,
    ).toEqual(["x"]);
  });

  test("RB8: more than ten items cut the list with an ellipsis", () => {
    const scope = Array.from({ length: 12 }, (_, i) => `i${i}`);
    const err = thrown(() => scopeGuard("alpha-sync", { ...ROW, scope }, { items: [] }, NONE));
    expect(err.message).toBe(
      "rootstock runs: alpha-sync scope lost 12 item(s) since the last successful run (i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, …) — refusing; pass the override to allow it",
    );
  });

  test("RB8: missing opts or an undefined previous refuse INPUT, not a TypeError", () => {
    const missing = thrown(() =>
      scopeGuard("alpha-sync", ROW, { items: ["a"] }, undefined as never),
    );
    expect(missing.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(missing.message).toBe(
      "rootstock runs: scopeGuard(alpha-sync): opts must be { allowShrink, allowNewExclusions, firstRun } — got undefined",
    );
    const undef = thrown(() =>
      scopeGuard("alpha-sync", undefined as never, { items: ["a"] }, NONE),
    );
    expect(undef.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
  });

  test("RB8: a non-ok previous row (running or failed) refuses INPUT", () => {
    for (const status of ["running", "failed"] as const) {
      const err = thrown(() =>
        scopeGuard("alpha-sync", { ...ROW, status }, { items: ["a", "b", "c"] }, NONE),
      );
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
      expect(err.message).toBe(
        `rootstock runs: scopeGuard(alpha-sync): previous must be the job's newest ok row — got status ${status}`,
      );
    }
    expect(thrown(() => scopeGuard("alpha-sync", ROW, { items: "a" as never }, NONE)).code).toBe(
      "ERR_ROOTSTOCK_RUNS_INPUT",
    );
  });
});
