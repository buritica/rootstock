import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { markerPattern, matchMarker } from "./marker.ts";
import {
  drizzleJournal,
  drizzleJournalFrom,
  sqlFolder,
  sqlFolderFrom,
  timestampRenames,
  unmarkedAfterBaseline,
} from "./sources.ts";

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

const OPTS = { name: "app" } as const;
const A =
  "-- rootstock-migration: additive\nCREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE INDEX a_i ON a (id);\n";
const H = "-- rootstock-migration: heavy\nCREATE INDEX b_i ON b (id);\n";
const OLD = "CREATE TABLE b (id int);\n--> statement-breakpoint\n";

const DRIZZLE_JOURNAL = journal([
  { tag: "0000_old", when: 1000 },
  { tag: "0001_a", when: 2000 },
  { tag: "20261020000000_h", when: 3000 },
]);
const DRIZZLE_FILES: Record<string, string> = {
  "0000_old.sql": OLD,
  "0001_a.sql": A,
  "20261020000000_h.sql": H,
};

function drizzleFolder(extra: Record<string, string | Uint8Array> = {}) {
  return folder({ "meta/_journal.json": DRIZZLE_JOURNAL, ...DRIZZLE_FILES, ...extra });
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
    // Same chunks, except that we drop whitespace-only ones and a leading BOM,
    // which drizzle sends and Postgres rejects; neither changes the hash.
    expect(ours.map((m) => m.statements)).toEqual(
      theirs.map((m) => m.sql.map((s) => s.replace(/^\uFEFF/, "")).filter((s) => s.trim() !== "")),
    );
  });

  test("journal order, markers and the baseline", () => {
    const list = drizzleJournal(drizzleFolder(), {
      name: "app",
      marker: { baseline: "0000_old" },
    });
    expect(list.map((m) => [m.source, m.id, m.key, m.kind, m.baselined])).toEqual([
      ["app", "0000_old", "1000", null, true],
      ["app", "0001_a", "2000", "additive", false],
      ["app", "20261020000000_h", "3000", "heavy", false],
    ]);
    expect(list[1]?.statements).toEqual([
      "-- rootstock-migration: additive\nCREATE TABLE a (id int);\n",
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
      () => drizzleJournal(folder({ "meta/_journal.json": journal([]) }), OPTS),
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
          OPTS,
        ),
      /"a" repeats a tag or a when/,
    ],
    [
      "path-shaped tag",
      () =>
        drizzleJournal(folder({ "meta/_journal.json": journal([{ tag: "../a", when: 1 }]) }), OPTS),
      /journal entry is malformed/,
    ],
    [
      "missing file",
      () =>
        drizzleJournal(folder({ "meta/_journal.json": journal([{ tag: "a", when: 1 }]) }), OPTS),
      /"a" has no readable file a\.sql/,
    ],
    [
      "unknown baseline",
      () =>
        drizzleJournal(drizzleFolder(), {
          name: "app",
          marker: { baseline: "nope" },
        }),
      /marker baseline "nope" is not one of its migrations/,
    ],
    [
      "bad legacy prefix",
      () =>
        drizzleJournal(drizzleFolder(), {
          name: "app",
          marker: { legacy: { prefix: "App(", through: "0000_old" } },
        }),
      /source "app": marker legacy\.prefix must match/,
    ],
    [
      "unknown legacy.through",
      () =>
        drizzleJournal(drizzleFolder(), {
          name: "app",
          marker: { legacy: { prefix: "legacy", through: "nope" } },
        }),
      /marker legacy\.through "nope" is not one of its migrations/,
    ],
    ["relative folder", () => drizzleJournal("drizzle", OPTS), /absolute path or a file: URL/],
    [
      "empty name",
      () => drizzleJournal(drizzleFolder(), { name: " " }),
      /source name must match \[a-z\]\[a-z0-9-\]\*/,
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
      marker: { baseline: "0001_a.sql" },
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
    expect(() => sqlFolder(folder({ "a.txt": "x" }), { name: "domain" })).toThrow(
      /holds no \.sql file/,
    );
  });

  test("refuses a folder it cannot list", () => {
    expect(() => sqlFolder(join(ROOT, "missing"), { name: "domain" })).toThrow(/cannot list/);
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

describe("edges the review found", () => {
  const enc = (t: string) => new TextEncoder().encode(t);

  test("a path holding % or a backslash names that folder, not a decoded one", () => {
    for (const name of ["a%20b", "a\\b"]) {
      const dir = join(ROOT, name);
      mkdirSync(join(dir, "meta"), { recursive: true });
      writeFileSync(join(dir, "meta/_journal.json"), journal([{ tag: "0000_old", when: 1 }]));
      writeFileSync(join(dir, "0000_old.sql"), OLD);
      expect(drizzleJournal(dir, OPTS)[0]?.id).toBe("0000_old");
    }
  });

  test("refuses a file: URL on another host", () => {
    expect(() => drizzleJournal(new URL("file://elsewhere/m/"), OPTS)).toThrow(
      /must be a local file: URL/,
    );
  });

  test("refuses a URL that is not file:", () => {
    expect(() => drizzleJournal(new URL("https://example.invalid/m/"), OPTS)).toThrow(
      /must be a local file: URL/,
    );
  });

  test("refuses a when that is not an integer", () => {
    const dir = folder({ "meta/_journal.json": journal([{ tag: "a", when: 1.5 }]), "a.sql": OLD });
    expect(() => drizzleJournal(dir, OPTS)).toThrow(/journal entry is malformed/);
  });

  test("refuses missing or ill-typed marker options", () => {
    const dir = drizzleFolder();
    expect(() => drizzleJournal(dir, { name: "app", marker: 1 } as never)).toThrow(
      /marker must be an object/,
    );
    expect(() => drizzleJournal(dir, { name: "app", marker: { baseline: 1 } } as never)).toThrow(
      /marker baseline must be a string/,
    );
    expect(() =>
      drizzleJournal(dir, { name: "app", marker: { legacy: { prefix: "legacy" } } } as never),
    ).toThrow(/marker legacy\.through must be a string/);
  });

  test("sqlFolder counts a symlinked file and refuses a dangling one", () => {
    const real = folder({ "x.sql": A });
    const dir = folder({ "0000_init.sql": OLD });
    symlinkSync(join(real, "x.sql"), join(dir, "0001_link.sql"));
    expect(sqlFolder(dir, OPTS).map((m) => [m.id, m.kind])).toEqual([
      ["0000_init.sql", null],
      ["0001_link.sql", "additive"],
    ]);
    symlinkSync(join(real, "gone.sql"), join(dir, "0002_dangling.sql"));
    expect(() => sqlFolder(dir, OPTS)).toThrow(/cannot read 0002_dangling\.sql/);
  });

  test("sqlFolder drops a byte-order mark from the statement and hashes the bytes", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(A)]);
    const invalid = new Uint8Array([...enc("SELECT '"), 0xff, ...enc("';\n")]);
    const [b, i] = sqlFolder(folder({ "0000_bom.sql": bom, "0001_bad.sql": invalid }), OPTS);
    expect(b?.statements).toEqual([A]);
    expect(b?.kind).toBe("additive");
    expect(b?.sha256).toBe(createHash("sha256").update(bom).digest("hex"));
    expect(i?.sha256).toBe(createHash("sha256").update(invalid).digest("hex"));
  });

  test("drizzleJournal finds a marker behind a byte-order mark", () => {
    const dir = folder({
      "meta/_journal.json": journal([{ tag: "a", when: 1 }]),
      "a.sql": new Uint8Array([0xef, 0xbb, 0xbf, ...enc(H)]),
    });
    const [m] = drizzleJournal(dir, OPTS);
    expect(m?.kind).toBe("heavy");
    expect(m?.statements[0]?.startsWith("-- rootstock-migration")).toBe(true);
  });
});

describe("matchMarker edges", () => {
  const p = markerPattern("app");

  test("a marker must start its line", () => {
    expect(matchMarker("SELECT 1; -- app-migration: heavy\n", p)).toBeNull();
  });

  test("the prefix is lower-case only", () => {
    expect(() => markerPattern("App")).toThrow(/marker prefix must match/);
  });

  test("a CR-only file cannot widen the 40-line window", () => {
    expect(matchMarker(`${"--\r".repeat(100)}-- app-migration: heavy\r`, p)).toBeNull();
    expect(matchMarker(`${"-- ".repeat(100)}-- app-migration: heavy`, p)).toBeNull();
  });

  test("heavy wins when the header carries both kinds", () => {
    expect(matchMarker("-- app-migration: additive\n-- app-migration: heavy\n", p)).toBe("heavy");
    expect(matchMarker("-- app-migration: heavy\n-- app-migration: additive\n", p)).toBe("heavy");
  });
});

describe("legacy markers", () => {
  const LEG_A = "-- legacy-migration: additive\nSELECT 1;\n";
  const LEG_H = "-- legacy-migration: heavy\nSELECT 2;\n";
  const dir = () =>
    folder({
      "meta/_journal.json": journal([
        { tag: "0000_old", when: 1 },
        { tag: "20260101000000_last_legacy", when: 2 },
        { tag: "20260102000000_after", when: 3 },
        { tag: "20260103000000_mixed", when: 4 },
      ]),
      "0000_old.sql": OLD,
      "20260101000000_last_legacy.sql": LEG_A,
      "20260102000000_after.sql": LEG_H,
      "20260103000000_mixed.sql": `${LEG_H}${A}`,
    });

  test("count up to and including through, and only there", () => {
    const list = drizzleJournal(dir(), {
      name: "app",
      marker: {
        baseline: "0000_old",
        legacy: { prefix: "legacy", through: "20260101000000_last_legacy" },
      },
    });
    expect(list.map((m) => [m.id, m.kind])).toEqual([
      ["0000_old", null],
      ["20260101000000_last_legacy", "additive"],
      ["20260102000000_after", null],
      ["20260103000000_mixed", "additive"],
    ]);
    expect(unmarkedAfterBaseline(list)).toEqual(["20260102000000_after"]);
  });

  test("heavy wins across the legacy and canonical markers", () => {
    const list = drizzleJournal(dir(), {
      name: "app",
      marker: { legacy: { prefix: "legacy", through: "20260103000000_mixed" } },
    });
    expect(list.at(-1)?.kind).toBe("heavy");
  });
});

describe("in-memory readers", () => {
  const read = (files: Record<string, string>) => (name: string) => {
    const body = files[name];
    if (body === undefined) throw new Error(`ENOENT ${name}`);
    return new TextEncoder().encode(body);
  };

  test("drizzleJournalFrom reads exactly what drizzleJournal reads", () => {
    expect(drizzleJournalFrom(DRIZZLE_JOURNAL, read(DRIZZLE_FILES), OPTS)).toEqual(
      drizzleJournal(drizzleFolder(), OPTS),
    );
  });

  test("drizzleJournalFrom refuses text that is not JSON", () => {
    expect(() => drizzleJournalFrom("{", read({}), OPTS)).toThrow(
      /meta\/_journal\.json is not JSON/,
    );
  });

  test("sqlFolderFrom reads exactly what sqlFolder reads", () => {
    const files = { "0000_init.sql": OLD, "0001_a.sql": A };
    expect(sqlFolderFrom(Object.keys(files), read(files), OPTS)).toEqual(
      sqlFolder(folder(files), OPTS),
    );
  });

  test("a file the reader cannot produce is refused by name", () => {
    expect(() => sqlFolderFrom(["0000_init.sql"], read({}), OPTS)).toThrow(
      /cannot read 0000_init\.sql — ENOENT/,
    );
  });

  test("filename order is a code-unit sort", () => {
    const files = { "b.sql": OLD, "B.sql": OLD, "a1.sql": OLD, "aa.sql": OLD, "a_.sql": OLD };
    expect(sqlFolderFrom(Object.keys(files), read(files), OPTS).map((m) => m.id)).toEqual([
      "B.sql",
      "a1.sql",
      "a_.sql",
      "aa.sql",
      "b.sql",
    ]);
  });
});

describe("renames.json", () => {
  const renames = (map: Record<string, string>) => JSON.stringify(map);

  test("a renamed file keeps the name it was applied under as its key, and its hash", () => {
    const before = sqlFolder(folder({ "0000_init.sql": OLD, "0001_a.sql": A }), OPTS);
    const after = sqlFolder(
      folder({
        "20260101000000_init.sql": OLD,
        "20260101000001_a.sql": A,
        "20260201000000_new.sql": H,
        "renames.json": renames({
          "0000_init.sql": "20260101000000_init.sql",
          "0001_a.sql": "20260101000001_a.sql",
        }),
      }),
      OPTS,
    );
    expect(after.map((m) => [m.id, m.key])).toEqual([
      ["20260101000000_init.sql", "0000_init.sql"],
      ["20260101000001_a.sql", "0001_a.sql"],
      ["20260201000000_new.sql", "20260201000000_new.sql"],
    ]);
    expect(after.slice(0, 2).map((m) => [m.key, m.sha256])).toEqual(
      before.map((m) => [m.key, m.sha256]),
    );
  });

  const refusals: [string, Record<string, string>, RegExp][] = [
    ["not an object", { "renames.json": "[]" }, /must map old filenames to new ones/],
    ["not JSON", { "renames.json": "{" }, /cannot read renames\.json/],
    [
      "a non-.sql name",
      { "renames.json": renames({ a: "20260101000000_a.sql" }) },
      /entry "a" must map a \.sql name to a \.sql name/,
    ],
    [
      "a missing new name",
      { "renames.json": renames({ "0000_a.sql": "20260101000000_gone.sql" }) },
      /which is not in the folder/,
    ],
    [
      "an old name still present",
      {
        "0000_a.sql": OLD,
        "renames.json": renames({ "0000_a.sql": "20260101000000_a.sql" }),
      },
      /which is still in the folder/,
    ],
    [
      "two old names mapped to one new name",
      {
        "renames.json": renames({
          "0000_a.sql": "20260101000000_a.sql",
          "0001_a.sql": "20260101000000_a.sql",
        }),
      },
      /maps two names to/,
    ],
    [
      "an old name equal to another file's current name",
      {
        "20260102000000_b.sql": OLD,
        "renames.json": renames({ "20260102000000_b.sql": "20260101000000_a.sql" }),
      },
      /which is still in the folder/,
    ],
  ];
  for (const [what, extra, message] of refusals) {
    test(`refuses: ${what}`, () => {
      expect(() => sqlFolder(folder({ "20260101000000_a.sql": A, ...extra }), OPTS)).toThrow(
        message,
      );
    });
  }
});

describe("timestampRenames", () => {
  const at = (iso: string) => new Date(iso);

  test("names each numbered file by its time, keeps timestamped ones, bumps a taken second", () => {
    expect(
      timestampRenames([
        { id: "0000_first", at: at("2026-01-01T00:00:00.000Z") },
        { id: "0001_same-second", at: at("2026-01-01T00:00:00.001Z") },
        { id: "0002_third.sql", at: at("2026-01-01T00:00:05Z") },
        { id: "20260102000000_kept", at: at("2026-01-02T00:00:00Z") },
      ]),
    ).toEqual([
      { from: "0000_first", to: "20260101000000_first" },
      { from: "0001_same-second", to: "20260101000001_same_second" },
      { from: "0002_third.sql", to: "20260101000005_third.sql" },
    ]);
  });

  test("refuses a date that would reorder the source", () => {
    expect(() =>
      timestampRenames([
        { id: "0000_a", at: at("2026-01-02T00:00:00Z") },
        { id: "0001_b", at: at("2026-01-01T00:00:00Z") },
      ]),
    ).toThrow(/would sort before the name ahead of it/);
  });

  test("refuses a bump that runs into a kept timestamped name", () => {
    expect(() =>
      timestampRenames([
        { id: "0000_a", at: at("2026-01-01T00:00:00Z") },
        { id: "0001_b", at: at("2026-01-01T00:00:00Z") },
        { id: "20260101000001_kept", at: at("2026-01-01T00:00:01Z") },
      ]),
    ).toThrow(/would sort before the name ahead of it/);
  });

  test("refuses a name that is neither numbered nor timestamped, and an invalid date", () => {
    expect(() => timestampRenames([{ id: "init", at: at("2026-01-01T00:00:00Z") }])).toThrow(
      /neither numbered nor a valid YYYYMMDDHHMMSS_ name/,
    );
    expect(() =>
      timestampRenames([{ id: "20261399000000_bad_month", at: at("2026-01-01T00:00:00Z") }]),
    ).toThrow(/neither numbered nor a valid YYYYMMDDHHMMSS_ name/);
    expect(() => timestampRenames([{ id: "0000_a", at: new Date(Number.NaN) }])).toThrow(
      /needs a valid date/,
    );
  });
});
