import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Sql, Transactor } from "../db/index.ts";
import {
  openPooled,
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { sha256Hex } from "../hash/index.ts";
import { type ApplyOptions, applyMigrations, type MigrateEvent } from "./applier.ts";
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

  test("ahead: deploy applies and reports it, manual refuses it, ahead plus pending has diverged", async () => {
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
    const diverged = await rejected(applyMigrations(main.transactor, w.slice, hotfix, opts()));
    expect(diverged).toEqual({
      message:
        'rootstock migrate: source "app" has applied 1700000000001, which this checkout does not have, and is missing 0002_fix — the database and this checkout have diverged (a renamed file without its renames.json entry reads this way); refusing',
      code: "ERR_ROOTSTOCK_MIG_DIVERGED_SRC",
    });
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
    // The bootstrap is one transaction: the drizzle tracker it made first is gone too.
    const row = await one<{ e: boolean }>("select to_regnamespace($1::text) is not null as e", [
      w.d,
    ]);
    expect(row?.e).toBe(false);
  });

  test("isolation: a role defaulting to repeatable read is refused, and nothing is created", async () => {
    const w = world();
    await sql.unsafe("SET default_transaction_isolation = 'repeatable read'");
    try {
      const err = await rejected(applyMigrations(main.transactor, w.slice, appSources(w), opts()));
      expect(err.code).toBe("ERR_ROOTSTOCK_MIG_ISOLATION");
    } finally {
      await sql.unsafe("RESET default_transaction_isolation");
    }
    const row = await one<{ e: boolean }>("select to_regnamespace($1::text) is not null as e", [
      w.slice.schema,
    ]);
    expect(row?.e).toBe(false);
  });

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
});

describe("kill points (O10): each re-run converges", () => {
  async function killed(t: Transactor, w: World, sources: TrackedSource[]): Promise<void> {
    await applyMigrations(t, w.slice, sources, opts()).then(
      () => {
        throw new Error("expected the run to die");
      },
      () => undefined,
    );
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
  async function race(a: Transactor, b: Transactor): Promise<string | undefined> {
    const w = world();
    const results = await Promise.all([
      applyMigrations(a, w.slice, appSources(w), opts()),
      applyMigrations(b, w.slice, appSources(w), opts()),
    ]).catch((err: unknown) => String(err));
    if (typeof results === "string") return results;
    const total = results.reduce((n, r) => n + r.applied.length, 0);
    if (total !== 4) return `applied ${total} times, expected 4`;
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
