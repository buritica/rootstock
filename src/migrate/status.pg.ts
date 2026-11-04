import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgCode, type Sql } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { sha256Hex } from "../hash/index.ts";
import { applyMigrations } from "./applier.ts";
import { rootstockSource } from "./apply.ts";
import { mig, schemaFactory } from "./fixtures.pg-support.ts";
import { type MigrateSlice, migrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import { migrationStatus, renderMigrationStatus } from "./status.ts";
import { drizzleTracker, filenameTracker, type TrackedSource } from "./tracked.ts";

// migrationStatus against a real Postgres, once per transactor kind. Every
// case owns its schemas (`rs_s_<hex>`) and drops them when the suite ends.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_s");

interface World {
  slice: MigrateSlice;
  d: string;
  f: string;
}

function world(accepted: MigrateSlice["accepted"] = []): World {
  return { slice: migrateSlice({ schema: schema(), accepted }), d: schema(), f: schema() };
}

const textA = (w: World): string => `CREATE TABLE "${w.d}".a (x int)`;
const textB = (w: World): string => `CREATE TABLE "${w.d}".b (x int)`;
const textU = (w: World): string => `CREATE TABLE "${w.f}".u (x int)`;

function sources(
  w: World,
  app: SourceMigration[] = [
    mig("app", "0000_a", "1700000000000", textA(w)),
    mig("app", "0001_b", "1700000000001", textB(w)),
  ],
  auth: SourceMigration[] = [mig("auth", "20260101000000_u.sql", "20260101000000_u.sql", textU(w))],
): TrackedSource[] {
  return [
    rootstockSource(w.slice),
    { name: "app", tracker: drizzleTracker({ schema: w.d }), migrations: app },
    { name: "auth", tracker: filenameTracker({ schema: w.f }), migrations: auth },
  ];
}

async function applied(w: World): Promise<void> {
  await applyMigrations(main.transactor, w.slice, sources(w), {
    entry: "deploy",
    backup: { skip: "test" },
    fix: "x",
  });
}

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

describe("migrationStatus", () => {
  test("fresh: every source untracked and behind; applied: ok", async () => {
    const w = world();
    const before = await migrationStatus(sql, w.slice, sources(w));
    expect(before.sources.map((s) => [s.source, s.tracked, s.pending.length])).toEqual([
      ["rootstock", false, 1],
      ["app", false, 2],
      ["auth", false, 1],
    ]);
    expect(before).toMatchObject({ behind: true, ahead: false, red: true, trackerRot: false });
    expect(renderMigrationStatus(before, { fix: "bun run migrate" })).toEndWith(
      "\nfix: bun run migrate\n",
    );
    await applied(w);
    const after = await migrationStatus(sql, w.slice, sources(w));
    expect(after.red).toBe(false);
    expect(renderMigrationStatus(after, { fix: "bun run migrate" })).toBe(
      "rootstock: ok (1 applied)\napp: ok (2 applied)\nauth: ok (1 applied)\n",
    );
  });

  test("out of order: a pending file older than the newest applied is named, and behind", async () => {
    const w = world();
    await applied(w);
    const late = mig("app", "0002_late", "1699999999999", `CREATE TABLE "${w.d}".late (x int)`);
    const [, app] = sources(w);
    const status = await migrationStatus(
      sql,
      w.slice,
      sources(w, [...(app?.migrations ?? []), late]),
    );
    expect(status.sources[1]).toMatchObject({ outOfOrder: ["0002_late"] });
    expect(status.behind).toBe(true);
  });

  test("ahead: a row with no file is red, with the deploy remedy", async () => {
    const w = world();
    await applied(w);
    const [, app] = sources(w);
    const status = await migrationStatus(sql, w.slice, sources(w, app?.migrations.slice(0, 1)));
    expect(status).toMatchObject({ ahead: true, behind: false, red: true });
    expect(renderMigrationStatus(status, { fix: "f" }).split("\n").slice(1, 2)).toEqual([
      "app: ahead: 1700000000001",
    ]);
  });

  test("accepted: covers the exact pair, an edit after it is tampered, a wrong pair is stale", async () => {
    const base = world();
    await applied(base);
    const recorded = sha256Hex(textA(base));
    const edited = mig("app", "0000_a", "1700000000000", `${textA(base)} -- comment`);
    const again = mig("app", "0000_a", "1700000000000", `${textA(base)} -- again`);
    const fileB = mig("app", "0001_b", "1700000000001", textB(base));
    const read = (w: World, a: SourceMigration) =>
      migrationStatus(sql, w.slice, sources({ ...base, slice: w.slice }, [a, fileB]));

    const plain = await read(base, edited);
    expect(plain.sources[1]?.tampered).toEqual([
      { id: "0000_a", recorded, current: edited.sha256 },
    ]);

    const entry = { source: "app", id: "0000_a", recorded, current: edited.sha256, reason: "r" };
    const ok = { ...base, slice: migrateSlice({ schema: base.slice.schema, accepted: [entry] }) };
    const covered = await read(ok, edited);
    expect(covered).toMatchObject({ tampered: false, trackerRot: false, red: false });
    expect(covered.sources[1]?.tampered).toEqual([]);
    expect(covered.sources[1]?.accepted).toEqual([
      { id: "0000_a", recorded, current: edited.sha256, reason: "r", stale: false },
    ]);

    const editedAgain = await read(ok, again);
    expect(editedAgain.sources[1]?.tampered).toEqual([
      { id: "0000_a", recorded, current: again.sha256, acceptedCurrent: edited.sha256 },
    ]);
    expect(editedAgain.red).toBe(true);

    const wrong = { ...entry, recorded: sha256Hex("not the row") };
    const st = { ...base, slice: migrateSlice({ schema: base.slice.schema, accepted: [wrong] }) };
    const stale = await read(st, edited);
    expect(stale).toMatchObject({ trackerRot: true, red: true });
    expect(renderMigrationStatus(stale, { fix: "f" })).toContain("accepted: 0000_a (r) STALE");
  });

  test.each([
    ["unknown", (_w: World) => "('h', null)"],
    // The second row carries 0001_b's own hash, so only the duplicate shows.
    ["duplicate", (w: World) => `('${sha256Hex(textB(w))}', 1700000000001)`],
  ])("a %s drizzle row is tracker rot, on its own", async (what, values) => {
    const w = world();
    await applied(w);
    await sql.unsafe(
      `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ${values(w)}`,
    );
    const status = await migrationStatus(sql, w.slice, sources(w));
    const app = status.sources[1];
    expect(status).toMatchObject({ trackerRot: true, red: true, behind: false, ahead: false });
    const line = renderMigrationStatus(status, { fix: "f" }).split("\n")[1];
    if (what === "unknown") {
      expect(app?.unknown).toHaveLength(1);
      expect(app?.duplicate).toEqual([]);
      expect(line).toBe(`app: unknown rows: ${app?.unknown[0]?.rowId}`);
    } else {
      expect(app?.unknown).toEqual([]);
      expect(app?.duplicate).toEqual(["1700000000001"]);
      expect(line).toBe("app: duplicate keys: 1700000000001");
    }
  });

  test("unhashed: an older filename tracker reads, and says its hashes are not stamped", async () => {
    const w = world();
    await sql.unsafe(`CREATE SCHEMA "${w.f}"`);
    await sql.unsafe(
      `CREATE TABLE "${w.f}".schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await sql.unsafe(
      `INSERT INTO "${w.f}".schema_migrations (filename) VALUES ('20260101000000_u.sql')`,
    );
    const status = await migrationStatus(sql, w.slice, sources(w));
    expect(status.sources[2]).toMatchObject({
      hashTracking: false,
      unhashed: ["20260101000000_u.sql"],
      pending: [],
      tampered: [],
    });
    expect(renderMigrationStatus(status, { fix: "f" })).toContain(
      "auth: ok (1 applied); hashes not yet stamped: 1",
    );
  });

  test("an acceptance is not stale on a database that applied the edited file", async () => {
    const w = world();
    const edited = mig("app", "0000_a", "1700000000000", `${textA(w)} -- comment`);
    const fileB = mig("app", "0001_b", "1700000000001", textB(w));
    const entry = {
      source: "app",
      id: "0000_a",
      recorded: sha256Hex(textA(w)),
      current: edited.sha256,
      reason: "r",
    };
    const slice = migrateSlice({ schema: w.slice.schema, accepted: [entry] });
    const own = sources({ ...w, slice }, [edited, fileB]);
    // Before the apply the file is pending, after it the row holds today's hash.
    expect((await migrationStatus(sql, slice, own)).trackerRot).toBe(false);
    await applyMigrations(main.transactor, slice, own, {
      entry: "deploy",
      backup: { skip: "test" },
      fix: "x",
    });
    const status = await migrationStatus(sql, slice, own);
    expect(status).toMatchObject({ red: false, trackerRot: false });
    expect(status.sources[1]?.accepted[0]?.stale).toBe(false);
  });

  test("a role without USAGE on a tracker's schema gets the driver's 42501, uncoded", async () => {
    for (const role of ["rs_owner", "rs_app"]) {
      const [found] = await sql.unsafe<{ x: number }>(
        "select 1 as x from pg_roles where rolname = $1::text",
        [role],
      );
      if (found === undefined) await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    }
    const w = world();
    await sql.unsafe(`CREATE SCHEMA "${w.d}" AUTHORIZATION rs_owner`);
    // One transaction, so the role and the reads share a connection.
    const err = await main.transactor
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rs_app");
        return migrationStatus(tx as unknown as Sql, w.slice, sources(w));
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(pgCode(err)).toBe("42501");
    expect(String((err as { code?: unknown }).code)).not.toMatch(/^ERR_ROOTSTOCK_MIG_/);
  });
});
