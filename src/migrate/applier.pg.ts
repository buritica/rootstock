import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgCode, type Sql, type Transactor } from "../db/index.ts";
import {
  openPooled,
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { sha256Hex } from "../hash/index.ts";
import {
  type ApplyOptions,
  type ApplyResult,
  applyMigrations,
  type MigrateEvent,
} from "./applier.ts";
import { rootstockSource } from "./apply.ts";
import type { MigrationKind } from "./marker.ts";
import { type MigrateSlice, migrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import { drizzleTracker, filenameTracker, type TrackedSource } from "./tracked.ts";

// applyMigrations against a real Postgres, once per transactor kind. Every
// case owns its schemas (`rs_a_<hex>`: the rootstock slice, the drizzle
// tracker's schema, the filename tracker's schema and the app's tables) and
// drops them when the suite ends.

let main: TestTransactor;
let sql: Sql;
const made: string[] = [];

function schema(): string {
  const s = `rs_a_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  made.push(s);
  return s;
}

interface World {
  slice: MigrateSlice;
  /** The drizzle source's tracker schema, which also holds its tables. */
  d: string;
  /** The filename source's tracker schema, which also holds its tables. */
  f: string;
}

function world(): World {
  return { slice: migrateSlice({ schema: schema() }), d: schema(), f: schema() };
}

function mig(
  source: string,
  id: string,
  key: string,
  text: string,
  kind: MigrationKind | null = "additive",
  baselined = false,
): SourceMigration {
  return Object.freeze({
    source,
    id,
    key,
    sha256: sha256Hex(text),
    kind,
    baselined,
    statements: Object.freeze(text.split("--> statement-breakpoint")),
  });
}

function drizzleSource(w: World, migrations: SourceMigration[]): TrackedSource {
  return { name: "app", tracker: drizzleTracker({ schema: w.d }), migrations };
}

function folderSource(w: World, migrations: SourceMigration[]): TrackedSource {
  return { name: "auth", tracker: filenameTracker({ schema: w.f }), migrations };
}

/** Two drizzle files and one folder file, all additive, none idempotent. */
function appSources(w: World): TrackedSource[] {
  return [
    rootstockSource(w.slice),
    drizzleSource(w, [
      mig("app", "0000_a", "1700000000000", `CREATE TABLE "${w.d}".a (x int)`),
      mig(
        "app",
        "0001_b",
        "1700000000001",
        `CREATE TABLE "${w.d}".b (x int);\n--> statement-breakpoint\nINSERT INTO "${w.d}".b VALUES (1);`,
      ),
    ]),
    folderSource(w, [
      mig(
        "auth",
        "20260101000000_u.sql",
        "20260101000000_u.sql",
        `CREATE TABLE "${w.f}".u (x int)`,
      ),
    ]),
  ];
}

function opts(extra: Partial<ApplyOptions> = {}): ApplyOptions {
  return { entry: "deploy", backup: { skip: "test" }, fix: "bun run migrate --manual", ...extra };
}

async function one<T>(query: string, params?: unknown[]): Promise<T | undefined> {
  return (await sql.unsafe<T>(query, params))[0];
}

async function drizzleRows(w: World): Promise<{ created_at: string; hash: string }[]> {
  return sql.unsafe(
    `select created_at::text as created_at, hash from "${w.d}".__drizzle_migrations order by id`,
  );
}

async function folderRows(w: World): Promise<string[]> {
  const rows = await sql.unsafe<{ filename: string }>(
    `select filename from "${w.f}".schema_migrations order by filename`,
  );
  return rows.map((r) => r.filename);
}

async function rootstockRows(w: World): Promise<number> {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from "${w.slice.schema}".schema_migrations`,
  );
  return row?.n ?? 0;
}

async function rejected(p: Promise<unknown>): Promise<{ message: string; code: unknown }> {
  try {
    await p;
  } catch (err) {
    return { message: (err as Error).message, code: (err as { code?: unknown }).code };
  }
  throw new Error("expected a refusal");
}

function recorder(): { events: MigrateEvent[]; onEvent: (e: MigrateEvent) => void } {
  const events: MigrateEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  if (made.length > 0) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${made.map((s) => `"${s}"`).join(", ")} CASCADE`);
  }
  await main.close();
});

describe("applyMigrations", () => {
  test("fresh database: creates every tracker, applies in source order, emits in order", async () => {
    const w = world();
    const sources = appSources(w);
    const { events, onEvent } = recorder();
    const result = await applyMigrations(main.transactor, w.slice, sources, opts({ onEvent }));

    expect(result.plan.apply.map((a) => `${a.source}/${a.id}`)).toEqual([
      "rootstock/20261020000000_schema_migrations.sql",
      "app/0000_a",
      "app/0001_b",
      "auth/20260101000000_u.sql",
    ]);
    expect(result.applied.map((a) => a.id)).toEqual(result.plan.apply.map((a) => a.id));
    expect(result.skippedConcurrent).toEqual([]);
    expect(result.bootstrap).toEqual({
      created: [`${w.d}.__drizzle_migrations`, `${w.f}.schema_migrations`],
      upgraded: [],
      stamped: 0,
    });
    expect(events.map((e): string => e.type)).toEqual([
      "migrate.tracker_created",
      "migrate.tracker_created",
      "migrate.plan",
      "migrate.backup_skipped",
      ...result.plan.apply.flatMap(() => ["migrate.applying", "migrate.applied"]),
      "migrate.done",
    ]);
    expect(events.at(-1)).toEqual({
      type: "migrate.done",
      applied: 4,
      skippedConcurrent: 0,
      ahead: 0,
    });
    // drizzle's own row shape: its `when` as created_at, its hash.
    expect(await drizzleRows(w)).toEqual(
      (sources[1]?.migrations ?? []).map((m) => ({ created_at: m.key, hash: m.sha256 })),
    );
    expect(await folderRows(w)).toEqual(["20260101000000_u.sql"]);
    expect(await rootstockRows(w)).toBe(1);
    // Events carry ids, never SQL.
    expect(JSON.stringify(events)).not.toContain("CREATE");
  });

  test("re-run: plans nothing, writes nothing, skips the backup", async () => {
    const w = world();
    await applyMigrations(main.transactor, w.slice, appSources(w), opts());
    let ran = false;
    const { events, onEvent } = recorder();
    const again = await applyMigrations(
      main.transactor,
      w.slice,
      appSources(w),
      opts({
        backup: {
          run: async () => {
            ran = true;
          },
        },
        onEvent,
      }),
    );
    expect(again.plan.apply).toEqual([]);
    expect(again.applied).toEqual([]);
    expect(ran).toBe(false);
    expect(events.map((e): string => e.type)).toEqual(["migrate.plan", "migrate.done"]);
    expect(await drizzleRows(w)).toHaveLength(2);
  });

  test("planOnly: plans a fresh database and writes nothing, not even the schema", async () => {
    const w = world();
    const result = await applyMigrations(
      main.transactor,
      w.slice,
      appSources(w),
      opts({ planOnly: true }),
    );
    expect(result.plan.apply).toHaveLength(4);
    expect(result.applied).toEqual([]);
    for (const s of [w.slice.schema, w.d, w.f]) {
      const row = await one<{ e: boolean }>("select to_regnamespace($1::text) is not null as e", [
        s,
      ]);
      expect(row?.e).toBe(false);
    }
  });

  test("a hook that throws changes nothing", async () => {
    const w = world();
    const result = await applyMigrations(
      main.transactor,
      w.slice,
      appSources(w),
      opts({
        onEvent: () => {
          throw new Error("hook");
        },
      }),
    );
    expect(result.applied).toHaveLength(4);
  });

  test("$1 inside a $$ body runs as text, through this driver", async () => {
    const w = world();
    const fn = mig(
      "app",
      "0000_fn",
      "1700000000000",
      `CREATE FUNCTION "${w.d}".twice(int) RETURNS int LANGUAGE sql AS $$ SELECT $1 * 2 $$;\n--> statement-breakpoint\nCREATE TABLE "${w.d}".t (note text DEFAULT '$1');`,
    );
    await applyMigrations(
      main.transactor,
      w.slice,
      [rootstockSource(w.slice), drizzleSource(w, [fn])],
      opts(),
    );
    const row = await one<{ v: number }>(`select "${w.d}".twice(21) as v`);
    expect(row?.v).toBe(42);
    await sql.unsafe(`insert into "${w.d}".t default values`);
    expect(await one<{ note: string }>(`select note from "${w.d}".t`)).toEqual({ note: "$1" });
  });

  test("entry deploy refuses heavy and unmarked files, naming each and the fix", async () => {
    const w = world();
    const sources = [
      rootstockSource(w.slice),
      drizzleSource(w, [
        mig("app", "0000_old", "1700000000000", `CREATE TABLE "${w.d}".o (x int)`, null, true),
        mig("app", "0001_h", "1700000000001", `CREATE TABLE "${w.d}".h (x int)`, "heavy"),
        mig("app", "0002_u", "1700000000002", `CREATE TABLE "${w.d}".n (x int)`, null),
      ]),
    ];
    const { events, onEvent } = recorder();
    const err = await rejected(
      applyMigrations(main.transactor, w.slice, sources, opts({ onEvent })),
    );
    expect(err).toEqual({
      message:
        "rootstock migrate: deploy refuses pending migration(s) that are heavy or unmarked: app/0000_old (unmarked (baselined)), app/0001_h (heavy), app/0002_u (unmarked) — apply them by hand (bun run migrate --manual), then redeploy",
      code: "ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY",
    });
    expect(events.at(-1)).toEqual({
      type: "migrate.refused",
      code: "ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY",
    });
    expect(await drizzleRows(w)).toEqual([]);
    // manual takes the baselined file, refuses the other two without allowHeavy, takes all with it.
    expect(
      (
        await rejected(
          applyMigrations(main.transactor, w.slice, sources, opts({ entry: "manual" })),
        )
      ).code,
    ).toBe("ERR_ROOTSTOCK_MIG_HEAVY_SRC");
    const done = await applyMigrations(
      main.transactor,
      w.slice,
      sources,
      opts({ entry: "manual", allowHeavy: true }),
    );
    expect(done.applied.map((a) => a.id)).toContain("0002_u");
  });

  test("a backup that throws stops the run before any file", async () => {
    const w = world();
    const err = await rejected(
      applyMigrations(
        main.transactor,
        w.slice,
        appSources(w),
        opts({
          backup: {
            run: async () => {
              throw new Error("disk full");
            },
          },
        }),
      ),
    );
    expect(err.code).toBe("ERR_ROOTSTOCK_MIG_BACKUP");
    expect(await drizzleRows(w)).toEqual([]);
    // Kill point 1: the bootstrap committed, no file ran; a re-run is clean.
    const again = await applyMigrations(main.transactor, w.slice, appSources(w), opts());
    expect(again.applied).toHaveLength(4);
    expect(again.bootstrap.created).toEqual([]);
  });

  test("ahead: deploy reports it, manual refuses it, and a rollback-then-hotfix deploy applies", async () => {
    const w = world();
    await applyMigrations(main.transactor, w.slice, appSources(w), opts());
    const [root, app, auth] = appSources(w);
    if (root === undefined || app === undefined || auth === undefined) throw new Error("fixture");
    // A rolled-back deploy: the checkout no longer has 0001_b.
    const rolledBack = [root, { ...app, migrations: app.migrations.slice(0, 1) }, auth];
    const { events, onEvent } = recorder();
    const result = await applyMigrations(main.transactor, w.slice, rolledBack, opts({ onEvent }));
    expect(result.plan.ahead).toEqual([{ source: "app", id: "1700000000001" }]);
    expect(events).toContainEqual({ type: "migrate.ahead", source: "app", id: "1700000000001" });

    const manual = await rejected(
      applyMigrations(main.transactor, w.slice, rolledBack, opts({ entry: "manual" })),
    );
    expect(manual.code).toBe("ERR_ROOTSTOCK_MIG_AHEAD_SRC");

    const hotfix = [
      root,
      {
        ...app,
        migrations: [
          ...app.migrations.slice(0, 1),
          mig("app", "0002_fix", "1700000000002", `CREATE TABLE "${w.d}".fix (x int)`),
        ],
      },
      auth,
    ];
    // Ahead plus pending in an app source is not diverged (B2): the deploy
    // applies the hotfix and reports the rolled-back row.
    const fixed = await applyMigrations(main.transactor, w.slice, hotfix, opts());
    expect(fixed.applied.map((a) => a.id)).toEqual(["0002_fix"]);
    expect(fixed.plan.ahead).toEqual([{ source: "app", id: "1700000000001" }]);
    expect(
      (await rejected(applyMigrations(main.transactor, w.slice, hotfix, opts({ entry: "manual" }))))
        .code,
    ).toBe("ERR_ROOTSTOCK_MIG_AHEAD_SRC");
  });

  test("tampered: refused unless the slice accepts exactly that pair", async () => {
    const w = world();
    await applyMigrations(main.transactor, w.slice, appSources(w), opts());
    const [root, app, auth] = appSources(w);
    if (root === undefined || app === undefined || auth === undefined) throw new Error("fixture");
    const edited = mig(
      "app",
      "0000_a",
      "1700000000000",
      `CREATE TABLE "${w.d}".a (x int) -- edited`,
    );
    const sources = [root, { ...app, migrations: [edited, ...app.migrations.slice(1)] }, auth];
    const recorded = app.migrations[0]?.sha256 ?? "";
    expect((await rejected(applyMigrations(main.transactor, w.slice, sources, opts()))).code).toBe(
      "ERR_ROOTSTOCK_MIG_TAMPER_SRC",
    );
    const accepting = migrateSlice({
      schema: w.slice.schema,
      accepted: [
        { source: "app", id: "0000_a", recorded, current: edited.sha256, reason: "comment only" },
      ],
    });
    const { events, onEvent } = recorder();
    const ok = await applyMigrations(main.transactor, accepting, sources, opts({ onEvent }));
    expect(ok.plan.accepted).toEqual([{ source: "app", id: "0000_a", reason: "comment only" }]);
    expect(events).toContainEqual({
      type: "migrate.accepted",
      source: "app",
      id: "0000_a",
      reason: "comment only",
    });
  });

  test("tracker rows: an unknown row and a duplicate key each refuse, naming them", async () => {
    const w = world();
    await applyMigrations(main.transactor, w.slice, appSources(w), opts());
    await sql.unsafe(
      `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ('h', null)`,
    );
    const unknown = await rejected(
      applyMigrations(main.transactor, w.slice, appSources(w), opts()),
    );
    expect(unknown.code).toBe("ERR_ROOTSTOCK_MIG_TRACKER_ROWS");
    expect(unknown.message).toContain('source "app"\'s tracker has unknown rows with id 3');
    await sql.unsafe(`delete from "${w.d}".__drizzle_migrations where created_at is null`);
    await sql.unsafe(
      `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ('h', 1700000000000)`,
    );
    const dup = await rejected(applyMigrations(main.transactor, w.slice, appSources(w), opts()));
    expect(dup.code).toBe("ERR_ROOTSTOCK_MIG_TRACKER_ROWS");
    expect(dup.message).toContain("duplicate keys 1700000000000");
  });

  test("tracker shape: a filename tracker with the wrong key type refuses before anything runs", async () => {
    const w = world();
    await sql.unsafe(`CREATE SCHEMA "${w.f}"`);
    await sql.unsafe(`CREATE TABLE "${w.f}".schema_migrations (filename int PRIMARY KEY)`);
    const err = await rejected(applyMigrations(main.transactor, w.slice, appSources(w), opts()));
    expect(err.code).toBe("ERR_ROOTSTOCK_MIG_TRACKER_SHAPE");
    expect(err.message).toContain(`${w.f}.schema_migrations`);
    expect(err.message).toContain("filename integer");
    // The bootstrap is one transaction: the drizzle tracker it made first is gone too.
    const row = await one<{ e: boolean }>("select to_regnamespace($1::text) is not null as e", [
      w.d,
    ]);
    expect(row?.e).toBe(false);
  });

  for (const level of ["repeatable read", "serializable"]) {
    test(`isolation: a role defaulting to ${level} is refused, and nothing is created`, async () => {
      const w = world();
      await sql.unsafe(`SET default_transaction_isolation = '${level}'`);
      try {
        const err = await rejected(
          applyMigrations(main.transactor, w.slice, appSources(w), opts()),
        );
        expect(err.code).toBe("ERR_ROOTSTOCK_MIG_ISOLATION");
      } finally {
        await sql.unsafe("RESET default_transaction_isolation");
      }
      for (const name of [w.slice.schema, w.d, w.f]) {
        const row = await one<{ e: boolean }>("select to_regnamespace($1::text) is not null as e", [
          name,
        ]);
        expect(row?.e).toBe(false);
      }
    });
  }

  test("verify: a file that removes an earlier file's row fails the run after applying", async () => {
    const w = world();
    const sources = [
      rootstockSource(w.slice),
      drizzleSource(w, [
        mig("app", "0000_a", "1700000000000", `CREATE TABLE "${w.d}".a (x int)`),
        mig(
          "app",
          "0001_rm",
          "1700000000001",
          `DELETE FROM "${w.d}".__drizzle_migrations WHERE created_at = 1700000000000`,
        ),
      ]),
    ];
    const err = await rejected(applyMigrations(main.transactor, w.slice, sources, opts()));
    expect(err).toEqual({
      message:
        "rootstock migrate: after applying, app/0000_a still read as pending — the tracker and the database disagree; do not re-run until this is understood",
      code: "ERR_ROOTSTOCK_MIG_VERIFY",
    });
  });

  test("verify: a file that rewrites an earlier file's hash fails the run as tampered", async () => {
    const w = world();
    const sources = [
      rootstockSource(w.slice),
      drizzleSource(w, [
        mig("app", "0000_a", "1700000000000", `CREATE TABLE "${w.d}".a (x int)`),
        mig(
          "app",
          "0001_rw",
          "1700000000001",
          `UPDATE "${w.d}".__drizzle_migrations SET hash = 'x' WHERE created_at = 1700000000000`,
        ),
      ]),
    ];
    expect(await rejected(applyMigrations(main.transactor, w.slice, sources, opts()))).toEqual({
      message:
        "rootstock migrate: after applying, app/0000_a still read as tampered — the tracker and the database disagree; do not re-run until this is understood",
      code: "ERR_ROOTSTOCK_MIG_VERIFY",
    });
  });

  test("a failing file names itself, keeps its SQLSTATE, and rolls back alone", async () => {
    const w = world();
    const sources = [
      rootstockSource(w.slice),
      drizzleSource(w, [
        mig("app", "0000_a", "1700000000000", `CREATE TABLE "${w.d}".a (x int)`),
        mig(
          "app",
          "0001_bad",
          "1700000000001",
          `CREATE TABLE "${w.d}".z (x int);\n--> statement-breakpoint\nSELECT 1/0`,
        ),
      ]),
    ];
    const err = await applyMigrations(main.transactor, w.slice, sources, opts()).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toStartWith(
      "rootstock migrate: app/0001_bad failed and was rolled back; files before it stay applied — ",
    );
    expect(pgCode(err)).toBe("22012");
    expect((await drizzleRows(w)).map((r) => r.created_at)).toEqual(["1700000000000"]);
  });

  test("an older tracker without hashes is upgraded and stamped, with its events", async () => {
    const w = world();
    await sql.unsafe(`CREATE SCHEMA "${w.f}"`);
    await sql.unsafe(
      `CREATE TABLE "${w.f}".schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await sql.unsafe(
      `INSERT INTO "${w.f}".schema_migrations (filename) VALUES ('20260101000000_u.sql')`,
    );
    await sql.unsafe(`CREATE TABLE "${w.f}".u (x int)`);
    const { events, onEvent } = recorder();
    const result = await applyMigrations(
      main.transactor,
      w.slice,
      appSources(w),
      opts({ onEvent }),
    );
    expect(result.bootstrap).toEqual({
      created: [`${w.d}.__drizzle_migrations`],
      upgraded: [`${w.f}.schema_migrations`],
      stamped: 1,
    });
    expect(events.slice(0, 3)).toEqual([
      { type: "migrate.tracker_created", source: "app", table: `${w.d}.__drizzle_migrations` },
      { type: "migrate.tracker_upgraded", source: "auth", table: `${w.f}.schema_migrations` },
      { type: "migrate.hash_stamped", source: "auth", id: "20260101000000_u.sql" },
    ]);
    expect(events).toContainEqual({
      type: "migrate.applying",
      source: "app",
      id: "0000_a",
      kind: "additive",
    });
    expect(result.plan.apply.map((a) => a.id)).not.toContain("20260101000000_u.sql");
  });

  test("planOnly takes no lock: it answers while another session holds the migration lock", async () => {
    const w = world();
    const holder = openSecond();
    try {
      await holder.transactor.sql.unsafe(
        "select 1::int as held from pg_advisory_lock(hashtext($1::text)::bigint)",
        [`rootstock-migrate:${w.slice.schema}`],
      );
      const answered = await Promise.race([
        applyMigrations(main.transactor, w.slice, appSources(w), opts({ planOnly: true })).then(
          () => "answered",
        ),
        new Promise((r) => setTimeout(() => r("blocked"), 3000)),
      ]);
      expect(answered).toBe("answered");
    } finally {
      await holder.close();
    }
  });

  test("refusal order: first match wins (§1.4 step 2)", async () => {
    const w = world();
    await applyMigrations(main.transactor, w.slice, appSources(w), opts());
    const [root, app, auth] = appSources(w);
    if (root === undefined || app === undefined || auth === undefined) throw new Error("fixture");
    const code = async (sources: TrackedSource[], o: Partial<ApplyOptions> = {}) =>
      (await rejected(applyMigrations(main.transactor, w.slice, sources, opts(o)))).code;
    const edited = mig("app", "0000_a", "1700000000000", `CREATE TABLE "${w.d}".a (x int) -- e`);
    const heavy = mig("app", "0002_h", "1700000000002", `CREATE TABLE "${w.d}".h (x int)`, "heavy");
    // ahead (0001_b dropped) + pending heavy, under manual: ahead is refused before heavy.
    const aheadHeavy = [
      root,
      { ...app, migrations: [app.migrations[0] as SourceMigration, heavy] },
      auth,
    ];
    expect(await code(aheadHeavy, { entry: "manual" })).toBe("ERR_ROOTSTOCK_MIG_AHEAD_SRC");
    // the same under deploy: ahead is reported, heavy refuses.
    expect(await code(aheadHeavy)).toBe("ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY");
    // tamper + ahead: tamper first, under either entry.
    const tamperAhead = [root, { ...app, migrations: [edited] }, auth];
    expect(await code(tamperAhead, { entry: "manual" })).toBe("ERR_ROOTSTOCK_MIG_TAMPER_SRC");
    // an unknown row + tamper: the tracker rows first.
    await sql.unsafe(
      `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ('h', null)`,
    );
    expect(await code(tamperAhead)).toBe("ERR_ROOTSTOCK_MIG_TRACKER_ROWS");
  });
});

describe("the per-file re-read (§1.4 step 5): a row that appears after the plan", () => {
  /**
   * Bootstraps and plans, then lets `between` write as another applier would
   * (the backup hook runs after the plan, before the first file).
   */
  async function withRowAfterPlan(
    w: World,
    between: () => Promise<void>,
    slice: MigrateSlice = w.slice,
  ): Promise<{
    result?: ApplyResult;
    err?: { message: string; code: unknown };
    events: MigrateEvent[];
  }> {
    const { events, onEvent } = recorder();
    try {
      const result = await applyMigrations(
        main.transactor,
        slice,
        appSources(w),
        opts({ onEvent, backup: { run: between } }),
      );
      return { result, events };
    } catch (e) {
      return {
        err: { message: (e as Error).message, code: (e as { code?: unknown }).code },
        events,
      };
    }
  }

  const fileB = (w: World) => appSources(w)[1]?.migrations[1] as SourceMigration;

  test("same hash: skipped as concurrent, never run twice", async () => {
    const w = world();
    const { result, events } = await withRowAfterPlan(w, async () => {
      await sql.unsafe(
        `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ($1, 1700000000001)`,
        [fileB(w).sha256],
      );
    });
    expect(result?.skippedConcurrent).toEqual([{ source: "app", id: "0001_b" }]);
    expect(events).toContainEqual({
      type: "migrate.skipped_concurrent",
      source: "app",
      id: "0001_b",
    });
    const table = await one<{ t: boolean }>(`select to_regclass('"${w.d}".b') is not null as t`);
    expect(table?.t).toBe(false);
  });

  test("another hash: refused as tampered, the file does not run", async () => {
    const w = world();
    const { err } = await withRowAfterPlan(w, async () => {
      await sql.unsafe(
        `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ($1, 1700000000001)`,
        ["f".repeat(64)],
      );
    });
    expect(err?.code).toBe("ERR_ROOTSTOCK_MIG_TAMPER_SRC");
    expect(err?.message).toContain(`recorded 0001_b with hash ${"f".repeat(64)}`);
    const table = await one<{ t: boolean }>(`select to_regclass('"${w.d}".b') is not null as t`);
    expect(table?.t).toBe(false);
  });

  test("another hash the slice accepts: skipped", async () => {
    const w = world();
    const recorded = "e".repeat(64);
    const slice = migrateSlice({
      schema: w.slice.schema,
      accepted: [{ source: "app", id: "0001_b", recorded, current: fileB(w).sha256, reason: "r" }],
    });
    const { result } = await withRowAfterPlan(
      w,
      async () => {
        await sql.unsafe(
          `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ($1, 1700000000001)`,
          [recorded],
        );
      },
      slice,
    );
    expect(result?.skippedConcurrent).toEqual([{ source: "app", id: "0001_b" }]);
  });

  test("a NULL hash (an older migrator's row): skipped", async () => {
    const w = world();
    const { result } = await withRowAfterPlan(w, async () => {
      await sql.unsafe(
        `insert into "${w.f}".schema_migrations (filename) values ('20260101000000_u.sql')`,
      );
    });
    expect(result?.skippedConcurrent).toEqual([{ source: "auth", id: "20260101000000_u.sql" }]);
  });

  test("two rows for the key: refused as tracker rows", async () => {
    const w = world();
    const { err } = await withRowAfterPlan(w, async () => {
      const h = fileB(w).sha256;
      await sql.unsafe(
        `insert into "${w.d}".__drizzle_migrations (hash, created_at) values ($1, 1700000000001), ($1, 1700000000001)`,
        [h],
      );
    });
    expect(err).toEqual({
      message:
        'rootstock migrate: source "app"\'s tracker has duplicate keys 1700000000001 — fix those rows by hand (see the census procedure); re-running will not fix this',
      code: "ERR_ROOTSTOCK_MIG_TRACKER_ROWS",
    });
  });
});

describe("kill points (O10): each re-run converges", () => {
  async function killed(t: Transactor, w: World, sources: TrackedSource[]): Promise<void> {
    const err = await applyMigrations(t, w.slice, sources, opts()).then(
      () => {
        throw new Error("expected the run to die");
      },
      (e: unknown) => e,
    );
    // A dead connection surfaces from the transaction itself; the stand-in's
    // division by zero (see dying()) from the file, which names itself.
    if (main.transactor.id === "bun-sql") {
      expect((err as Error).message).toContain("Connection closed");
    } else {
      expect((err as Error).message).toStartWith("rootstock migrate: app/0001_b failed");
      expect(pgCode(err)).toBe("22012");
    }
  }

  /**
   * A file whose statement `at` ends its own backend, as a crash mid-file
   * does. postgres.js under Bun throws uncaught when its socket is closed
   * under it, so on that driver the statement fails instead: the server's
   * side, an open transaction rolled back, is the same.
   */
  function dying(w: World, at: 0 | 1): SourceMigration {
    const die =
      main.transactor.id === "bun-sql"
        ? "SELECT pg_terminate_backend(pg_backend_pid())"
        : "SELECT 1/0";
    const statements = [
      `CREATE TABLE "${w.d}".half (x int)`,
      `CREATE TABLE "${w.d}".other (x int)`,
    ];
    statements.splice(at, 0, die);
    return mig("app", "0001_b", "1700000000001", statements.join("\n--> statement-breakpoint\n"));
  }

  for (const [label, at] of [
    ["between a file's statements", 1],
    ["after the previous file's commit", 0],
  ] as const) {
    test(label, async () => {
      const w = world();
      const victim = openTestTransactor();
      try {
        const [root, app, auth] = appSources(w);
        if (root === undefined || app === undefined || auth === undefined)
          throw new Error("fixture");
        const first = app.migrations[0];
        if (first === undefined) throw new Error("fixture");
        await killed(victim.transactor, w, [
          root,
          { ...app, migrations: [first, dying(w, at)] },
          auth,
        ]);
      } finally {
        await victim.close().catch(() => undefined);
      }
      // The file that died left nothing: no row, no table.
      expect((await drizzleRows(w)).map((r) => r.created_at)).toEqual(["1700000000000"]);
      const half = await one<{ t: boolean }>(
        `select to_regclass('"${w.d}".half') is not null as t`,
      );
      expect(half?.t).toBe(false);
      const again = await applyMigrations(main.transactor, w.slice, appSources(w), opts());
      expect(again.applied.map((a) => a.id)).toEqual(["0001_b", "20260101000000_u.sql"]);
      expect(await drizzleRows(w)).toHaveLength(2);
    });
  }
});

describe("concurrency (B1): two appliers, one database", () => {
  let pooledSkips = 0;
  async function race(a: Transactor, b: Transactor): Promise<string | undefined> {
    const w = world();
    const results = await Promise.all([
      applyMigrations(a, w.slice, appSources(w), opts()),
      applyMigrations(b, w.slice, appSources(w), opts()),
    ]).catch((err: unknown) => String(err));
    if (typeof results === "string") return results;
    const total = results.reduce((n, r) => n + r.applied.length, 0);
    if (total !== 4) return `applied ${total} times, expected 4`;
    pooledSkips += results.reduce((n, r) => n + r.skippedConcurrent.length, 0);
    if ((await drizzleRows(w)).length !== 2) return "drizzle rows";
    if ((await folderRows(w)).length !== 1) return "folder rows";
    if ((await rootstockRows(w)) !== 1) return "rootstock rows";
    return undefined;
  }

  test("one pooled transactor of two backends, two appliers", async () => {
    const pooled = openPooled(2);
    try {
      const failures: string[] = [];
      for (let i = 0; i < 20; i++) {
        const why = await race(pooled.transactor, pooled.transactor);
        if (why !== undefined) failures.push(why);
      }
      expect(failures).toEqual([]);
      // The two overlapped at least once, or the re-read was never exercised here.
      expect(pooledSkips).toBeGreaterThan(0);
    } finally {
      await pooled.close();
    }
  }, 60_000);

  test("two transactors, and the loser of a file reports it as skipped", async () => {
    const second = openSecond();
    try {
      const failures: string[] = [];
      let skips = 0;
      for (let i = 0; i < 20; i++) {
        const w = world();
        const settled = await Promise.all([
          applyMigrations(main.transactor, w.slice, appSources(w), opts()),
          applyMigrations(second.transactor, w.slice, appSources(w), opts()),
        ]).catch((err: unknown) => String(err));
        if (typeof settled === "string") {
          failures.push(settled);
          continue;
        }
        const applied = settled.reduce((n, r) => n + r.applied.length, 0);
        if (applied !== 4) failures.push(`applied ${applied} times`);
        skips += settled.reduce((n, r) => n + r.skippedConcurrent.length, 0);
      }
      expect(failures).toEqual([]);
      // Both planned before either applied at least once in twenty runs, or the
      // per-file re-read was never exercised and this test proves nothing.
      expect(skips).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  }, 60_000);
});
