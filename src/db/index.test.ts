import { expect, test } from "bun:test";

test("db exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/db")).sort()).toEqual([
    "bunSqlOptions",
    "bunSqlTransactor",
    "clientSlice",
    "drizzleTransactor",
    "pgCode",
    "postgresJsOptions",
    "postgresJsTransactor",
    "quoteIdentifier",
  ]);
});
