import { describe, expect, test } from "bun:test";
import { drizzleJournalFrom, sqlFolderFrom } from "./sources.ts";
import { sourceState } from "./state.ts";
import type { TrackedSource } from "./tracked.ts";

const enc = new TextEncoder();
const A = "-- rootstock-migration: additive\nCREATE TABLE a (id int);\n";
const B = "-- rootstock-migration: additive\nCREATE TABLE b (id int);\n";

function folder(files: Record<string, string>): TrackedSource {
  return {
    name: "app",
    migrations: sqlFolderFrom(Object.keys(files), (n) => enc.encode(files[n] as string), {
      name: "app",
    }),
    tracker: { kind: "filename", schema: "public", table: "schema_migrations" },
  };
}

function journal(entries: readonly [string, number][]): TrackedSource {
  const text = JSON.stringify({ entries: entries.map(([tag, when]) => ({ tag, when })) });
  return {
    name: "app",
    migrations: drizzleJournalFrom(text, () => enc.encode(A), { name: "app" }),
    tracker: { kind: "drizzle", schema: "drizzle", table: "__drizzle_migrations" },
  };
}

const read = (keys: readonly string[]) => ({
  schemaExists: true,
  tracked: true,
  hashColumn: true,
  rows: keys.map((key) => ({ rowId: null, key, hash: null })),
});

describe("sourceState outOfOrder", () => {
  // rootstock#36: a renamed file's key is its old name, which sorts before any
  // stamped name; a filename source applies by name, so that is the order.
  test("after a rename, a pending file named before the newest applied is out of order", () => {
    const renames = JSON.stringify({ "0001_a.sql": "20260101000100_a.sql" });
    const source = folder({
      "20260101000100_a.sql": A,
      "20260101000000_b.sql": B,
      "renames.json": renames,
    });
    expect(sourceState(source, read(["0001_a.sql"]), []).outOfOrder).toEqual([
      "20260101000000_b.sql",
    ]);
  });

  test("a pending file named after the newest applied is in order", () => {
    const renames = JSON.stringify({ "0001_a.sql": "20260101000100_a.sql" });
    const source = folder({
      "20260101000100_a.sql": A,
      "20260101000200_b.sql": B,
      "renames.json": renames,
    });
    expect(sourceState(source, read(["0001_a.sql"]), []).outOfOrder).toEqual([]);
  });

  test("after a rename to a name that sorts after stamps, a later stamp is in order", () => {
    const renames = JSON.stringify({ "init.sql": "20260101000100_a.sql" });
    const source = folder({
      "20260101000100_a.sql": A,
      "20260101000200_b.sql": B,
      "renames.json": renames,
    });
    expect(sourceState(source, read(["init.sql"]), []).outOfOrder).toEqual([]);
  });

  test("a drizzle source orders by when as an integer", () => {
    const later = journal([
      ["0000_a", 900],
      ["0001_b", 1000],
    ]);
    expect(sourceState(later, read(["900"]), []).outOfOrder).toEqual([]);
    const earlier = journal([
      ["0000_a", 1000],
      ["0001_b", 900],
    ]);
    expect(sourceState(earlier, read(["1000"]), []).outOfOrder).toEqual(["0001_b"]);
  });
});
