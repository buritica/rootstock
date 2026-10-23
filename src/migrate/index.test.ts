import { expect, test } from "bun:test";

test("migrate exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "applyRootstockMigrations",
    "drizzleJournal",
    "migrateSlice",
    "parseMarker",
    "rootstockMigrationStatus",
    "rootstockMigrations",
    "sqlFolder",
    "unmarkedAfterBaseline",
  ]);
});
