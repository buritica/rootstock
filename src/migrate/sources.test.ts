import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { markerPattern, matchMarker } from "./marker.ts";
import { drizzleJournal, sqlFolder, unmarkedAfterBaseline } from "./sources.ts";

const ROOT = mkdtempSync(join(tmpdir(), "rootstock-sources-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
function folder(files: Record<string, string | Uint8Array>): string {
  const dir = join(ROOT, `f${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function journal(entries: readonly { tag: string; when: number }[]): string {
  return JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: entries.map((e, idx) => ({
      idx,
      version: "7",
      when: e.when,
      tag: e.tag,
      breakpoints: true,
    })),
  });
}

const MARK = { prefix: "app" } as const;
const OPTS = { name: "app", marker: MARK } as const;
const A =
  "-- app-migration: additive\nCREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE INDEX a_i ON a (id);\n";
const H = "-- app-migration: heavy\nCREATE INDEX b_i ON b (id);\n";
const OLD = "CREATE TABLE b (id int);\n--> statement-breakpoint\n";

function drizzleFolder(extra: Record<string, string | Uint8Array> = {}) {
  return folder({
    "meta/_journal.json": journal([
      { tag: "0000_old", when: 1000 },
      { tag: "0001_a", when: 2000 },
      { tag: "20261020000000_h", when: 3000 },
    ]),
    "0000_old.sql": OLD,
    "0001_a.sql": A,
    "20261020000000_h.sql": H,
    ...extra,
  });
}

describe("drizzleJournal", () => {
  test("drizzle-compatible: same hash, key and statements as drizzle's own reader", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("SELECT 1;\r\n")]);
    const invalid = new Uint8Array([
      ...new TextEncoder().encode("SELECT '"),
      0xff,
      0xfe,
      ...new TextEncoder().encode("';\n"),
    ]);
    const dir = folder({
      "meta/_journal.json": journal([
        { tag: "0000_plain", when: 10 },
        { tag: "0001_bom_crlf", when: 20 },
        { tag: "0002_invalid_utf8", when: 30 },
        { tag: "0003_breakpoints", when: 40 },
      ]),
      "0000_plain.sql": OLD,
      "0001_bom_crlf.sql": bom,
      "0002_invalid_utf8.sql": invalid,
      "0003_breakpoints.sql": A,
    });
    const ours = drizzleJournal(dir, OPTS);
    const theirs = readMigrationFiles({ migrationsFolder: dir });
    expect(ours.map((m) => m.sha256)).toEqual(theirs.map((m) => m.hash));
    expect(ours.map((m) => m.key)).toEqual(theirs.map((m) => String(m.folderMillis)));
    expect(ours.map((m) => m.statements)).toEqual(
      theirs.map((m) => m.sql.filter((s) => s.trim() !== "")),
    );
  });

  test("journal order, markers and the baseline", () => {
    const list = drizzleJournal(drizzleFolder(), {
      name: "app",
      marker: { prefix: "app", baseline: "0000_old" },
    });
    expect(list.map((m) => [m.source, m.id, m.key, m.kind, m.baselined])).toEqual([
      ["app", "0000_old", "1000", null, true],
      ["app", "0001_a", "2000", "additive", false],
      ["app", "20261020000000_h", "3000", "heavy", false],
    ]);
    expect(list[1]?.statements).toEqual([
      "-- app-migration: additive\nCREATE TABLE a (id int);\n",
      "\nCREATE INDEX a_i ON a (id);\n",
    ]);
    expect(unmarkedAfterBaseline(list)).toEqual([]);
  });

  test("without a baseline every unmarked file is reported", () => {
    expect(unmarkedAfterBaseline(drizzleJournal(drizzleFolder(), OPTS))).toEqual(["0000_old"]);
  });

  test("is frozen all the way down", () => {
    const list = drizzleJournal(drizzleFolder(), OPTS);
    expect(Object.isFrozen(list)).toBe(true);
    for (const m of list) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.statements)).toBe(true);
    }
  });

  test("accepts a file: URL", () => {
    const dir = drizzleFolder();
    expect(drizzleJournal(pathToFileURL(dir), OPTS)).toHaveLength(3);
  });

  test("accepts a folder whose path needs percent-encoding", () => {
    const dir = join(ROOT, "with space #1");
    mkdirSync(join(dir, "meta"), { recursive: true });
    writeFileSync(join(dir, "meta/_journal.json"), journal([{ tag: "0000_old", when: 1 }]));
    writeFileSync(join(dir, "0000_old.sql"), OLD);
    expect(drizzleJournal(dir, OPTS)[0]?.id).toBe("0000_old");
  });

  const refusals: [string, () => unknown, RegExp][] = [
    [
      "no journal",
      () => drizzleJournal(folder({ "x.sql": OLD }), OPTS),
      /cannot read .*meta\/_journal\.json/,
    ],
    [
      "empty journal",
      () =>
        drizzleJournal(folder({ "meta/_journal.json": journal([]) }), {
          name: "app",
          marker: MARK,
        }),
      /has no entries/,
    ],
    [
      "malformed entry",
      () =>
        drizzleJournal(
          folder({ "meta/_journal.json": JSON.stringify({ entries: [{ tag: "a", when: "1" }] }) }),
          OPTS,
        ),
      /journal entry is malformed/,
    ],
    [
      "duplicate when",
      () =>
        drizzleJournal(
          folder({
            "meta/_journal.json": journal([
              { tag: "a", when: 1 },
              { tag: "b", when: 1 },
            ]),
            "a.sql": OLD,
            "b.sql": OLD,
          }),
          OPTS,
        ),
      /"b" repeats a tag or a when/,
    ],
    [
      "duplicate tag",
      () =>
        drizzleJournal(
          folder({
            "meta/_journal.json": journal([
              { tag: "a", when: 1 },
              { tag: "a", when: 2 },
            ]),
            "a.sql": OLD,
          }),
          {
            name: "app",
            marker: MARK,
          },
        ),
      /"a" repeats a tag or a when/,
    ],
    [
      "path-shaped tag",
      () =>
        drizzleJournal(folder({ "meta/_journal.json": journal([{ tag: "../a", when: 1 }]) }), {
          name: "app",
          marker: MARK,
        }),
      /journal entry is malformed/,
    ],
    [
      "missing file",
      () =>
        drizzleJournal(folder({ "meta/_journal.json": journal([{ tag: "a", when: 1 }]) }), {
          name: "app",
          marker: MARK,
        }),
      /"a" has no readable file a\.sql/,
    ],
    [
      "unknown baseline",
      () =>
        drizzleJournal(drizzleFolder(), {
          name: "app",
          marker: { prefix: "app", baseline: "nope" },
        }),
      /marker baseline "nope" is not one of its migrations/,
    ],
    [
      "bad prefix",
      () => drizzleJournal(drizzleFolder(), { name: "app", marker: { prefix: "App(" } }),
      /marker prefix must match/,
    ],
    ["relative folder", () => drizzleJournal("drizzle", OPTS), /absolute path or a file: URL/],
    [
      "empty name",
      () => drizzleJournal(drizzleFolder(), { name: " ", marker: MARK }),
      /source name must be a non-empty string/,
    ],
  ];
  for (const [what, run, message] of refusals) {
    test(`refuses: ${what}`, () => {
      expect(run).toThrow(message);
    });
  }
});

describe("sqlFolder", () => {
  const dir = folder({
    "20261021000000_b.sql": H,
    "0000_init.sql": OLD,
    "0001_a.sql": A,
    "notes.md": "not a migration",
    "auth/0000_auth.sql": OLD,
    "looks-like.sql/0000_x.sql": OLD,
  });

  test("lists the .sql files in filename order, one batch per file, hashed as bytes", () => {
    const list = sqlFolder(dir, {
      name: "domain",
      marker: { prefix: "app", baseline: "0001_a.sql" },
    });
    expect(list.map((m) => [m.id, m.key, m.kind, m.baselined])).toEqual([
      ["0000_init.sql", "0000_init.sql", null, true],
      ["0001_a.sql", "0001_a.sql", "additive", true],
      ["20261021000000_b.sql", "20261021000000_b.sql", "heavy", false],
    ]);
    expect(list[1]?.statements).toEqual([A]);
    expect(list[1]?.sha256).toBe(createHash("sha256").update(A).digest("hex"));
  });

  test("refuses a folder with no .sql file", () => {
    expect(() => sqlFolder(folder({ "a.txt": "x" }), { name: "domain", marker: MARK })).toThrow(
      /holds no \.sql file/,
    );
  });

  test("refuses a folder it cannot list", () => {
    expect(() => sqlFolder(join(ROOT, "missing"), { name: "domain", marker: MARK })).toThrow(
      /cannot list/,
    );
  });
});

describe("matchMarker", () => {
  test("reads only the first 40 lines", () => {
    const deep = `${"--\n".repeat(40)}-- app-migration: additive\n`;
    expect(matchMarker(deep, markerPattern("app"))).toBeNull();
    expect(
      matchMarker(`${"--\n".repeat(39)}-- app-migration: additive\n`, markerPattern("app")),
    ).toBe("additive");
  });

  test("matches its own prefix only", () => {
    expect(matchMarker("-- other-migration: heavy\n", markerPattern("app"))).toBeNull();
    expect(matchMarker("--app-migration:heavy  \n", markerPattern("app"))).toBe("heavy");
    expect(matchMarker("-- app-migration: additive, mostly\n", markerPattern("app"))).toBeNull();
  });
});
