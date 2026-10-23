import { expect, test } from "bun:test";

test("migrate exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "applyMigrations",
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
    "rootstockSource",
    "sqlFolder",
    "sqlFolderFrom",
    "timestampRenames",
    "unmarkedAfterBaseline",
  ]);
});
