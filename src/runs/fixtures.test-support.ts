import type { RunsSliceInput } from "./slice.ts";

/** The synthetic runs slice of contract §0.3, shared by the runs suites. */
export const RUNS_INPUT: RunsSliceInput = {
  modes: ["incremental", "backfill", "push", "manual"],
  jobs: {
    "alpha-sync": {
      lock: "alpha-sync",
      modes: ["incremental", "backfill"],
      reconciles: true,
      metered: true,
      maxAgeHours: 24,
      interruptedGraceHours: 2,
      staleHeartbeatSeconds: 120,
      counters: { archived: "archived", written: "written" },
      spike: { share: 0.1, allowance: 50 },
    },
    "beta-sync": {
      lock: "shared-write",
      modes: ["incremental"],
      reconciles: false,
      metered: false,
      maxAgeHours: null,
      interruptedGraceHours: null,
      staleHeartbeatSeconds: 120,
    },
    "gamma-push": {
      lock: "shared-write",
      modes: ["push"],
      reconciles: false,
      metered: true,
      maxAgeHours: 6,
      interruptedGraceHours: 1,
      staleHeartbeatSeconds: 120,
      push: { maxAgeHours: 6, heartbeat: true },
    },
    "delta:*": {
      lock: "delta:*",
      modes: ["manual"],
      reconciles: true,
      metered: false,
      maxAgeHours: null,
      interruptedGraceHours: null,
      staleHeartbeatSeconds: 120,
    },
  },
  prices: {
    "model-a": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
    "model-b": { inputPerMTok: 1.25, outputPerMTok: 10 },
    "model-c": { inputPerMTok: 0.7, outputPerMTok: 0 },
  },
  brakes: { "alpha-archive": { share: 0.1, allowance: 50, armAt: 0, rounding: "ceil" } },
  budgets: { "alpha-calls": { limit: 100, windowMinutes: 60 } },
  breakers: { "alpha-quota": { limit: 5 } },
  retention: { keepDays: 30 },
  maxCountKeys: 50,
  maxReasonChars: 500,
  maxScopeBytes: 65_536,
};

/** A deep copy of `RUNS_INPUT` with the value at `path` replaced (`undefined` deletes it). */
export function runsInput(path: readonly string[] = [], value?: unknown): RunsSliceInput {
  const copy = structuredClone(RUNS_INPUT) as unknown as Record<string, unknown>;
  if (path.length === 0) return copy as unknown as RunsSliceInput;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy as unknown as RunsSliceInput;
}
