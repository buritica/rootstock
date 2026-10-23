import { describe, expect, test } from "bun:test";
import { checkMigrationOrder, gitMainReader, type OrderFinding } from "./order.ts";
import { migrateSlice } from "./slice.ts";
import { drizzleJournalFrom, type SourceMigration, sqlFolderFrom } from "./sources.ts";
import type { TrackedSource } from "./tracked.ts";

const enc = new TextEncoder();
const A = "-- rootstock-migration: additive\nCREATE TABLE a (id int);\n";
const B = "-- rootstock-migration: additive\nCREATE TABLE b (id int);\n";
const C = "-- rootstock-migration: additive\nCREATE TABLE c (id int);\n";
const BARE = "CREATE TABLE d (id int);\n";
const NOW = () => new Date("2026-10-23T00:00:00Z");
const SLICE = migrateSlice({ ahead: "refuse" });

function sql(files: Record<string, string>, baseline?: string): readonly SourceMigration[] {
  return sqlFolderFrom(
    Object.keys(files),
    (n) => enc.encode(files[n] as string),
    baseline === undefined ? { name: "app" } : { name: "app", marker: { baseline } },
  );
}

function journal(entries: readonly [string, number][]): string {
  return JSON.stringify({ entries: entries.map(([tag, when]) => ({ tag, when })) });
}

function drizzle(entries: readonly [string, number, string][]): readonly SourceMigration[] {
  const files = Object.fromEntries(entries.map(([tag, , text]) => [`${tag}.sql`, text]));
  return drizzleJournalFrom(
    journal(entries.map(([tag, when]) => [tag, when])),
    (n) => enc.encode(files[n] as string),
    { name: "app" },
  );
}

const tracked = (migrations: readonly SourceMigration[]): TrackedSource => ({
  name: "app",
  migrations,
  // A drizzle reader's ids carry no .sql; its keys compare as integers.
  tracker: migrations.some((m) => m.id.endsWith(".sql"))
    ? { kind: "filename", schema: "public", table: "schema_migrations" }
    : { kind: "drizzle", schema: "drizzle", table: "__drizzle_migrations" },
});

const check = (
  branch: readonly SourceMigration[],
  main: readonly SourceMigration[],
  slice = SLICE,
) => checkMigrationOrder(slice, [tracked(branch)], async () => main, NOW);

const MAIN = { "20261001000000_a.sql": A, "20261002000000_b.sql": B };

describe("checkMigrationOrder", () => {
  test("a new, later, marked migration is clean", async () => {
    expect(await check(sql({ ...MAIN, "20261003000000_c.sql": C }), sql(MAIN))).toEqual([]);
  });

  const cases: [string, Record<string, string>, OrderFinding["problem"], string][] = [
    ["a numbered name", { "99999999999999x_c.sql": C }, "name", "99999999999999x_c.sql"],
    ["an impossible time", { "20261399000000_c.sql": C }, "name", "20261399000000_c.sql"],
    ["a stamp two days out", { "20261025000000_c.sql": C }, "future-stamp", "20261025000000_c.sql"],
    [
      "a key older than main's newest",
      { "20261001120000_c.sql": C },
      "older-than-main",
      "20261001120000_c.sql",
    ],
    ["an unmarked file", { "20261003000000_c.sql": BARE }, "unmarked", "20261003000000_c.sql"],
  ];
  for (const [what, extra, problem, id] of cases) {
    test(`finds ${what}`, async () => {
      expect(await check(sql({ ...MAIN, ...extra }), sql(MAIN))).toEqual([
        { source: "app", id, problem },
      ]);
    });
  }

  test("a stamp within a day of now is fine", async () => {
    expect(await check(sql({ ...MAIN, "20261023230000_c.sql": C }), sql(MAIN))).toEqual([]);
  });

  test("an unmarked file at or before the baseline is fine", async () => {
    const branch = sql({ ...MAIN, "20261003000000_c.sql": BARE }, "20261003000000_c.sql");
    expect(await check(branch, sql(MAIN))).toEqual([]);
  });

  test("a file edited on the branch is edited-on-main", async () => {
    expect(await check(sql({ ...MAIN, "20261002000000_b.sql": C }), sql(MAIN))).toEqual([
      { source: "app", id: "20261002000000_b.sql", problem: "edited-on-main" },
    ]);
  });

  test("key-changed-on-main: the same tag and file under a new when", async () => {
    const main = drizzle([
      ["20261001000000_a", 1000, A],
      ["20261002000000_b", 2000, B],
    ]);
    const branch = drizzle([
      ["20261001000000_a", 1000, A],
      ["20261002000000_b", 2500, B],
    ]);
    expect(await check(branch, main)).toEqual([
      { source: "app", id: "20261002000000_b", problem: "key-changed-on-main" },
    ]);
  });

  test("drizzle keys compare as integers", async () => {
    const main = drizzle([["20261001000000_a", 900, A]]);
    const branch = drizzle([
      ["20261001000000_a", 900, A],
      ["20261002000000_b", 1000, B],
    ]);
    expect(await check(branch, main)).toEqual([]);
  });

  test("a rename keeps key and hash and passes; renamed and edited is an edit", async () => {
    const before = { "0000_a.sql": A, "0001_b.sql": B };
    const renames = JSON.stringify({
      "0000_a.sql": "20261001000000_a.sql",
      "0001_b.sql": "20261002000000_b.sql",
    });
    const renamed = sql({ ...MAIN, "renames.json": renames });
    expect(await check(renamed, sql(before))).toEqual([]);
    const edited = sql({
      "20261001000000_a.sql": A,
      "20261002000000_b.sql": C,
      "renames.json": renames,
    });
    expect(await check(edited, sql(before))).toEqual([
      { source: "app", id: "20261002000000_b.sql", problem: "edited-on-main" },
    ]);
  });

  test("accepted entries must name a migration with that current hash", async () => {
    const branch = sql({ ...MAIN });
    const current = branch[0]?.sha256 as string;
    const other = "f".repeat(64);
    const slice = migrateSlice({
      ahead: "refuse",
      accepted: [
        { source: "app", id: "20261001000000_a.sql", recorded: other, current, reason: "ok" },
        {
          source: "app",
          id: "20261002000000_b.sql",
          recorded: current,
          current: other,
          reason: "stale",
        },
        { source: "app", id: "nope.sql", recorded: current, current: other, reason: "gone" },
        { source: "elsewhere", id: "x.sql", recorded: current, current: other, reason: "other db" },
      ],
    });
    expect(await check(branch, sql(MAIN), slice)).toEqual([
      { source: "app", id: "20261002000000_b.sql", problem: "accepted-current-mismatch" },
      { source: "app", id: "nope.sql", problem: "accepted-unknown-id" },
    ]);
  });

  test("rootstock's own source is skipped and never read from main", async () => {
    const own: TrackedSource = {
      name: "rootstock",
      migrations: [],
      tracker: { kind: "rootstock" },
    };
    const read: string[] = [];
    await checkMigrationOrder(
      SLICE,
      [own, tracked(sql(MAIN))],
      async (s) => {
        read.push(s);
        return sql(MAIN);
      },
      NOW,
    );
    expect(read).toEqual(["app"]);
  });

  test("a readMain failure rejects the check", async () => {
    const boom = new Error("git exploded");
    await expect(
      checkMigrationOrder(SLICE, [tracked(sql(MAIN))], async () => Promise.reject(boom), NOW),
    ).rejects.toBe(boom);
  });

  test("refuses a slice migrateSlice did not build", async () => {
    await expect(
      checkMigrationOrder({ schema: "rootstock" } as never, [], async () => [], NOW),
    ).rejects.toThrow(/checkMigrationOrder: expected a MigrateSlice/);
  });

  test("findings are frozen", async () => {
    const out = await check(sql({ ...MAIN, "0003_c.sql": C }), sql(MAIN));
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
  });
});

/** A fake git over one ref's tree, recording every call. */
function fakeGit(
  tree: Record<string, string | Uint8Array>,
  opts: { shallow?: boolean; fail?: string } = {},
) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]): Promise<Uint8Array> => {
    calls.push([...args]);
    if (opts.fail !== undefined && args[0] === opts.fail)
      throw new Error(`git ${opts.fail} failed`);
    const [cmd] = args;
    if (cmd === "rev-parse") return enc.encode(opts.shallow ? "true\n" : "false\n");
    if (cmd === "fetch") return new Uint8Array();
    if (cmd === "ls-tree") {
      const dir = (args[2] as string).replace(/^[^:]+:/, "").replace(/\/$/, "");
      const children = new Map<string, string>();
      for (const path of Object.keys(tree)) {
        if (!path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        const slash = rest.indexOf("/");
        if (slash === -1)
          children.set(rest, rest.startsWith("link") ? "120000 blob" : "100644 blob");
        else children.set(rest.slice(0, slash), "040000 tree");
      }
      if (children.size === 0) throw new Error(`fatal: not a tree object: ${args[2]}`);
      return enc.encode([...children].map(([n, t]) => `${t} 0000\t${n}\0`).join(""));
    }
    if (cmd === "cat-file") {
      const path = (args[2] as string).replace(/^[^:]+:/, "");
      const body = tree[path];
      if (body === undefined) throw new Error(`fatal: path ${path} does not exist`);
      return typeof body === "string" ? enc.encode(body) : body;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("gitMainReader", () => {
  const SQL_TREE = {
    "db/mig/20261001000000_a.sql": A,
    "db/mig/20261002000000_b.sql": B,
    "db/mig/README.md": "notes",
    "db/mig/auth/20261001000000_x.sql": C,
  };

  test("reads an sql folder as the working-tree reader would, skipping subtrees", async () => {
    const { run } = fakeGit(SQL_TREE);
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "db/mig/", layout: "sql" } },
    });
    expect(await read("app")).toEqual(sql(MAIN));
  });

  test("reads renames.json on the ref", async () => {
    const { run } = fakeGit({
      "m/20261001000000_a.sql": A,
      "m/renames.json": JSON.stringify({ "0000_a.sql": "20261001000000_a.sql" }),
    });
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "m", layout: "sql" } },
    });
    expect((await read("app")).map((m) => m.key)).toEqual(["0000_a.sql"]);
  });

  test("reads a drizzle folder", async () => {
    const entries: [string, number, string][] = [
      ["20261001000000_a", 1000, A],
      ["20261002000000_b", 2000, BARE],
    ];
    const tree: Record<string, string> = {
      "drz/meta/_journal.json": journal(entries.map(([t, w]) => [t, w])),
    };
    for (const [tag, , text] of entries) tree[`drz/${tag}.sql`] = text;
    const { run } = fakeGit(tree);
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "drz", layout: "drizzle" } },
    });
    expect(await read("app")).toEqual(drizzle(entries));
  });

  test("a full-history checkout fetches without --depth, once per reader", async () => {
    const { run, calls } = fakeGit(SQL_TREE);
    const read = gitMainReader({
      run,
      fetch: "always",
      folders: { app: { path: "db/mig", layout: "sql" } },
    });
    await read("app");
    await read("app");
    const fetches = calls.filter((c) => c[0] === "fetch");
    expect(fetches).toEqual([
      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    ]);
  });

  test("a shallow checkout fetches with --depth=1", async () => {
    const { run, calls } = fakeGit(SQL_TREE, { shallow: true });
    const read = gitMainReader({
      run,
      fetch: "always",
      folders: { app: { path: "db/mig", layout: "sql" } },
    });
    await read("app");
    expect(calls.find((c) => c[0] === "fetch")).toEqual([
      "fetch",
      "--depth=1",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
  });

  test("fetch never runs no fetch", async () => {
    const { run, calls } = fakeGit(SQL_TREE);
    await gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "db/mig", layout: "sql" } },
    })("app");
    expect(calls.some((c) => c[0] === "fetch" || c[0] === "rev-parse")).toBe(false);
  });

  test("a git failure rejects, naming the ref, with the I/O code and cause", async () => {
    const { run } = fakeGit(SQL_TREE, { fail: "fetch" });
    const read = gitMainReader({
      run,
      fetch: "always",
      folders: { app: { path: "db/mig", layout: "sql" } },
    });
    const err = await read("app").catch((e) => e);
    expect(err.message).toBe("rootstock migrate: cannot fetch origin/main — git fetch failed");
    expect(err.code).toBe("ERR_ROOTSTOCK_MIG_IO");
    expect(err.cause.message).toBe("git fetch failed");
  });

  test("a missing folder rejects, never reads as empty", async () => {
    const { run } = fakeGit(SQL_TREE);
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "nowhere", layout: "sql" } },
    });
    await expect(read("app")).rejects.toThrow('source "app": cannot list origin/main:nowhere/');
  });

  test("a reader refusal on main names the ref", async () => {
    const { run } = fakeGit({ "m/notes.md": "x" });
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "m", layout: "sql" } },
    });
    await expect(read("app")).rejects.toThrow("origin/main:m/ holds no .sql file — wrong folder?");
  });

  test("a symlink on the ref is refused", async () => {
    const { run } = fakeGit({ "m/20261001000000_a.sql": A, "m/link.sql": "target.sql" });
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "m", layout: "sql" } },
    });
    await expect(read("app")).rejects.toThrow(/link\.sql is a symlink on the ref/);
  });

  test("an unknown source and bad options are refused", async () => {
    const { run } = fakeGit(SQL_TREE);
    await expect(gitMainReader({ run, fetch: "never", folders: {} })("app")).rejects.toThrow(
      'gitMainReader has no folder for source "app"',
    );
    expect(() => gitMainReader({ run, fetch: "sometimes" as never, folders: {} })).toThrow(
      /fetch must be/,
    );
    expect(() => gitMainReader({ run, fetch: "always", ref: "main", folders: {} })).toThrow(
      /needs a <remote>\/<branch> ref/,
    );
    expect(() => gitMainReader({ run, fetch: "never", ref: "-o", folders: {} })).toThrow(
      /plain ref name/,
    );
  });

  test("composes with checkMigrationOrder end to end", async () => {
    const { run } = fakeGit(SQL_TREE);
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "db/mig", layout: "sql" } },
    });
    const branch = sql({ ...MAIN, "0003_c.sql": C });
    expect(await checkMigrationOrder(SLICE, [tracked(branch)], read, NOW)).toEqual([
      { source: "app", id: "0003_c.sql", problem: "name" },
      { source: "app", id: "0003_c.sql", problem: "older-than-main" },
    ]);
  });
});
