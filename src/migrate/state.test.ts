import { describe, expect, test } from "bun:test";
import { sqlFolderFrom } from "./sources.ts";
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
});
