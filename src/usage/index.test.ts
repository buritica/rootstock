import { expect, test } from "bun:test";

test("usage exports exactly its surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/usage")).sort()).toEqual([
    "CALL_ERROR_CLASSES",
    "RootstockUsageError",
    "callPricer",
    "createSpendCeiling",
    "errorClassOf",
    "postgresCallLog",
    "postgresSpendStore",
    "prometheusToolMetrics",
    "usageErrorCode",
    "usageSlice",
    "usageWiring",
  ]);
});
