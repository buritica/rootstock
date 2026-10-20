import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrationList } from "./apply.ts";
import type { Sql } from "./db-surface.ts";
import { parseMigration, type RootstockMigration, rootstockMigrations } from "./migrations.ts";
import { migrateSlice } from "./slice.ts";
import { rootstockMigrationStatus } from "./status.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "./test-transactor.pg-support.ts";

// The applier against a real Postgres, once per transactor kind. Every case
// works in schemas of its own (`rs_t_<hex>`) and drops them when it is done.

const FILE = "20261020000000_schema_migrations.sql";
const SHIPPED = rootstockMigrations();

function fixture(filename: string, text: string): RootstockMigration {
  return parseMigration(filename, new TextEncoder().encode(text));
}

const BROKEN = fixture(
  "20261020000001_broken.sql",
  "-- rootstock-migration: additive\nCREATE TABLE ok_t (x int);\n--> statement-breakpoint\nSELECT 1/0;\n",
);
const EXTRA = fixture(
  "20261020000002_extra.sql",
  "-- rootstock-migration: additive\nCREATE TABLE extra_t (x int);\n",
);
const HEAVY = fixture(
  "20261020000003_heavy.sql",
  "-- rootstock-migration: heavy\nCREATE TABLE heavy_t (x int);\n--> statement-breakpoint\nINSERT INTO heavy_t VALUES (1);\n",
);
const FUTURE = "20991231000000_future.sql";

let main: TestTransactor;
let sql: Sql;
const made: string[] = [];

function schema(): string {
  const s = `rs_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  made.push(s);
  return s;
}

async function one<T>(query: string, params?: unknown[]): Promise<T | undefined> {
  return (await sql.unsafe<T>(query, params))[0];
}

async function exists(s: string): Promise<boolean> {
  const row = await one<{ e: boolean }>("select to_regnamespace($1::text) is not null as e", [s]);
  return row?.e === true;
}

async function rowsOf(s: string): Promise<{ filename: string; sha256: string }[]> {
  return sql.unsafe(`select filename, sha256 from "${s}".schema_migrations order by filename`);
}

/** The SQLSTATE anywhere on an error's cause chain (drivers and drizzle nest it differently). */
function sqlstate(err: unknown): string | undefined {
  for (let e = err, hop = 0; e !== null && typeof e === "object" && hop < 5; hop++) {
    const { code, errno, cause } = e as { code?: unknown; errno?: unknown; cause?: unknown };
    for (const c of [code, errno]) if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    e = cause;
  }
  return undefined;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a refusal");
}

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  await sql.unsafe("RESET ROLE");
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${made.map((s) => `"${s}"`).join(", ")} CASCADE`);
  await main.close();
});

describe("applyRootstockMigrations", () => {
  test("fresh database: creates the schema, applies, status clean", async () => {
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    const before = await rootstockMigrationStatus(sql, slice);
    expect(before).toMatchObject({ schemaExists: false, tracked: false, applied: [], red: true });
    expect(before.pending.map((m) => m.filename)).toEqual([FILE]);

    const report = await applyMigrationList(main.transactor, slice, SHIPPED);
    expect(report).toEqual({
      schema: slice.schema,
      schemaCreated: true,
      applied: [FILE],
      alreadyApplied: 0,
      ahead: [],
    });
    expect(await rootstockMigrationStatus(sql, slice)).toEqual({
      schema: slice.schema,
      schemaExists: true,
      tracked: true,
      applied: [FILE],
      pending: [],
      ahead: [],
      tampered: [],
      red: false,
    });
    const row = await one<{ sha256: string; stamped: boolean }>(
      `select sha256, applied_at is not null as stamped from "${slice.schema}".schema_migrations`,
    );
    expect(row).toEqual({ sha256: SHIPPED[0]?.sha256 ?? "", stamped: true });
  });

  test("re-run applies nothing and writes nothing", async () => {
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    await applyMigrationList(main.transactor, slice, SHIPPED);
    const again = await applyMigrationList(main.transactor, slice, SHIPPED);
    expect(again).toEqual({
      schema: slice.schema,
      schemaCreated: false,
      applied: [],
      alreadyApplied: 1,
      ahead: [],
    });
    expect(await rowsOf(slice.schema)).toHaveLength(1);
  });

  test("parallel-isolation: two schemas on two backends each hold only their own row", async () => {
    const second = openSecond();
    try {
      const a = migrateSlice({ schema: schema(), ahead: "refuse" });
      const b = migrateSlice({ schema: schema(), ahead: "refuse" });
      const [ra, rb] = await Promise.all([
        applyMigrationList(main.transactor, a, SHIPPED),
        applyMigrationList(second.transactor, b, SHIPPED),
      ]);
      expect(ra.applied).toEqual([FILE]);
      expect(rb.applied).toEqual([FILE]);
      expect((await rowsOf(a.schema)).map((r) => r.filename)).toEqual([FILE]);
      expect((await rowsOf(b.schema)).map((r) => r.filename)).toEqual([FILE]);
      for (const s of [sql, second.transactor.sql]) {
        const [row] = await s<{ seen: boolean }>`
          select to_regclass('schema_migrations') is not null as "seen"`;
        expect(row?.seen).toBe(false);
      }
    } finally {
      await second.close();
    }
  });

  test("concurrent-same-schema: two applies serialize, one applies and one finds it done", async () => {
    const second = openSecond();
    try {
      let failures = 0;
      for (let i = 0; i < 50; i++) {
        const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
        const settled = await Promise.allSettled([
          applyMigrationList(main.transactor, slice, SHIPPED),
          applyMigrationList(second.transactor, slice, SHIPPED),
        ]);
        const reports = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        const ok =
          reports.length === 2 &&
          reports.filter((r) => r.applied.length === 1 && r.applied[0] === FILE).length === 1 &&
          reports.filter((r) => r.applied.length === 0 && r.alreadyApplied === 1).length === 1;
        if (!ok) failures++;
      }
      expect(failures).toBe(0);
    } finally {
      await second.close();
    }
  });

  test("kill-mid-run-converges: a failing statement leaves no schema and no row", async () => {
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    const err = await applyMigrationList(main.transactor, slice, [...SHIPPED, BROKEN]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(sqlstate(err)).toBe("22012");
    expect(await exists(slice.schema)).toBe(false);
    const report = await applyMigrationList(main.transactor, slice, SHIPPED);
    expect(report.applied).toEqual([FILE]);
    expect((await rowsOf(slice.schema)).map((r) => r.filename)).toEqual([FILE]);
  });

  test("tampered-refused: a changed sha refuses and writes nothing", async () => {
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    await applyMigrationList(main.transactor, slice, SHIPPED);
    const zeros = "0".repeat(64);
    await sql.unsafe(`update "${slice.schema}".schema_migrations set sha256 = $1`, [zeros]);
    const message = await refusal(applyMigrationList(main.transactor, slice, [...SHIPPED, EXTRA]));
    expect(message).toBe(
      `applyRootstockMigrations: ${slice.schema}.schema_migrations records ${FILE} with sha256 ${zeros}, but this package ships ${SHIPPED[0]?.sha256} — an applied migration changed after it ran; refusing, and re-running will not fix this`,
    );
    expect(await rowsOf(slice.schema)).toEqual([{ filename: FILE, sha256: zeros }]);
    const status = await rootstockMigrationStatus(sql, slice);
    expect(status.tampered).toEqual([
      { filename: FILE, recorded: zeros, shipped: SHIPPED[0]?.sha256 ?? "" },
    ]);
    expect(status.red).toBe(true);
  });

  test("ahead-refuse: an unshipped applied row refuses, or is reported under allow", async () => {
    const name = schema();
    const refuse = migrateSlice({ schema: name, ahead: "refuse" });
    const allow = migrateSlice({ schema: name, ahead: "allow" });
    await applyMigrationList(main.transactor, refuse, SHIPPED);
    await sql.unsafe(`insert into "${name}".schema_migrations (filename, sha256) values ($1, $2)`, [
      FUTURE,
      "a".repeat(64),
    ]);
    expect(await refusal(applyMigrationList(main.transactor, refuse, SHIPPED))).toBe(
      `applyRootstockMigrations: schema "${name}" has applied ${FUTURE}, which this package does not ship — the database is ahead of this rootstock version; upgrade rootstock, or set ahead: "allow" in the migrate slice`,
    );
    expect(await applyMigrationList(main.transactor, allow, SHIPPED)).toEqual({
      schema: name,
      schemaCreated: false,
      applied: [],
      alreadyApplied: 1,
      ahead: [FUTURE],
    });
    expect((await rootstockMigrationStatus(sql, refuse)).red).toBe(true);
    expect((await rootstockMigrationStatus(sql, allow)).red).toBe(false);
    for (const slice of [refuse, allow]) {
      expect(await refusal(applyMigrationList(main.transactor, slice, [...SHIPPED, EXTRA]))).toBe(
        `applyRootstockMigrations: schema "${name}" has applied ${FUTURE}, which this package does not ship, and is missing ${EXTRA.filename} — the database and this package have diverged; refusing`,
      );
    }
    expect(await rowsOf(name)).toHaveLength(2);
  });

  test("heavy: refused without allowHeavy, applied with it", async () => {
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    expect(await refusal(applyMigrationList(main.transactor, slice, [...SHIPPED, HEAVY]))).toBe(
      `applyRootstockMigrations: pending migration(s) marked heavy: ${HEAVY.filename} — apply them deliberately with { allowHeavy: true }, then re-run`,
    );
    expect(await exists(slice.schema)).toBe(false);
    const report = await applyMigrationList(main.transactor, slice, [...SHIPPED, HEAVY], {
      allowHeavy: true,
    });
    expect(report.applied).toEqual([FILE, HEAVY.filename]);
    const row = await one<{ n: number }>(
      `select count(*)::int as n from "${slice.schema}".heavy_t`,
    );
    expect(row?.n).toBe(1);
  });

  describe("privileges", () => {
    beforeAll(async () => {
      for (const role of ["rs_owner", "rs_app"]) {
        const found = await one("select 1 from pg_roles where rolname = $1::text", [role]);
        if (found === undefined) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
      }
      const db = await one<{ name: string }>("select current_database()::text as name");
      // A no-op by default (PUBLIC holds no database CREATE), kept as the precondition.
      await sql.unsafe(`REVOKE CREATE ON DATABASE "${db?.name}" FROM PUBLIC`);
    });

    async function asApp<T>(fn: () => Promise<T>): Promise<T> {
      await sql.unsafe("SET ROLE rs_app");
      try {
        return await fn();
      } finally {
        await sql.unsafe("RESET ROLE");
      }
    }

    test("no database CREATE and no schema: refused with the remedy", async () => {
      const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
      const message = await asApp(() =>
        refusal(applyMigrationList(main.transactor, slice, SHIPPED)),
      );
      expect(message).toBe(
        `applyRootstockMigrations: schema "${slice.schema}" does not exist and role "rs_app" cannot create it (no CREATE on this database) — have a superuser or a member of that role run CREATE SCHEMA "${slice.schema}" AUTHORIZATION "rs_app", then re-run`,
      );
    });

    test("pre-created-schema: applies without database CREATE", async () => {
      const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
      await sql.unsafe(`CREATE SCHEMA "${slice.schema}" AUTHORIZATION rs_app`);
      const report = await asApp(() => applyMigrationList(main.transactor, slice, SHIPPED));
      expect(report).toMatchObject({ schemaCreated: false, applied: [FILE] });
    });

    test("a schema without USAGE or CREATE names what is missing", async () => {
      const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
      const s = slice.schema;
      await sql.unsafe(`CREATE SCHEMA "${s}" AUTHORIZATION rs_owner`);
      expect(await asApp(() => refusal(applyMigrationList(main.transactor, slice, SHIPPED)))).toBe(
        `applyRootstockMigrations: role "rs_app" lacks USAGE and CREATE on schema "${s}" — run GRANT USAGE, CREATE ON SCHEMA "${s}" TO "rs_app" as its owner, then re-run`,
      );
      await sql.unsafe(`GRANT USAGE ON SCHEMA "${s}" TO rs_app`);
      expect(await asApp(() => refusal(applyMigrationList(main.transactor, slice, SHIPPED)))).toBe(
        `applyRootstockMigrations: role "rs_app" lacks CREATE on schema "${s}" — run GRANT CREATE ON SCHEMA "${s}" TO "rs_app" as its owner, then re-run`,
      );
      expect(await rootstockMigrationStatus(sql, slice)).toMatchObject({ tracked: false });
    });
  });

  test("a public.schema_migrations of another shape is untouched and ignored", async () => {
    await sql.unsafe(
      "CREATE TABLE IF NOT EXISTS public.schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await sql.unsafe(
      "INSERT INTO public.schema_migrations (filename) VALUES ('0000_init.sql'), ('0001_more.sql') ON CONFLICT DO NOTHING",
    );
    const snapshot = () =>
      sql.unsafe(
        "select filename, applied_at::text as at from public.schema_migrations order by 1",
      );
    const before = await snapshot();
    made.push("rootstock");
    const slice = migrateSlice({ ahead: "refuse" });
    expect(slice.schema).toBe("rootstock");
    try {
      expect((await applyMigrationList(main.transactor, slice, SHIPPED)).applied).toEqual([FILE]);
      expect(await snapshot()).toEqual(before);
      const status = await rootstockMigrationStatus(sql, slice);
      expect(status).toMatchObject({ applied: [FILE], ahead: [], red: false });
    } finally {
      await sql.unsafe("DROP TABLE public.schema_migrations");
    }
  });

  test("search-path-restored: the same session's search_path is unchanged after commit", async () => {
    const [before] = await sql<{ search_path: string }>`show search_path`;
    const slice = migrateSlice({ schema: schema(), ahead: "refuse" });
    expect((await applyMigrationList(main.transactor, slice, SHIPPED)).applied).toEqual([FILE]);
    const [after] = await sql<{ search_path: string }>`show search_path`;
    expect(after).toEqual(before);
    expect(before?.search_path).not.toContain(slice.schema);
  });
});
