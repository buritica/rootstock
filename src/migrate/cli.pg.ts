import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import type { MigrateEvent } from "./applier.ts";
import { rootstockSource } from "./apply.ts";
import { migrateCli } from "./cli.ts";
import { mig, schemaFactory } from "./fixtures.pg-support.ts";
import { type MigrateSlice, migrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import { drizzleTracker, type TrackedSource } from "./tracked.ts";

// migrateCli's exit codes against a real Postgres, once per transactor kind
// (contract §1.8): 0, 1 and 2 for status, plan and apply. Every case owns its
// schemas (`rs_c_<hex>`) and drops them when the suite ends.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_c");

interface World {
  slice: MigrateSlice;
  d: string;
}

function world(): World {
  return { slice: migrateSlice({ schema: schema() }), d: schema() };
}

function sources(w: World, files?: SourceMigration[]): TrackedSource[] {
  return [
    rootstockSource(w.slice),
    {
      name: "app",
      tracker: drizzleTracker({ schema: w.d }),
      migrations: files ?? [
        mig("app", "0000_a", "1700000000000", `CREATE TABLE "${w.d}".a (x int)`),
      ],
    },
  ];
}

async function run(
  argv: string[],
  w: World,
  files?: SourceMigration[],
  transactor = main.transactor,
): Promise<{ code: 0 | 1 | 2; lines: string[] }> {
  const lines: string[] = [];
  const code = await migrateCli(argv, {
    onEvent: (e) => events.push(e),
    transactor,
    slice: w.slice,
    sources: sources(w, files),
    backup: { skip: "test" },
    fix: "bun run migrate apply --manual",
    out: (l) => lines.push(l),
  });
  return { code, lines };
}

/** Every event any run emitted, in order: proves onEvent passes through. */
const events: MigrateEvent[] = [];

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

describe("migrateCli", () => {
  test("a fresh database: status 1, plan 0 and writes nothing, apply 0, then status 0", async () => {
    const w = world();
    const before = await run(["status"], w);
    expect(before.code).toBe(1);
    expect(before.lines.at(-1)).toBe("fix: bun run migrate apply --manual");

    const plan = await run(["plan", "--deploy"], w);
    expect(plan).toEqual({
      code: 0,
      lines: [
        `plan (deploy): apply rootstock/${sources(w)[0]?.migrations[0]?.id} (additive), app/0000_a (additive)`,
      ],
    });
    expect((await run(["status"], w)).code).toBe(1);

    events.length = 0;
    const apply = await run(["apply", "--deploy"], w);
    expect(apply.code).toBe(0);
    expect(apply.lines).toHaveLength(2);
    expect(apply.lines[0]).toMatch(
      /^applied: rootstock\/[^ ]+ \(\d+ ms\), app\/0000_a \(\d+ ms\)$/,
    );
    expect(apply.lines[1]).toBe(`trackers created: ${w.d}.__drizzle_migrations`);
    expect(events.map((e) => e.type)).toContain("migrate.done");

    expect(await run(["status"], w)).toEqual({
      code: 0,
      lines: ["rootstock: ok (1 applied)", "app: ok (1 applied)"],
    });
    expect(await run(["apply", "--manual"], w)).toEqual({ code: 0, lines: ["applied: nothing"] });
  });

  test("a refusal: plan 1 and apply 1, each printing it; status 1", async () => {
    const w = world();
    const heavy = [
      mig("app", "0000_h", "1700000000000", `CREATE TABLE "${w.d}".h (x int)`, "heavy"),
    ];
    const plan = await run(["plan", "--deploy"], w, heavy);
    expect(plan).toEqual({
      code: 1,
      lines: [
        "rootstock migrate: deploy refuses pending migration(s) that are heavy or unmarked: app/0000_h (heavy) — apply them by hand (bun run migrate apply --manual), then redeploy",
      ],
    });
    const apply = await run(["apply", "--deploy"], w, heavy);
    expect(apply.code).toBe(1);
    expect(apply.lines).toEqual(plan.lines);
    expect(await run(["apply", "--manual"], w, heavy)).toEqual({
      code: 1,
      lines: [
        "rootstock migrate: pending migration(s) marked heavy or unmarked: app/0000_h — re-run with --allow-heavy to apply them deliberately",
      ],
    });
    const manual = await run(["apply", "--allow-heavy", "--manual"], w, heavy);
    expect(manual.code).toBe(0);
    // A rolled-back checkout: ahead. A deploy plan reports it, a manual one refuses.
    const back = await run(["plan"], w, []);
    expect(back.code).toBe(1);
    expect((await run(["plan", "--deploy"], w, [])).code).toBe(0);
    expect((await run(["status"], w, [])).code).toBe(1);
  });

  test("could not answer: status 2 and plan 2, while apply's preflight refuses with 1", async () => {
    for (const role of ["rs_owner", "rs_app"]) {
      const [found] = await sql.unsafe<{ x: number }>(
        "select 1 as x from pg_roles where rolname = $1::text",
        [role],
      );
      if (found === undefined) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    }
    const w = world();
    await sql.unsafe(`CREATE SCHEMA "${w.d}" AUTHORIZATION rs_owner`);
    // A second transactor (one backend, max 1) whose session runs as a role
    // without USAGE on the tracker's schema.
    const denied = openSecond();
    try {
      await denied.transactor.sql.unsafe("SET ROLE rs_app");
      const status = await run(["status"], w, undefined, denied.transactor);
      expect(status.code).toBe(2);
      expect(status.lines[0]).toStartWith("status could not answer — ");
      const plan = await run(["plan", "--deploy"], w, undefined, denied.transactor);
      expect(plan.code).toBe(2);
      expect(plan.lines[0]).toStartWith("plan could not answer — ");
      // The applier's preflight names the missing grant: a refusal, so 1.
      expect((await run(["apply", "--deploy"], w, undefined, denied.transactor)).code).toBe(1);
    } finally {
      await denied.close();
    }
  });

  test("apply rethrows a failure that is not a refusal: the process crashes with its stack", async () => {
    const w = world();
    const bad = [mig("app", "0000_bad", "1700000000000", "SELECT 1/0")];
    await expect(run(["apply", "--deploy"], w, bad)).rejects.toThrow(
      "rootstock migrate: app/0000_bad failed and was rolled back",
    );
    // plan never runs a file, so the same checkout plans green.
    expect((await run(["plan", "--deploy"], w, bad)).code).toBe(0);
  });
});
