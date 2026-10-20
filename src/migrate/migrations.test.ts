import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { MANIFEST } from "./manifest.ts";
import { parseMigration, rootstockMigrations } from "./migrations.ts";

const DIR = new URL("./migrations/", import.meta.url);
const FILE = "20261020000000_schema_migrations.sql";
const NAME = /^\d{14}_[a-z0-9_]+\.sql$/;

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("the shipped files", () => {
  test("the manifest is the directory, sorted", () => {
    expect([...MANIFEST]).toEqual(readdirSync(DIR).sort());
  });

  for (const file of readdirSync(DIR).sort()) {
    test(`${file} follows the file rules`, () => {
      expect(file).toMatch(NAME);
      const text = readFileSync(new URL(file, DIR), "utf8");
      const head = text.split("\n").slice(0, 40).join("\n");
      expect(head).toMatch(/^--\s*rootstock-migration:\s*(additive|heavy)\s*$/m);
      for (const chunk of text.split(/^--> statement-breakpoint$/m)) {
        const code = chunk.split("\n").filter((l) => l.trim() !== "" && !/^\s*--/.test(l));
        expect(code.length).toBeGreaterThan(0);
      }
      // Schema-free: no qualified name outside comments and string literals,
      // except pg_catalog's.
      const bare = text
        .replace(/--.*$/gm, "")
        .replace(/'(?:[^']|'')*'/g, "''")
        .replaceAll("pg_catalog.", "");
      expect(bare).not.toMatch(/[a-z_"]\s*\.\s*[a-z_"]/i);
    });
  }

  test("schema-migrations-sha-pinned", () => {
    const [first] = rootstockMigrations();
    expect(first?.filename).toBe(FILE);
    expect(first?.sha256).toBe("066321b3d800c6062cebd7924d98964fe52732198950098a9459d7707b2bfc99");
    expect(first?.kind).toBe("additive");
    expect(first?.statements).toHaveLength(1);
  });
});

describe("rootstockMigrations", () => {
  test("is read once and frozen all the way down", () => {
    const list = rootstockMigrations();
    expect(rootstockMigrations()).toBe(list);
    expect(Object.isFrozen(list)).toBe(true);
    for (const m of list) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.statements)).toBe(true);
    }
  });

  test("lists the manifest in order", () => {
    expect(rootstockMigrations().map((m) => m.filename)).toEqual([...MANIFEST]);
  });
});

describe("parseMigration", () => {
  test("splits statements on breakpoint lines and hashes the bytes", () => {
    const text =
      "-- rootstock-migration: heavy\nCREATE TABLE a (x int);\n--> statement-breakpoint\nCREATE TABLE b (y int);\n";
    expect(parseMigration("20200101000000_two.sql", encode(text))).toEqual({
      filename: "20200101000000_two.sql",
      sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      kind: "heavy",
      statements: [
        "-- rootstock-migration: heavy\nCREATE TABLE a (x int);",
        "CREATE TABLE b (y int);",
      ],
    });
  });

  test("a breakpoint must be the whole line", () => {
    const text =
      "-- rootstock-migration: additive\nSELECT 1; --> statement-breakpoint\nSELECT 2;\n";
    expect(parseMigration("20200101000000_one.sql", encode(text)).statements).toHaveLength(1);
  });

  test("the marker tolerates spacing and may sit on line 40", () => {
    const padding = "-- note\n".repeat(39);
    const m = parseMigration(
      "20200101000000_late.sql",
      encode(`${padding}--   rootstock-migration:   additive  \nSELECT 1;\n`),
    );
    expect(m.kind).toBe("additive");
  });

  test("a marker on line 41, a misspelt kind or none at all is refused", () => {
    const late = `${"-- note\n".repeat(40)}-- rootstock-migration: additive\nSELECT 1;\n`;
    for (const text of [late, "-- rootstock-migration: huge\nSELECT 1;\n", "SELECT 1;\n"]) {
      let message = "";
      try {
        parseMigration("20200101000000_x.sql", encode(text));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(
        'rootstockMigrations: 20200101000000_x.sql has no "-- rootstock-migration: additive|heavy" line in its first 40 lines',
      );
    }
  });
});
