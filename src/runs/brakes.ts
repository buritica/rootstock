import { intIn, own, q } from "../internal/slice.ts";
import { refusals } from "./errors.ts";
import { type BrakeJudgement, emitter, type RunsDeps, type ScopeJudgement } from "./events.ts";
import type { RunRow } from "./record.ts";
import { assertRunsSlice, type RunsSlice } from "./slice.ts";

/** Shares carry at most 4 decimals (§10.1), so each is an exact N / 10 000. */
const SHARE_DENOMINATOR = 10_000;
const SHARE_DENOMINATOR_N = BigInt(SHARE_DENOMINATOR);

/** True when `v` is a non-negative safe integer. */
const count = (v: unknown): v is number => intIn(v, 0, Number.MAX_SAFE_INTEGER);

/** The entry `name` of one of the slice's named maps, or INPUT naming the caller. */
export function declared<T>(
  fn: string,
  what: string,
  map: Readonly<Record<string, T>>,
  name: string,
): T {
  const entry = typeof name === "string" ? own(map, name) : undefined;
  if (entry === undefined) {
    throw refusals.input(
      `${fn}(${q(name)}): not a ${what} this slice declares — declared: ${Object.keys(map).join(", ")}`,
    );
  }
  return entry;
}

/**
 * The proportional brake `name` of the slice (contract §6.1). `judge` answers
 * whether archiving `planned` of `held` items is over the cap; `assert` also
 * refuses BRAKE when it is and no override was given. Neither records the
 * override: the caller calls `run.override(<flag>)`.
 */
export function proportionalBrake(
  name: string,
  slice: RunsSlice,
): {
  judge(a: { planned: number; held: number; override: boolean }): BrakeJudgement;
  assert(
    a: { planned: number; held: number; override: boolean },
    deps?: Pick<RunsDeps, "onEvent">,
  ): BrakeJudgement;
} {
  assertRunsSlice("proportionalBrake", slice);
  const { share, allowance, armAt, rounding } = declared(
    "proportionalBrake",
    "brake",
    slice.brakes,
    name,
  );
  // The slice accepted the share with the same rounding at 4 decimals.
  const numerator = BigInt(Math.round(share * SHARE_DENOMINATOR));
  const judge = (a: { planned: number; held: number; override: boolean }): BrakeJudgement => {
    const { planned, held } = a;
    for (const [field, v] of [
      ["planned", planned],
      ["held", held],
    ] as const) {
      if (!count(v)) {
        throw refusals.input(
          `proportionalBrake(${q(name)}): ${field} must be a non-negative integer — got ${q(v)}`,
        );
      }
    }
    const override = a.override === true;
    const armed = held >= armAt;
    let cap: number | null = null;
    let wouldRefuse = false;
    if (armed && rounding === "ceil") {
      // The origin's expression exactly, float behaviour included (§6.1, B1).
      cap = Math.max(allowance, Math.ceil(held * share));
      wouldRefuse = planned > cap;
    } else if (armed) {
      cap = Math.max(allowance, held * share);
      wouldRefuse =
        planned > allowance && BigInt(planned) * SHARE_DENOMINATOR_N > BigInt(held) * numerator;
    }
    return {
      planned,
      held,
      armed,
      cap,
      wouldRefuse,
      allowed: !wouldRefuse || override,
      overridden: wouldRefuse && override,
    };
  };
  return {
    judge,
    assert(a, deps) {
      const j = judge(a);
      const emit = emitter(deps?.onEvent);
      const event = { brake: name, planned: j.planned, held: j.held, cap: j.cap };
      if (!j.allowed) {
        emit({ type: "runs.brake_refused", ...event });
        // Only an armed brake refuses, so its cap is a number.
        throw refusals.brake(name, j as BrakeJudgement & { cap: number });
      }
      if (j.overridden) emit({ type: "runs.brake_overridden", ...event });
      return j;
    },
  };
}

export interface Budget {
  /** `limit` less what was charged inside the window, at least 0. */
  remaining(): number;
  /** Charges `n` (a non-negative integer) now. */
  charge(n: number): void;
  /** True when nothing remains. */
  spent(): boolean;
  /** Refuses BUDGET when `planned` is over what remains. Charges nothing. */
  assert(planned: number): void;
}

/**
 * The windowed budget `name` of the slice (contract §6.2): in memory, per
 * process, a list of charges that each leave the window `windowMinutes`
 * after they were made. Every call drops the charges already out of it.
 */
export function windowedBudget(
  name: string,
  slice: RunsSlice,
  deps: Pick<RunsDeps, "now" | "onEvent">,
): Budget {
  assertRunsSlice("windowedBudget", slice);
  const { limit, windowMinutes } = declared("windowedBudget", "budget", slice.budgets, name);
  const windowMs = windowMinutes * 60_000;
  const emit = emitter(deps.onEvent);
  // Charges oldest first; `head` is the first still in the window, `used` the
  // sum from `head` on. A clock that steps back only keeps a charge longer.
  const charges: { atMs: number; n: number }[] = [];
  let head = 0;
  let used = 0;
  const input = (call: string, v: unknown) =>
    refusals.input(`${call}(${q(name)}): n must be a non-negative integer — got ${q(v)}`);
  /** deps.now(), refused when it is not a finite number: a NaN would fail open. */
  const now = (): number => {
    const t = deps.now();
    if (typeof t !== "number" || !Number.isFinite(t)) {
      throw refusals.input(
        `windowedBudget(${q(name)}): deps.now() must be a finite number of ms — got ${q(t)}`,
      );
    }
    return t;
  };
  const remainingAt = (t: number): number => {
    while (head < charges.length && (charges[head] as { atMs: number }).atMs <= t - windowMs) {
      used -= (charges[head] as { n: number }).n;
      head += 1;
    }
    if (head > 1024 && head * 2 > charges.length) {
      charges.splice(0, head);
      head = 0;
    }
    return Math.max(0, limit - used);
  };
  const remaining = () => remainingAt(now());
  return {
    remaining,
    charge(n) {
      if (!count(n)) throw input("charge", n);
      const t = now();
      remainingAt(t);
      if (n === 0) return;
      charges.push({ atMs: t, n });
      used += n;
    },
    spent: () => remaining() === 0,
    assert(planned) {
      if (!count(planned)) throw input("assert", planned);
      const left = remaining();
      if (planned > left) {
        emit({ type: "runs.budget_refused", budget: name, planned, remaining: left });
        throw refusals.budget(name, limit, windowMinutes, planned);
      }
    },
  };
}

/** `v` when it is an array of strings, else undefined. */
function strings(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((s) => typeof s === "string") ? v : undefined;
}

/**
 * Compares this run's scope with the job's newest ok row (contract §6.3).
 * Refuses SCOPE when there is no baseline (unless `firstRun`), when items
 * were lost (unless `allowShrink`), then when items are newly excluded
 * (unless `allowNewExclusions`). `wouldRefuse` is what the guard finds
 * without the options; `allowed` is the answer with them.
 */
export function scopeGuard(
  job: string,
  previous: RunRow | null,
  current: { items: readonly string[]; excluded?: readonly string[] },
  opts: { allowShrink: boolean; allowNewExclusions: boolean; firstRun: boolean },
  deps?: Pick<RunsDeps, "onEvent">,
): ScopeJudgement {
  const fn = `scopeGuard(${job})`;
  if (previous !== null && previous?.status !== "ok") {
    throw refusals.input(
      `${fn}: previous must be the job's newest ok row — got status ${previous?.status}`,
      job,
    );
  }
  const items = strings(current?.items);
  if (items === undefined) {
    throw refusals.input(`${fn}: current.items must be an array of strings`, job);
  }
  const excluded = current.excluded === undefined ? [] : strings(current.excluded);
  if (excluded === undefined) {
    throw refusals.input(`${fn}: current.excluded must be an array of strings`, job);
  }
  const emit = emitter(deps?.onEvent);
  const baselineScope = previous === null ? undefined : strings(previous.scope);
  if (baselineScope === undefined) {
    const judgement: ScopeJudgement = {
      baseline: "none",
      lost: [],
      newlyExcluded: [],
      wouldRefuse: true,
      allowed: opts.firstRun === true,
    };
    if (!judgement.allowed) {
      emit({ type: "runs.scope_refused", job, kind: "baseline" });
      throw refusals.scopeNoBaseline(job, judgement);
    }
    emit({ type: "runs.scope_checked", job, baseline: "none", lost: 0, newlyExcluded: 0 });
    return judgement;
  }
  const now = new Set(items);
  const lost = baselineScope.filter((item) => !now.has(item));
  const before = new Set(strings((previous as RunRow).scopeExcluded) ?? []);
  const newlyExcluded = excluded.filter((item) => !before.has(item));
  const shrinkRefused = lost.length > 0 && opts.allowShrink !== true;
  const exclusionRefused = newlyExcluded.length > 0 && opts.allowNewExclusions !== true;
  const judgement: ScopeJudgement = {
    baseline: "compared",
    lost,
    newlyExcluded,
    wouldRefuse: lost.length > 0 || newlyExcluded.length > 0,
    allowed: !shrinkRefused && !exclusionRefused,
  };
  if (shrinkRefused) {
    emit({ type: "runs.scope_refused", job, kind: "shrink" });
    throw refusals.scope(job, "shrink", lost, judgement);
  }
  if (exclusionRefused) {
    emit({ type: "runs.scope_refused", job, kind: "exclusion" });
    throw refusals.scope(job, "exclusion", newlyExcluded, judgement);
  }
  emit({
    type: "runs.scope_checked",
    job,
    baseline: "compared",
    lost: lost.length,
    newlyExcluded: newlyExcluded.length,
  });
  return judgement;
}
