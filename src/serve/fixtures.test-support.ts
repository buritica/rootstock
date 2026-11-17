// A synthetic serve slice input for the slice, config and composition tests.

import type { ServeSliceInput } from "./slice.ts";

export const SERVE_INPUT: ServeSliceInput = {
  id: "app.http",
  bodyLimit: { oauth: 4_194_304, bearer: 9_437_184, local: 9_437_184, none: null },
  deadlineMs: 30_000,
  idleTimeout: 45,
  shutdown: { drainMs: 10_000, forceMs: 2_000, poolEndTimeoutS: 5, flushMs: 2_000 },
  limits: {
    refusal: { capacity: 20, refillPerSecond: 2, maxKeys: 4096 },
    serving: { capacity: 120, refillPerSecond: 20, maxKeys: 4096 },
    perTool: { search: { capacity: 10, refillPerSecond: 10 / 60, maxKeys: 4096 } },
    concurrency: { dedup: { tools: ["slow", "boom"], max: 1 } },
    turnBudget: { cap: 30, warnAt: 5, maxTurns: 2000 },
    logIntervalMs: 1000,
  },
  probes: { timeoutMs: 2000, cacheTtlMs: 5000, pendingMaxMs: 10_000 },
};
