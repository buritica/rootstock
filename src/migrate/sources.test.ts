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
      /"a" has no readable file \S*\/a\.sql/,
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

  test("every line terminator counts toward the 40-line window", () => {
    for (const eol of ["\r", "\u2028", "\u2029", "\r\n"]) {
      expect(matchMarker(`SELECT 1;${eol}-- app-migration: heavy${eol}`, p)).toBe("heavy");
      expect(matchMarker(`${`--${eol}`.repeat(39)}-- app-migration: heavy${eol}`, p)).toBe("heavy");
      expect(matchMarker(`${`--${eol}`.repeat(40)}-- app-migration: heavy${eol}`, p)).toBeNull();
    }
  });

  test("markerPattern needs at least one prefix", () => {
    expect(() => markerPattern()).toThrow(/needs a prefix/);
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

  test("the canonical marker also counts inside the legacy window, and heavy wins across both", () => {
    for (const [body, kind] of [
      ["-- rootstock-migration: heavy\nSELECT 1;\n", "heavy"],
      ["-- legacy-migration: additive\n-- rootstock-migration: heavy\n", "heavy"],
      ["-- rootstock-migration: heavy\n-- legacy-migration: additive\n", "heavy"],
      ["-- rootstock-migration: additive\n", "additive"],
    ] as const) {
      const [m] = drizzleJournal(
        folder({ "meta/_journal.json": journal([{ tag: "t", when: 1 }]), "t.sql": body }),
        { name: "app", marker: { legacy: { prefix: "legacy", through: "t" } } },
      );
      expect(m?.kind).toBe(kind);
    }
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
    ["not JSON", { "renames.json": "{" }, /renames\.json is not JSON/],
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
      /which is a file in the folder — that name is recorded as applied/,
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
      /which is a file in the folder — that name is recorded as applied/,
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
    ).toThrow(/before the file ahead of it/);
  });

  test("refuses a bump that runs past a kept timestamped name", () => {
    expect(() =>
      timestampRenames([
        { id: "0000_a", at: at("2026-01-01T00:00:00Z") },
        { id: "0001_b", at: at("2026-01-01T00:00:00Z") },
        { id: "20260101000001_a" },
      ]),
    ).toThrow(/"20260101000001_a" does not sort after "20260101000001_b"/);
  });

  test("any number of files may share a second", () => {
    expect(
      timestampRenames([
        { id: "0000_a", at: at("2026-01-01T10:00:00.100Z") },
        { id: "0001_b", at: at("2026-01-01T10:00:00.500Z") },
        { id: "0002_c", at: at("2026-01-01T10:00:00.900Z") },
        { id: "0003_d", at: at("2026-01-01T10:00:01.000Z") },
      ]).map((r) => r.to),
    ).toEqual(["20260101100000_a", "20260101100001_b", "20260101100002_c", "20260101100003_d"]);
  });

  test("a kept name holds its own second and needs no date", () => {
    expect(
      timestampRenames([
        { id: "0000_a", at: at("2026-01-01T00:00:00Z") },
        { id: "20260105000000_k" },
        { id: "0001_b", at: at("2026-01-06T00:00:00Z") },
      ]),
    ).toEqual([
      { from: "0000_a", to: "20260101000000_a" },
      { from: "0001_b", to: "20260106000000_b" },
    ]);
    expect(() =>
      timestampRenames([
        { id: "20260105000000_k" },
        { id: "0001_b", at: at("2026-01-04T00:00:00Z") },
      ]),
    ).toThrow(/before the file ahead of it/);
  });

  test("two kept names in one second are fine when they sort, and a renamed one bumps past them", () => {
    expect(
      timestampRenames([
        { id: "20260101000000_a" },
        { id: "20260101000000_b" },
        { id: "0001_c", at: at("2026-01-01T00:00:00Z") },
      ]),
    ).toEqual([{ from: "0001_c", to: "20260101000001_c" }]);
  });

  test("refuses a repeated id, a date out of range, an upper-case name and a non-Date", () => {
    expect(() =>
      timestampRenames([
        { id: "0000_a", at: at("2026-01-01T00:00:00Z") },
        { id: "0000_a", at: at("2026-01-02T00:00:00Z") },
      ]),
    ).toThrow(/"0000_a" is listed twice/);
    expect(() => timestampRenames([{ id: "0000_a", at: at("+010000-01-01T00:00:00Z") }])).toThrow(
      /outside 1970–9999/,
    );
    expect(() => timestampRenames([{ id: "0000_Init", at: at("2026-01-01T00:00:00Z") }])).toThrow(
      /must be lower-case/,
    );
    expect(() => timestampRenames([{ id: "0000_a", at: "2026-01-01" as never }])).toThrow(
      /needs a valid date/,
    );
  });

  test("its result is frozen, its refusals carry a code, and an empty input is empty", () => {
    const r = timestampRenames([{ id: "0000_a", at: at("2026-01-01T00:00:00Z") }]);
    expect(Object.isFrozen(r) && Object.isFrozen(r[0])).toBe(true);
    expect(timestampRenames([])).toEqual([]);
    try {
      timestampRenames([{ id: "init" }]);
      throw new Error("no refusal");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ERR_ROOTSTOCK_MIG_RENAME");
    }
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

describe("refusal texts and codes", () => {
  const codeOf = (run: () => unknown): unknown => {
    try {
      run();
    } catch (err) {
      return (err as { code?: unknown }).code;
    }
    throw new Error("expected a refusal");
  };

  test("E-MIG-SRC-ID is the contract's text with its code", () => {
    const run = () =>
      drizzleJournal(drizzleFolder(), { name: "app", marker: { baseline: "nope" } });
    expect(run).toThrow(
      new Error(
        'rootstock migrate: source "app": marker baseline "nope" is not one of its migrations',
      ),
    );
    expect(codeOf(run)).toBe("ERR_ROOTSTOCK_MIG_SRC_ID");
    const through = () =>
      drizzleJournal(drizzleFolder(), {
        name: "app",
        marker: { legacy: { prefix: "legacy", through: "nope" } },
      });
    expect(through).toThrow(
      new Error(
        'rootstock migrate: source "app": marker legacy.through "nope" is not one of its migrations',
      ),
    );
  });

  test("every other reader refusal starts rootstock migrate: and carries the source code", () => {
    const run = () => sqlFolder(folder({ "a.txt": "x" }), OPTS);
    expect(run).toThrow(/^rootstock migrate: /);
    expect(codeOf(run)).toBe("ERR_ROOTSTOCK_MIG_SRC");
  });

  test("a folder refusal names the folder", () => {
    const empty = folder({ "a.txt": "x" });
    expect(() => sqlFolder(empty, OPTS)).toThrow(empty);
    const missing = join(ROOT, "missing-folder");
    expect(() => sqlFolder(missing, OPTS)).toThrow(`cannot list ${missing}/`);
    const nojournal = folder({ "x.sql": OLD });
    expect(() => drizzleJournal(nojournal, OPTS)).toThrow(`${nojournal}/meta/_journal.json`);
    const badjournal = folder({ "meta/_journal.json": "{" });
    expect(() => drizzleJournal(badjournal, OPTS)).toThrow(
      `${badjournal}/meta/_journal.json is not JSON`,
    );
    const real = folder({ "x.sql": A });
    const dangling = folder({ "0000_init.sql": OLD });
    symlinkSync(join(real, "gone.sql"), join(dangling, "0001_dangling.sql"));
    expect(() => sqlFolder(dangling, OPTS)).toThrow(
      `cannot read 0001_dangling.sql in ${dangling}/`,
    );
  });

  test("an unknown key on the options, the marker or legacy is refused, naming it", () => {
    const dir = drizzleFolder();
    expect(() => drizzleJournal(dir, { name: "app", markers: {} } as never)).toThrow(
      /"markers" is not a known key/,
    );
    expect(() => drizzleJournal(dir, { name: "app", marker: { prefix: "app" } } as never)).toThrow(
      /marker\."prefix" is not a known key — known: baseline, legacy; a prefix moved to marker\.legacy\.prefix/,
    );
    expect(() =>
      drizzleJournal(dir, {
        name: "app",
        marker: { legacy: { prefix: "legacy", through: "0000_old", until: "x" } },
      } as never),
    ).toThrow(/marker\.legacy\."until" is not a known key/);
    expect(() => drizzleJournal(dir, { name: "app", marker: { legacy: 1 } } as never)).toThrow(
      /marker legacy must be an object/,
    );
  });
});

describe("imagine-pass refusals", () => {
  const codeOf = (run: () => unknown): { code?: unknown; cause?: unknown } => {
    try {
      run();
    } catch (err) {
      return err as { code?: unknown; cause?: unknown };
    }
    throw new Error("expected a refusal");
  };

  test("a read failure carries ERR_ROOTSTOCK_MIG_IO and keeps its cause", () => {
    const listing = codeOf(() => sqlFolder(join(ROOT, "missing-folder"), OPTS));
    expect(listing.code).toBe("ERR_ROOTSTOCK_MIG_IO");
    expect((listing.cause as { code?: unknown }).code).toBe("ENOENT");
    const cause = new Error("EIO");
    const file = codeOf(() =>
      sqlFolderFrom(
        ["0000_a.sql"],
        () => {
          throw cause;
        },
        OPTS,
      ),
    );
    expect(file.code).toBe("ERR_ROOTSTOCK_MIG_IO");
    expect(file.cause).toBe(cause);
    const journalFile = codeOf(() => drizzleJournal(folder({ "x.sql": OLD }), OPTS));
    expect(journalFile.code).toBe("ERR_ROOTSTOCK_MIG_IO");
    const tagFile = codeOf(() =>
      drizzleJournalFrom(
        DRIZZLE_JOURNAL,
        () => {
          throw cause;
        },
        OPTS,
      ),
    );
    expect(tagFile.code).toBe("ERR_ROOTSTOCK_MIG_IO");
  });

  test("a content refusal is not an I/O one", () => {
    expect(codeOf(() => sqlFolder(folder({ "a.txt": "x" }), OPTS)).code).toBe(
      "ERR_ROOTSTOCK_MIG_SRC",
    );
    expect(
      codeOf(() => sqlFolder(folder({ "20260101000000_a.sql": A, "renames.json": "{" }), OPTS))
        .code,
    ).toBe("ERR_ROOTSTOCK_MIG_SRC");
  });

  test("a name ending .sql in another case is refused, on disk and in memory", () => {
    const dir = folder({ "20260101000000_a.sql": A, "20260102000000_b.SQL": H });
    expect(() => sqlFolder(dir, OPTS)).toThrow(/"20260102000000_b\.SQL" in \S+ would never run/);
    expect(() =>
      sqlFolderFrom(["20260101000000_a.sql", "x.Sql"], () => new Uint8Array(), OPTS),
    ).toThrow(/"x\.Sql" would never run — name it \.sql/);
  });

  test("a chained rename says to map straight to the newest name", () => {
    const dir = folder({
      "20260101000000_a.sql": A,
      "renames.json": JSON.stringify({
        "0000_a.sql": "0000_b.sql",
        "0000_b.sql": "20260101000000_a.sql",
      }),
    });
    expect(() => sqlFolder(dir, OPTS)).toThrow(
      /renames do not chain: map "0000_a\.sql" straight to "20260101000000_a\.sql"/,
    );
  });

  test("a renames.json refusal names the folder", () => {
    const dir = folder({ "20260101000000_a.sql": A, "renames.json": "[]" });
    expect(() => sqlFolder(dir, OPTS)).toThrow(`${dir}/renames.json must map`);
  });

  test("timestampRenames names the file ahead and an invalid Date", () => {
    expect(() =>
      timestampRenames([
        { id: "0000_a", at: new Date("2026-01-02T00:00:00Z") },
        { id: "0001_b", at: new Date("2026-01-01T00:00:00Z") },
      ]),
    ).toThrow(/before the file ahead of it \("20260102000000_a"\)/);
    expect(() => timestampRenames([{ id: "0000_a", at: new Date("nope") }])).toThrow(
      /needs a valid date — got an invalid Date/,
    );
  });

  test("markerPattern refusals carry the source code", () => {
    expect(codeOf(() => markerPattern()).code).toBe("ERR_ROOTSTOCK_MIG_SRC");
    expect(codeOf(() => markerPattern("App")).code).toBe("ERR_ROOTSTOCK_MIG_SRC");
  });

  test("matchMarker reads every line even with a global or sticky pattern", () => {
    const text = "-- app-migration: additive\n-- app-migration: heavy\n";
    for (const flags of ["g", "y", "gy"]) {
      const p = new RegExp(markerPattern("app").source, flags);
      expect(matchMarker(text, p)).toBe("heavy");
      expect(matchMarker(text, p)).toBe("heavy");
    }
  });
});

describe("renames.json edges", () => {
  const read = (files: Record<string, string | Uint8Array>) => (name: string) => {
    const body = files[name];
    if (body === undefined) throw new Error(`ENOENT ${name}`);
    return typeof body === "string" ? new TextEncoder().encode(body) : body;
  };
  const RENAMED: Record<string, string> = {
    "20260101000000_init.sql": OLD,
    "20260101000001_a.sql": A,
    "20260201000000_new.sql": H,
    "notes.md": "not a migration",
    "renames.json": JSON.stringify({
      "0000_init.sql": "20260101000000_init.sql",
      "0001_a.sql": "20260101000001_a.sql",
    }),
  };
  const MARKED = {
    name: "app",
    marker: {
      baseline: "20260101000000_init.sql",
      legacy: { prefix: "legacy", through: "20260101000001_a.sql" },
    },
  } as const;

  test("sqlFolderFrom and sqlFolder agree with renames, markers and other files present", () => {
    expect(sqlFolderFrom(Object.keys(RENAMED), read(RENAMED), MARKED)).toEqual(
      sqlFolder(folder(RENAMED), MARKED),
    );
  });

  test("marker ids are the current names, never the keys", () => {
    const list = sqlFolderFrom(Object.keys(RENAMED), read(RENAMED), MARKED);
    expect(list.map((m) => m.baselined)).toEqual([true, false, false]);
    expect(() =>
      sqlFolderFrom(Object.keys(RENAMED), read(RENAMED), {
        name: "app",
        marker: { baseline: "0000_init.sql" },
      }),
    ).toThrow(/marker baseline "0000_init\.sql" is not one of its migrations/);
    expect(() =>
      sqlFolderFrom(Object.keys(RENAMED), read(RENAMED), {
        name: "app",
        marker: { baseline: "20260101000000_init" },
      }),
    ).toThrow(/is not one of its migrations/);
  });

  test("a byte-order mark before renames.json is fine", () => {
    const files = {
      ...RENAMED,
      "renames.json": new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode(RENAMED["renames.json"]),
      ]),
    };
    expect(sqlFolderFrom(Object.keys(files), read(files), OPTS)[0]?.key).toBe("0000_init.sql");
  });

  const refusals: [string, string, RegExp][] = [
    [
      "a non-.sql target",
      JSON.stringify({ "0000_a.sql": "notes.md" }),
      /must map a \.sql name to a \.sql name/,
    ],
    [
      "a non-string target",
      JSON.stringify({ "0000_a.sql": 1 }),
      /must map a \.sql name to a \.sql name/,
    ],
    [
      "a repeated key",
      '{"0000_a.sql": "20260101000000_init.sql", "0000_a.sql": "20260101000001_a.sql"}',
      /names "0000_a\.sql" twice/,
    ],
  ];
  for (const [what, map, message] of refusals) {
    test(`refuses: ${what}`, () => {
      const files = { ...RENAMED, "renames.json": map };
      expect(() => sqlFolderFrom(Object.keys(files), read(files), OPTS)).toThrow(message);
    });
  }

  test("refuses a name listed twice, and a renames.json that is a folder", () => {
    expect(() => sqlFolderFrom(["x.sql", "x.sql"], read({ "x.sql": OLD }), OPTS)).toThrow(
      /"x\.sql" is listed twice/,
    );
    const dir = folder({ "x.sql": OLD, "renames.json/keep": "" });
    expect(() => sqlFolder(dir, OPTS)).toThrow(/renames\.json is not a file/);
  });
});
