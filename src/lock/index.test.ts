import { expect, test } from "bun:test";

test("lock exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/lock")).sort()).toEqual([
    "LOCK_HELD_PREDICATE",
    "RootstockLockError",
    "acquireRunLock",
    "bunSqlLockSession",
    "lockErrorCode",
    "lockNameCollisions",
    "lockOwnershipLost",
    "lockSlice",
    "locksHeld",
    "postgresJsLockSession",
    "withNames",
  ]);
});
