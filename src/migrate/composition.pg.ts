import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { schemaFactory } from "./fixtures.pg-support.ts";
import {
  drizzleJournal,
  drizzleTracker,
  filenameTracker,
  type MigrateCliDeps,
  migrateCli,
  migrateSlice,
  rootstockSource,
  sqlFolder,
  type TrackedSource,
} from "./index.ts";

// B-O3: the three app shapes 0.5.0 serves, as synthetic fixtures read from
// disk by the real readers and driven through the public entry point only
// (`migrateCli`), once per transactor kind. Shapes, not apps: a drizzle
// journal with a legacy marker and a baseline; two SQL folders, one renamed
// from numbered files and tracked by an older hash-less table; and an app
// with two databases (two slices here) run one after the other.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_o");
const root = mkdtempSync(join(tmpdir(), "rs-composition-"));

function folder(name: string, files: Record<string, string>): string {
  const dir = join(root, `${name}-${crypto.randomUUID().slice(0, 8)}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return `${dir}/`;
}

function journal(tags: readonly string[]): string {
  return JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: tags.map((tag, idx) => ({
      idx,
      version: "7",
      when: 1700000000000 + idx,
      tag,
      breakpoints: true,
    })),
  });
}

async function cli(
  argv: string[],
  slice: ReturnType<typeof migrateSlice>,
  sources: TrackedSource[],
): Promise<{ code: 0 | 1 | 2; lines: string[] }> {
  const lines: string[] = [];
  const deps: MigrateCliDeps = {
    transactor: main.transactor,
    slice,
    sources,
    backup: { skip: "composition test" },
    fix: "bun run migrate apply --manual",
    out: (l) => lines.push(l),
  };
  return { code: await migrateCli(argv, deps), lines };
}

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
  rmSync(root, { recursive: true, force: true });
});

describe("composition (B-O3)", () => {
  test("a drizzle journal with a baseline and a legacy marker", async () => {
    const d = schema();
    const slice = migrateSlice({ schema: schema() });
    const files: Record<string, string> = {
      "0000_old.sql": `CREATE TABLE "${d}".old (x int);\n--> statement-breakpoint\nINSERT INTO "${d}".old VALUES (1);`,
      "0001_legacy.sql": `-- legacyapp-migration: additive\nCREATE TABLE "${d}".legacy (x int);`,
      "20261020000000_new.sql": `-- rootstock-migration: additive\nCREATE TABLE "${d}".new (x int);`,
    };
    const tags = Object.keys(files).map((f) => f.replace(/\.sql$/, ""));
    const opts = {
      name: "app",
      marker: { baseline: "0000_old", legacy: { prefix: "legacyapp", through: "0001_legacy" } },
    };
    const read = (dir: string): TrackedSource[] => [
      rootstockSource(slice),
      {
        name: "app",
        tracker: drizzleTracker({ schema: d }),
        migrations: drizzleJournal(dir, opts),
      },
    ];
    const v1 = read(folder("journal", { ...files, "meta/_journal.json": journal(tags) }));

    // A fresh database carries an unmarked baselined file: deploy refuses it,
    // and only it (the legacy-marked file reads as additive). The manual entry
    // applies a baselined file without --allow-heavy.
    expect(await cli(["apply", "--deploy"], slice, v1)).toEqual({
      code: 1,
      lines: [
        "rootstock migrate: deploy refuses pending migration(s) that are heavy or unmarked: app/0000_old (unmarked (baselined)) — apply them by hand (bun run migrate apply --manual), then redeploy",
      ],
    });
    expect((await cli(["apply", "--manual"], slice, v1)).code).toBe(0);
    expect(await cli(["status"], slice, v1)).toEqual({
      code: 0,
      lines: ["rootstock: ok (1 applied)", "app: ok (3 applied)"],
    });

    // The next release adds one additive file: the deploy applies it alone.
    const next = `-- rootstock-migration: additive\nALTER TABLE "${d}".new ADD COLUMN y int;`;
    const v2 = read(
      folder("journal", {
        ...files,
        "20261021000000_next.sql": next,
        "meta/_journal.json": journal([...tags, "20261021000000_next"]),
      }),
    );
    expect((await cli(["status"], slice, v2)).code).toBe(1);
    const deploy = await cli(["apply", "--deploy"], slice, v2);
    expect(deploy.code).toBe(0);
    expect(deploy.lines[0]).toBe("applying app/20261021000000_next (additive)");
    expect((await cli(["status"], slice, v2)).code).toBe(0);
  });

  test("two SQL folders, one renamed from numbered files over a hash-less tracker", async () => {
    const f = schema();
    const slice = migrateSlice({ schema: schema() });
    const init = `CREATE TABLE "${f}".users (id int);`;
    // The database an older migrator left: a hash-less tracker naming the old file.
    await sql.unsafe(`CREATE SCHEMA "${f}"`);
    await sql.unsafe(init);
    await sql.unsafe(
      `CREATE TABLE "${f}".schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await sql.unsafe(`INSERT INTO "${f}".schema_migrations (filename) VALUES ('0000_init.sql')`);

    const domain = sqlFolder(
      folder("domain", {
        "20250101000000_init.sql": init,
        "20261020000000_add.sql": `-- rootstock-migration: additive\nALTER TABLE "${f}".users ADD COLUMN name text;`,
        "renames.json": JSON.stringify({ "0000_init.sql": "20250101000000_init.sql" }),
      }),
      { name: "domain", marker: { baseline: "20250101000000_init.sql" } },
    );
    const auth = sqlFolder(
      folder("auth", {
        "20261020000000_sessions.sql": `-- rootstock-migration: additive\nCREATE TABLE "${f}".sessions (id int);`,
      }),
      { name: "auth" },
    );
    const sources: TrackedSource[] = [
      rootstockSource(slice),
      { name: "domain", tracker: filenameTracker({ schema: f }), migrations: domain },
      {
        name: "auth",
        tracker: filenameTracker({ schema: f, table: "auth_schema_migrations" }),
        migrations: auth,
      },
    ];

    const before = await cli(["status"], slice, sources);
    expect(before.code).toBe(1);
    expect(before.lines).toContain(
      "domain: behind: 20261020000000_add.sql; hashes not yet stamped: 1",
    );

    const apply = await cli(["apply", "--deploy"], slice, sources);
    expect(apply.code).toBe(0);
    expect(apply.lines).toContain(`trackers upgraded: ${f}.schema_migrations`);
    expect(apply.lines).toContain("hashes stamped: 1");
    expect(apply.lines).toContain(`trackers created: ${f}.auth_schema_migrations`);
    // The rename wrote nothing: the row keeps the name it was applied under.
    const rows = await sql.unsafe<{ filename: string }>(
      `select filename from "${f}".schema_migrations order by filename`,
    );
    expect(rows.map((r) => r.filename)).toEqual(["0000_init.sql", "20261020000000_add.sql"]);
    expect(await cli(["status"], slice, sources)).toEqual({
      code: 0,
      lines: ["rootstock: ok (1 applied)", "domain: ok (2 applied)", "auth: ok (1 applied)"],
    });
  });

  // Two slices on one connection: the stricter case for lock and tracker
  // collisions. Combining the codes is the caller's loop; this shows each run
  // is independent, with the refusing one first.
  test("two databases, each run on its own: one refusing leaves the other to apply", async () => {
    const one = { slice: migrateSlice({ schema: schema() }), f: schema() };
    const two = { slice: migrateSlice({ schema: schema() }), f: schema() };
    const sourcesOf = (w: typeof one, heavy: boolean): TrackedSource[] => [
      rootstockSource(w.slice),
      {
        name: "auth",
        tracker: filenameTracker({ schema: w.f }),
        migrations: sqlFolder(
          folder("auth", {
            "20261020000000_t.sql": `-- rootstock-migration: ${heavy ? "heavy" : "additive"}\nCREATE TABLE "${w.f}".t (x int);`,
          }),
          { name: "auth" },
        ),
      },
    ];
    await sql.unsafe(`CREATE SCHEMA "${one.f}"`);
    await sql.unsafe(`CREATE SCHEMA "${two.f}"`);
    const refused = await cli(["apply", "--deploy"], two.slice, sourcesOf(two, true));
    expect(refused.code).toBe(1);
    expect(refused.lines[0]).toContain("auth/20261020000000_t.sql (heavy)");
    // Refused before any file ran: not even rootstock's own tracker exists.
    const [tracker] = await sql.unsafe<{ name: string | null }>(
      "select to_regclass($1::text)::text as name",
      [`"${two.slice.schema}".schema_migrations`],
    );
    expect(tracker?.name).toBeNull();
    expect((await cli(["apply", "--deploy"], one.slice, sourcesOf(one, false))).code).toBe(0);
    expect((await cli(["status"], one.slice, sourcesOf(one, false))).code).toBe(0);
    expect((await cli(["status"], two.slice, sourcesOf(two, true))).lines).toContain(
      "fix: bun run migrate apply --manual",
    );
  });
});
