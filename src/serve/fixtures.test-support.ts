// A synthetic serve slice input for the slice, config and composition tests:
// made-up tool and group names and round-ish numbers, no consumer's values.

import type { ServeSliceInput } from "./slice.ts";

export const SERVE_INPUT: ServeSliceInput = {
  id: "app.http",
  bodyLimit: { oauth: 65_536, bearer: 131_072, local: 131_072, none: null },
  deadlineMs: 20_000,
  idleTimeout: 30,
  shutdown: { drainMs: 3_000, forceMs: 500, poolEndTimeoutS: 2, flushMs: 1_500 },
  limits: {
    refusal: { capacity: 12, refillPerSecond: 3, maxKeys: 256 },
    serving: { capacity: 90, refillPerSecond: 15, maxKeys: 256 },
    perTool: { lookup: { capacity: 7, refillPerSecond: 0.25, maxKeys: 512 } },
    concurrency: { pair: { tools: ["alpha", "beta"], max: 1 } },
    turnBudget: { cap: 24, warnAt: 4, maxTurns: 500 },
    logIntervalMs: 500,
  },
  probes: { timeoutMs: 1_500, cacheTtlMs: 4_000, pendingMaxMs: 8_000 },
};
