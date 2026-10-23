import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { bunSqlTransactor, pgCode, type Sql, type Transactor } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { migrateSlice } from "./slice.ts";
import { drizzleJournalFrom, type SourceMigration, sqlFolderFrom } from "./sources.ts";
import { drizzleTracker, filenameTracker, type TrackedSource, type Tracker } from "./tracked.ts";
import { bootstrapTracker, readTracker, recordApplied, trackerRowsFor } from "./tracker-db.ts";

// The tracker SQL against a real Postgres, once per transactor kind. Every case
// works in schemas of its own (`rs_k_<hex>`) and drops them when it is done.

let main: TestTransactor;
let sql: Sql;
let tx: Transactor;
const made: string[] = [];
const SLICE = migrateSlice({ schema: "rs_k_unused", ahead: "refuse" });

function schema(): string {
  const s = `rs_k_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  made.push(s);
  return s;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function reader(files: Record<string, string>): (name: string) => Uint8Array {
  return (name) => {
    const text = files[name];
    if (text === undefined) throw new Error(`no ${name}`);
    return bytes(text);
  };
}

const JOURNAL_FILES: Record<string, string> = {
  "20261020000000_first.sql": "-- rootstock-migration: additive\nSELECT 1/0;\n",
  "20261021000000_second.sql":
    "-- rootstock-migration: additive\nSELECT 1/0;\n--> statement-breakpoint\nSELECT 2/0;\n",
};
const JOURNAL = {
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "7", when: 1760918400000, tag: "20261020000000_first", breakpoints: true },
    { idx: 1, version: "7", when: 1761004800000, tag: "20261021000000_second", breakpoints: true },
  ],
};
const JOURNALED = drizzleJournalFrom(JSON.stringify(JOURNAL), reader(JOURNAL_FILES), {
  name: "app",
});

const FOLDER_FILES: Record<string, string> = {
  "0001_a.sql": "CREATE TABLE a (x int);\n",
  "0002_b.sql": "CREATE TABLE b (x int);\n",
  "0003_c.sql": "CREATE TABLE c (x int);\n",
};
const FOLDER = sqlFolderFrom(Object.keys(FOLDER_FILES), reader(FOLDER_FILES), { name: "app" });

function source(tracker: Tracker, migrations: readonly SourceMigration[]): TrackedSource {
  return { name: "app", migrations, tracker };
}

function bootstrap(src: TrackedSource): ReturnType<typeof bootstrapTracker> {
  return tx.begin((t) => bootstrapTracker(t, src, SLICE));
}

const LEGACY_DDL = "filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()";

/** A hash-less filename tracker, as an app's own migrator left it. */
async function legacyTable(
  s: string,
  table = "schema_migrations",
  ddl = LEGACY_DDL,
): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA "${s}"`);
  await sql.unsafe(`CREATE TABLE "${s}"."${table}" (${ddl})`);
}

/** Columns with type, nullability, default and primary-key membership. */
async function shapeOf(s: string, table: string): Promise<unknown[]> {
  return sql.unsafe(
    `select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as "notNull",
            regexp_replace(coalesce(pg_get_expr(d.adbin, d.adrelid), ''), '"?rs_k_[0-9a-f]+"?\\.', '') as "default",
            coalesce(a.attnum = any(i.indkey::int2[]), false) as pk
       from pg_attribute a
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
      where a.attrelid = to_regclass($1::text) and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [`"${s}"."${table}"`],
  );
}

async function refusal(p: Promise<unknown>): Promise<{ message: string; code: unknown }> {
  const error = await rejection(p);
  return { message: (error as Error).message, code: (error as { code?: unknown }).code };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

/** drizzle-orm's own migrate() over a folder holding `journal` and `files`. */
async function drizzleMigrate(
  migrationsSchema: string,
  journal: typeof JOURNAL,
  files: Record<string, string>,
  check?: (dir: string) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rs-drz-"));
  const client = postgres(process.env.ROOTSTOCK_TEST_DATABASE_URL ?? "", {
    max: 1,
    onnotice: () => {},
  });
  try {
    mkdirSync(join(dir, "meta"));
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    check?.(dir);
    await migrate(drizzle(client), { migrationsFolder: dir, migrationsSchema });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await client.end();
  }
}

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
  tx = main.transactor;
});

afterAll(async () => {
  if (made.length > 0) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${made.map((s) => `"${s}"`).join(", ")} CASCADE`);
  }
  await sql.unsafe("DROP ROLE IF EXISTS rs_tracker_owner");
  await main.close();
});

describe("drizzle tracker", () => {
  test("bootstrap creates schema and table with drizzle's own shape, once", async () => {
    const mine = schema();
    const ours = drizzleTracker({ schema: mine });
    const theirs = schema();
    await drizzleMigrate(theirs, { ...JOURNAL, entries: [] }, {});

    expect(await bootstrap(source(ours, JOURNALED))).toEqual({
      table: `${mine}.__drizzle_migrations`,
      created: true,
      upgraded: false,
      stamped: [],
    });
    const drizzleShape = await shapeOf(theirs, "__drizzle_migrations");
    expect(drizzleShape).toContainEqual(expect.objectContaining({ name: "id", pk: true }));
    expect(await shapeOf(mine, "__drizzle_migrations")).toEqual(drizzleShape);

    expect(await bootstrap(source(ours, JOURNALED))).toEqual({
      table: `${mine}.__drizzle_migrations`,
      created: false,
      upgraded: false,
      stamped: [],
    });
  });

  test("rows rootstock records read back as applied by drizzle-orm's migrate()", async () => {
    const s = schema();
    const tracker = drizzleTracker({ schema: s });
    await bootstrap(source(tracker, JOURNALED));
    await tx.begin(async (t) => {
      for (const m of JOURNALED) await recordApplied(t, tracker, SLICE, m);
    });

    // Every file divides by zero: drizzle running any of them would throw.
    await drizzleMigrate(s, JOURNAL, JOURNAL_FILES, (dir) => {
      // drizzle's own hash of each file is the hash rootstock recorded.
      expect(readMigrationFiles({ migrationsFolder: dir }).map((m) => m.hash)).toEqual(
        JOURNALED.map((m) => m.sha256),
      );
    });
    expect(await readTracker(sql, tracker, SLICE)).toEqual({
      schemaExists: true,
      tracked: true,
      hashColumn: true,
      rows: JOURNALED.map((m, i) => ({ rowId: i + 1, key: m.key, hash: m.sha256 })),
    });
  });

  test("created_at reads as exact text, NULL as null, even on a client that parses bigint", async () => {
    const s = schema();
    const tracker = drizzleTracker({ schema: s, table: "mig" });
    await bootstrap(source(tracker, []));
    // Past 2^53: a number would round it.
    await sql.unsafe(
      `INSERT INTO "${s}".mig (hash, created_at) VALUES ('h1', 9007199254740993), ('h2', NULL), ('h3', 9007199254740993)`,
    );
    const expected = {
      schemaExists: true,
      tracked: true,
      hashColumn: true,
      rows: [
        { rowId: 1, key: "9007199254740993", hash: "h1" },
        { rowId: 2, key: null, hash: "h2" },
        { rowId: 3, key: "9007199254740993", hash: "h3" },
      ],
    };
    expect(await readTracker(sql, tracker, SLICE)).toEqual(expected);
    const byKey = await tx.begin((t) => trackerRowsFor(t, tracker, SLICE, "9007199254740993"));
    expect(byKey.map((r) => r.hash)).toEqual(["h1", "h3"]);

    const client = new SQL({
      url: process.env.ROOTSTOCK_TEST_DATABASE_URL ?? "",
      max: 1,
      bigint: true,
    });
    try {
      const parsing = bunSqlTransactor(client);
      expect(await readTracker(parsing.sql, tracker, SLICE)).toEqual(expected);
      const again = await parsing.begin((t) =>
        trackerRowsFor(t, tracker, SLICE, "9007199254740993"),
      );
      expect(again.map((r) => r.hash)).toEqual(["h1", "h3"]);
    } finally {
      await client.close();
    }
  });

  test("refuses a drizzle-named table with no text hash column", async () => {
    const s = schema();
    await sql.unsafe(`CREATE SCHEMA "${s}"`);
    await sql.unsafe(`CREATE TABLE "${s}".__drizzle_migrations (id serial, created_at bigint)`);
    expect(await refusal(readTracker(sql, drizzleTracker({ schema: s }), SLICE))).toEqual({
      message: `rootstock migrate: ${s}.__drizzle_migrations is not a tracker rootstock can read — found no column hash; expected hash text`,
      code: "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
    });
  });
});

describe("filename tracker", () => {
  test("bootstrap creates it with sha256 when absent; recordApplied writes key and hash", async () => {
    const s = schema();
    const tracker = filenameTracker({ schema: s });
    expect(await bootstrap(source(tracker, FOLDER))).toEqual({
      table: `${s}.schema_migrations`,
      created: true,
      upgraded: false,
      stamped: [],
    });
    expect(await shapeOf(s, "schema_migrations")).toEqual([
      { name: "filename", type: "text", notNull: true, default: "", pk: true },
      { name: "sha256", type: "text", notNull: false, default: "", pk: false },
      {
        name: "applied_at",
        type: "timestamp with time zone",
        notNull: true,
        default: "now()",
        pk: false,
      },
    ]);
    const [m] = FOLDER;
    if (m === undefined) throw new Error("fixture");
    await tx.begin((t) => recordApplied(t, tracker, SLICE, m));
    expect(await readTracker(sql, tracker, SLICE)).toEqual({
      schemaExists: true,
      tracked: true,
      hashColumn: true,
      rows: [{ rowId: null, key: m.key, hash: m.sha256 }],
    });
    // The CHECK holds the column to a sha256.
    const bad = await rejection(
      sql.unsafe(`INSERT INTO "${s}".schema_migrations (filename, sha256) VALUES ('x', 'nope')`),
    );
    expect(pgCode(bad)).toBe("23514");
  });

  test("bootstrap creates the table in a schema that already exists", async () => {
    const s = schema();
    await sql.unsafe(`CREATE SCHEMA "${s}"`);
    const tracker = filenameTracker({ schema: s, table: "app_migrations" });
    expect(await readTracker(sql, tracker, SLICE)).toEqual({
      schemaExists: true,
      tracked: false,
      hashColumn: false,
      rows: [],
    });
    expect((await bootstrap(source(tracker, FOLDER))).created).toBe(true);
    expect((await readTracker(sql, tracker, SLICE)).tracked).toBe(true);
  });

  test("a populated hash-less tracker is upgraded in place: rows kept, files' hashes stamped", async () => {
    const s = schema();
    await legacyTable(s, "app_migrations");
    await sql.unsafe(
      `INSERT INTO "${s}".app_migrations (filename, applied_at) VALUES
         ('0001_a.sql', '2026-01-01T00:00:00Z'), ('0002_b.sql', '2026-01-02T00:00:00Z'),
         ('0099_gone.sql', '2026-01-03T00:00:00Z')`,
    );
    const tracker = filenameTracker({ schema: s, table: "app_migrations" });
    expect(await readTracker(sql, tracker, SLICE)).toEqual({
      schemaExists: true,
      tracked: true,
      hashColumn: false,
      rows: [
        { rowId: null, key: "0001_a.sql", hash: null },
        { rowId: null, key: "0002_b.sql", hash: null },
        { rowId: null, key: "0099_gone.sql", hash: null },
      ],
    });
    expect(await tx.begin((t) => trackerRowsFor(t, tracker, SLICE, "0001_a.sql"))).toEqual([
      { rowId: null, key: "0001_a.sql", hash: null },
    ]);

    expect(await bootstrap(source(tracker, FOLDER))).toEqual({
      table: `${s}.app_migrations`,
      created: false,
      upgraded: true,
      stamped: ["0001_a.sql", "0002_b.sql"],
    });
    const hashOf = (name: string) => FOLDER.find((m) => m.key === name)?.sha256 ?? "";
    expect(
      await sql.unsafe(
        `select filename, sha256, applied_at::text as at from "${s}".app_migrations order by filename`,
      ),
    ).toEqual([
      { filename: "0001_a.sql", sha256: hashOf("0001_a.sql"), at: "2026-01-01 00:00:00+00" },
      { filename: "0002_b.sql", sha256: hashOf("0002_b.sql"), at: "2026-01-02 00:00:00+00" },
      // No file: nothing to stamp it with, so it stays NULL (status names it).
      { filename: "0099_gone.sql", sha256: null, at: "2026-01-03 00:00:00+00" },
    ]);
    expect(await tx.begin((t) => trackerRowsFor(t, tracker, SLICE, "0001_a.sql"))).toEqual([
      { rowId: null, key: "0001_a.sql", hash: hashOf("0001_a.sql") },
    ]);
    // The upgrade's column carries the same CHECK as a created one.
    const bad = await rejection(
      sql.unsafe(`INSERT INTO "${s}".app_migrations (filename, sha256) VALUES ('x', 'nope')`),
    );
    expect(pgCode(bad)).toBe("23514");

    // A second bootstrap finds nothing to do.
    expect(await bootstrap(source(tracker, FOLDER))).toEqual({
      table: `${s}.app_migrations`,
      created: false,
      upgraded: false,
      stamped: [],
    });
  });

  test("rows read in byte order", async () => {
    const s = schema();
    const tracker = filenameTracker({ schema: s });
    await bootstrap(source(tracker, []));
    await sql.unsafe(
      `INSERT INTO "${s}".schema_migrations (filename) VALUES ('b.sql'), ('_x.sql'), ('B.sql'), ('a.sql')`,
    );
    const keys = (await readTracker(sql, tracker, SLICE)).rows.map((r) => r.key);
    expect(keys).toEqual(["B.sql", "_x.sql", "a.sql", "b.sql"]);
    expect(keys).toEqual([...keys].sort());
  });

  test("a stamped hash is never overwritten, even by a file that changed since", async () => {
    const tracker = filenameTracker({ schema: schema() });
    await bootstrap(source(tracker, FOLDER));
    const [m] = FOLDER;
    if (m === undefined) throw new Error("fixture");
    await tx.begin((t) => recordApplied(t, tracker, SLICE, { ...m, sha256: "0".repeat(64) }));
    expect((await bootstrap(source(tracker, FOLDER))).stamped).toEqual([]);
    expect((await readTracker(sql, tracker, SLICE)).rows[0]?.hash).toBe("0".repeat(64));
  });

  test("a renamed file stamps the row recorded under its old name, reported by its new id", async () => {
    const s = schema();
    await legacyTable(s);
    await sql.unsafe(`INSERT INTO "${s}".schema_migrations (filename) VALUES ('0001_a.sql')`);
    const files = {
      "20260101000000_a.sql": FOLDER_FILES["0001_a.sql"] ?? "",
      "renames.json": JSON.stringify({ "0001_a.sql": "20260101000000_a.sql" }),
    };
    const renamed = sqlFolderFrom(Object.keys(files), reader(files), { name: "app" });
    const tracker = filenameTracker({ schema: s });
    expect((await bootstrap(source(tracker, renamed))).stamped).toEqual(["20260101000000_a.sql"]);
    expect((await readTracker(sql, tracker, SLICE)).rows).toEqual([
      { rowId: null, key: "0001_a.sql", hash: renamed[0]?.sha256 ?? "" },
    ]);
  });

  test.each([
    [
      "an extra column",
      `${LEGACY_DDL}, note text`,
      "filename text (primary key), applied_at timestamp with time zone, note text",
    ],
    [
      "a wrong type",
      "filename text PRIMARY KEY, applied_at timestamp NOT NULL DEFAULT now()",
      "filename text (primary key), applied_at timestamp without time zone",
    ],
    [
      "no primary key",
      "filename text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()",
      "filename text, applied_at timestamp with time zone",
    ],
    [
      "a composite primary key",
      "filename text, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (filename, applied_at)",
      "filename text (primary key), applied_at timestamp with time zone (primary key)",
    ],
    ["no columns", "", "(none)"],
    [
      "an applied_at an insert cannot omit",
      "filename text PRIMARY KEY, applied_at timestamptz NOT NULL",
      "filename text (primary key), applied_at timestamp with time zone (not null, no default)",
    ],
    [
      "another migrator's columns",
      "version bigint PRIMARY KEY, dirty boolean NOT NULL",
      "version bigint (primary key), dirty boolean (not null, no default)",
    ],
  ])("refuses to upgrade a table with %s, and leaves it as it was", async (_what, ddl, found) => {
    const s = schema();
    await legacyTable(s, "schema_migrations", ddl);
    const r = await refusal(bootstrap(source(filenameTracker({ schema: s }), FOLDER)));
    expect(r).toEqual({
      message: `rootstock migrate: ${s}.schema_migrations is not a tracker rootstock can upgrade — found columns ${found}; expected exactly filename text primary key and applied_at timestamptz`,
      code: "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
    });
    expect(await shapeOf(s, "schema_migrations")).not.toContainEqual(
      expect.objectContaining({ name: "sha256" }),
    );
  });

  test("refuses to upgrade a table the current role does not own", async () => {
    const s = schema();
    await legacyTable(s);
    const found = await sql.unsafe("select 1 from pg_roles where rolname = 'rs_tracker_owner'");
    if (found.length === 0) await sql.unsafe("CREATE ROLE rs_tracker_owner NOLOGIN");
    await sql.unsafe(`ALTER TABLE "${s}".schema_migrations OWNER TO rs_tracker_owner`);
    const [me] = await sql.unsafe<{ user: string }>(`select current_user::text as "user"`);
    const r = await refusal(bootstrap(source(filenameTracker({ schema: s }), FOLDER)));
    expect(r.message).toEndWith(
      `found columns filename text (primary key), applied_at timestamp with time zone, not owned by ${me?.user}; expected exactly filename text primary key and applied_at timestamptz`,
    );
    expect(r.code).toBe("ERR_ROOTSTOCK_MIG_TRACKER_SHAPE");
  });

  test.each([
    [
      "a sha256 that is not text",
      `${LEGACY_DDL}, sha256 bytea`,
      "found column sha256 bytea; expected sha256 text",
    ],
    ["a view", "", 'found a relation of kind "v"; expected a table'],
    [
      "a sha256 but no filename",
      "name text PRIMARY KEY, sha256 text",
      "found no column filename; expected filename text",
    ],
  ])("refuses to read or stamp a tracker with %s", async (what, ddl, tail) => {
    const s = schema();
    await sql.unsafe(`CREATE SCHEMA "${s}"`);
    if (what === "a view") {
      await sql.unsafe(`CREATE TABLE "${s}".t (${LEGACY_DDL}, sha256 text)`);
      await sql.unsafe(`CREATE VIEW "${s}".schema_migrations AS SELECT * FROM "${s}".t`);
    } else {
      await sql.unsafe(`CREATE TABLE "${s}".schema_migrations (${ddl})`);
    }
    const tracker = filenameTracker({ schema: s });
    const expected = {
      message: `rootstock migrate: ${s}.schema_migrations is not a tracker rootstock can read — ${tail}`,
      code: "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
    };
    expect(await refusal(readTracker(sql, tracker, SLICE))).toEqual(expected);
    expect(await refusal(bootstrap(source(tracker, FOLDER)))).toEqual(expected);
  });
});

describe("reads", () => {
  test.each([
    [
      "another migrator's columns",
      "filename",
      "version bigint PRIMARY KEY, dirty boolean NOT NULL",
      "found no column filename; expected filename text",
    ],
    [
      "no created_at",
      "drizzle",
      "id serial PRIMARY KEY, hash text NOT NULL",
      "found no column created_at; expected created_at bigint",
    ],
    [
      "a text created_at",
      "drizzle",
      "id serial PRIMARY KEY, hash text NOT NULL, created_at text",
      "found column created_at text; expected created_at bigint",
    ],
    [
      "no id",
      "drizzle",
      "hash text NOT NULL, created_at bigint",
      "found no column id; expected id integer",
    ],
  ])(
    "a monitor's read refuses a table with %s instead of a driver error",
    async (_what, kind, ddl, tail) => {
      const s = schema();
      const tracker =
        kind === "drizzle"
          ? drizzleTracker({ schema: s, table: "t" })
          : filenameTracker({ schema: s, table: "t" });
      await sql.unsafe(`CREATE SCHEMA "${s}"`);
      await sql.unsafe(`CREATE TABLE "${s}".t (${ddl})`);
      expect(await refusal(readTracker(sql, tracker, SLICE))).toEqual({
        message: `rootstock migrate: ${s}.t is not a tracker rootstock can read — ${tail}`,
        code: "ERR_ROOTSTOCK_MIG_TRACKER_SHAPE",
      });
    },
  );

  test("a missing tracker reads as untracked, and the per-key re-read as no row", async () => {
    for (const tracker of [
      drizzleTracker({ schema: schema() }),
      filenameTracker({ schema: schema() }),
      { kind: "rootstock" } as const,
    ]) {
      const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
      expect(await readTracker(sql, tracker, slice)).toEqual({
        schemaExists: false,
        tracked: false,
        hashColumn: false,
        rows: [],
      });
      expect(await tx.begin((t) => trackerRowsFor(t, tracker, slice, "x"))).toEqual([]);
    }
  });

  test("rootstock's own tracker is read in the slice's schema and never bootstrapped", async () => {
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    const src = { name: "rootstock", migrations: [], tracker: { kind: "rootstock" } } as const;
    expect(await tx.begin((t) => bootstrapTracker(t, src, slice))).toEqual({
      table: `${slice.schema}.schema_migrations`,
      created: false,
      upgraded: false,
      stamped: [],
    });
    expect((await readTracker(sql, { kind: "rootstock" }, slice)).schemaExists).toBe(false);
    await sql.unsafe(`CREATE SCHEMA "${slice.schema}"`);
    await sql.unsafe(
      `CREATE TABLE "${slice.schema}".schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const [m] = FOLDER;
    if (m === undefined) throw new Error("fixture");
    await tx.begin((t) => recordApplied(t, { kind: "rootstock" }, slice, m));
    expect(await readTracker(sql, { kind: "rootstock" }, slice)).toEqual({
      schemaExists: true,
      tracked: true,
      hashColumn: true,
      rows: [{ rowId: null, key: m.key, hash: m.sha256 }],
    });
  });

  test.each([
    [
      { kind: "Filename", schema: "public", table: "t" },
      /tracker kind must be "drizzle", "filename" or "rootstock" — got "Filename"/,
    ],
    [
      { kind: "drizzle", schema: "Drizzle", table: "t" },
      /rootstock migrate: tracker schema must match/,
    ],
    [
      { kind: "filename", schema: "public", table: "a;b" },
      /rootstock migrate: tracker table must match/,
    ],
  ])(
    "refuses a hand-built tracker the factories would not return (%#)",
    async (tracker, message) => {
      const r = await rejection(readTracker(sql, tracker as never, SLICE));
      expect((r as Error).message).toMatch(message);
      expect((r as { code?: unknown }).code).toBe("ERR_ROOTSTOCK_MIG_SRC");
    },
  );
});
