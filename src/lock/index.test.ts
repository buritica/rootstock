import { expect, test } from "bun:test";

test("lock exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/lock")).sort()).toEqual([
    "bunSqlLockSession",
    "lockSlice",
    "postgresJsLockSession",
    "withNames",
  ]);
});
