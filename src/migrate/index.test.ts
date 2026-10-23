import { expect, test } from "bun:test";

test("migrate exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "applyRootstockMigrations",
    "assertThrowawayDb",
    "checkMigrationOrder",
    "drizzleJournal",
    "drizzleJournalFrom",
    "drizzleTracker",
    "filenameTracker",
    "gitMainReader",
    "migrateSlice",
    "rootstockMigrationStatus",
    "rootstockMigrations",
    "sqlFolder",
    "sqlFolderFrom",
    "timestampRenames",
    "unmarkedAfterBaseline",
  ]);
});
