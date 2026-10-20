import { expect, test } from "bun:test";

test("db exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
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
