import { expect, test } from "bun:test";

test("runs exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/runs")).sort()).toEqual([
    "RootstockRunsError",
    "consecutiveBreaker",
    "jobDecl",
    "pendingQuarantine",
    "proportionalBrake",
    "pruneRuns",
    "pushVerdictFor",
    "quarantine",
    "quarantineSafe",
    "quarantineTable",
    "resolveQuarantine",
    "runsErrorCode",
    "runsSlice",
    "runsSnapshot",
    "scopeGuard",
    "startRun",
    "verdictFor",
    "windowedBudget",
  ]);
});
