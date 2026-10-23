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
const SLICE = migrateSlice({});

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

/** Findings without their prose, for asserting which rules fired. */
const bare = (out: readonly OrderFinding[]) =>
  out.map(({ source, id, problem }) => ({ source, id, problem }));

const check = async (
  branch: readonly SourceMigration[],
  main: readonly SourceMigration[],
  slice = SLICE,
) => bare(await checkMigrationOrder(slice, [tracked(branch)], async () => main, NOW));

const MAIN = { "20261001000000_a.sql": A, "20261002000000_b.sql": B };

describe("checkMigrationOrder", () => {
  test("a new, later, marked migration is clean", async () => {
    expect(await check(sql({ ...MAIN, "20261003000000_c.sql": C }), sql(MAIN))).toEqual([]);
  });

  const cases: [string, Record<string, string>, OrderFinding["problem"], string][] = [
    ["a bad month", { "20269901000000_c.sql": C }, "name", "20269901000000_c.sql"],
    ["an upper-case suffix", { "20261003000000_C.sql": C }, "name", "20261003000000_C.sql"],
    ["an empty suffix", { "20261003000000_.sql": C }, "name", "20261003000000_.sql"],
    [
      "a second past the day",
      { "20261024000001_c.sql": C },
      "future-stamp",
      "20261024000001_c.sql",
    ],
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

  test("a stamp up to exactly a day after now is fine", async () => {
    expect(await check(sql({ ...MAIN, "20261024000000_c.sql": C }), sql(MAIN))).toEqual([]);
  });

  test("a rename to a bad name is still a bad name", async () => {
    const before = { "0000_a.sql": A };
    const renamed = sql({
      "0001_a.sql": A,
      "renames.json": JSON.stringify({ "0000_a.sql": "0001_a.sql" }),
    });
    expect(await check(renamed, sql(before))).toEqual([
      { source: "app", id: "0001_a.sql", problem: "name" },
    ]);
  });

  test("refuses sources it cannot trust, with the source code", async () => {
    const run = (sources: readonly TrackedSource[]) =>
      checkMigrationOrder(SLICE, sources, async () => sql(MAIN), NOW).catch((e) => e);
    const app = tracked(sql(MAIN));
    const disguised = { ...app, tracker: { kind: "rootstock" } } as TrackedSource;
    const misnamed = { ...app, name: "rootstock" };
    const foreign = { ...app, name: "other" };
    for (const [sources, message] of [
      [[app, app], /"app" is listed twice/],
      [[disguised], /"app" has tracker kind "rootstock"/],
      [[misnamed], /"rootstock" has tracker kind "filename"/],
      [[foreign], /source "other" holds "20261001000000_a\.sql" from source "app"/],
    ] as const) {
      const err = await run(sources);
      expect(err.message).toMatch(message);
      expect(err.code).toBe("ERR_ROOTSTOCK_MIG_SRC");
    }
  });

  test("a drizzle key that is not a when is refused, not thrown raw", async () => {
    const drz = {
      ...tracked(sql(MAIN)),
      tracker: { kind: "drizzle", schema: "d", table: "t" },
    } as TrackedSource;
    await expect(checkMigrationOrder(SLICE, [drz], async () => [], NOW)).rejects.toThrow(
      /has key "20261001000000_a\.sql", but a drizzle key is a when/,
    );
  });

  test("an invalid now() and a non-array readMain are refused with a code", async () => {
    const bad = await checkMigrationOrder(
      SLICE,
      [],
      async () => [],
      () => new Date("x"),
    ).catch((e) => e);
    expect(bad.code).toBe("ERR_ROOTSTOCK_MIG_SRC");
    await expect(
      checkMigrationOrder(SLICE, [tracked(sql(MAIN))], async () => undefined as never, NOW),
    ).rejects.toThrow(/did not resolve to an array/);
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
      { source: "elsewhere", id: "x.sql", problem: "accepted-unknown-id" },
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

  test("deleted-on-branch: a main file gone from the branch, or renamed without renames.json", async () => {
    expect(await check(sql({ "20261001000000_a.sql": A }), sql(MAIN))).toEqual([
      { source: "app", id: "20261002000000_b.sql", problem: "deleted-on-branch" },
    ]);
    const before = { "0000_a.sql": A };
    expect(await check(sql({ "20261001000000_a.sql": A }), sql(before))).toEqual([
      { source: "app", id: "0000_a.sql", problem: "deleted-on-branch" },
    ]);
  });

  test("stale-base: an unstamped file main already renamed", async () => {
    const renames = JSON.stringify({ "0000_a.sql": "20261001000000_a.sql" });
    const main = sql({ "20261001000000_a.sql": A, "renames.json": renames });
    expect(await check(sql({ "0000_a.sql": A }), main)).toEqual([
      { source: "app", id: "0000_a.sql", problem: "stale-base" },
    ]);
  });

  test("each finding's detail says what the fix needs", async () => {
    const detailOf = async (
      branch: readonly SourceMigration[],
      main: readonly SourceMigration[],
      slice = SLICE,
    ) =>
      (await checkMigrationOrder(slice, [tracked(branch)], async () => main, NOW)).map(
        (f) => f.detail,
      );
    expect(await detailOf(sql({ ...MAIN, "20261001120000_c.sql": C }), sql(MAIN))).toEqual([
      "its key 20261001120000_c.sql must sort after main's newest, 20261002000000_b.sql (20261002000000_b.sql); regenerate it on top of main",
    ]);
    const branch = sql(MAIN);
    const slice = migrateSlice({
      accepted: [
        {
          source: "app",
          id: "20261001000000_a.sql",
          recorded: "f".repeat(64),
          current: "e".repeat(64),
          reason: "r",
        },
      ],
    });
    expect(await detailOf(branch, sql(MAIN), slice)).toEqual([
      `the file's hash is ${branch[0]?.sha256}, the entry's current is ${"e".repeat(64)}`,
    ]);
    const renamed = sql({
      "20261001000000_a.sql": A,
      "renames.json": JSON.stringify({ "0000_a.sql": "20261001000000_a.sql" }),
    });
    const onOld = migrateSlice({
      accepted: [
        {
          source: "app",
          id: "0000_a.sql",
          recorded: "f".repeat(64),
          current: "e".repeat(64),
          reason: "r",
        },
      ],
    });
    expect(await detailOf(renamed, renamed, onOld)).toEqual([
      "0000_a.sql was renamed to 20261001000000_a.sql; accept it under its current id",
    ]);
  });

  test("findings are frozen", async () => {
    const out = await checkMigrationOrder(
      SLICE,
      [tracked(sql({ ...MAIN, "0003_c.sql": C }))],
      async () => sql(MAIN),
      NOW,
    );
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
  });
});

/** A fake git over one ref's tree, recording every call. */
const SHA = "0123456789abcdef0123456789abcdef01234567";

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
    if (cmd === "rev-parse" && args[1] === "--verify") return enc.encode(`${SHA}\n`);
    if (cmd === "rev-parse") return enc.encode(opts.shallow ? "true\n" : "false\n");
    if (cmd === "fetch") return new Uint8Array();
    if (cmd === "ls-tree" && args[3] === "--") {
      // The probe from the root: one entry when the path exists, else nothing.
      const path = args[4] as string;
      const exists = Object.keys(tree).some((p) => p.startsWith(`${path}/`));
      return enc.encode(exists ? `040000 tree 0000\t${path}\0` : "");
    }
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

  test("the fetch runs before anything is read", async () => {
    const { run, calls } = fakeGit(SQL_TREE);
    await gitMainReader({
      run,
      fetch: "always",
      folders: { app: { path: "db/mig", layout: "sql" } },
    })("app");
    expect(calls.slice(0, 4).map((c) => c.slice(0, 2).join(" "))).toEqual([
      "rev-parse --is-shallow-repository",
      "fetch --no-tags",
      "rev-parse --verify",
      "ls-tree -z",
    ]);
    // Every read names the one resolved commit, never the moving ref.
    expect(calls.filter((c) => c[0] === "cat-file").every((c) => c[2]?.startsWith(`${SHA}:`))).toBe(
      true,
    );
  });

  test("a throwing run makes checkMigrationOrder reject", async () => {
    const { run } = fakeGit(SQL_TREE, { fail: "ls-tree" });
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "db/mig", layout: "sql" } },
    });
    const err = await checkMigrationOrder(SLICE, [tracked(sql(MAIN))], read, NOW).catch((e) => e);
    expect(err.code).toBe("ERR_ROOTSTOCK_MIG_IO");
    expect(err.message).toBe(
      'rootstock migrate: source "app": cannot look for origin/main:db/mig/ — git ls-tree failed',
    );
  });

  test("a file the journal names but the ref lacks is a fact, not I/O", async () => {
    const { run } = fakeGit({
      "drz/meta/_journal.json": journal([["20261001000000_a", 1000]]),
      "drz/x.sql": A,
    });
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "drz", layout: "drizzle" } },
    });
    const err = await read("app").catch((e) => e);
    expect(err.code).toBe("ERR_ROOTSTOCK_MIG_SRC");
    expect(err.message).toMatch(/origin\/main:drz\/20261001000000_a\.sql is not on the ref/);
  });

  test("a subtree named .sql is skipped; a ./ path is read from the root", async () => {
    const { run } = fakeGit({ ...SQL_TREE, "db/mig/x.sql/inner.sql": C });
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "./db/mig/", layout: "sql" } },
    });
    expect(await read("app")).toEqual(sql(MAIN));
  });

  test("a bad folder path, layout or ref is refused with the source code", async () => {
    const { run } = fakeGit(SQL_TREE);
    for (const path of ["", ".", "/abs", "a/../b"]) {
      const err = await gitMainReader({
        run,
        fetch: "never",
        folders: { app: { path, layout: "sql" } },
      })("app").catch((e) => e);
      expect(err.message).toMatch(/folder path must be relative/);
    }
    await expect(
      gitMainReader({
        run,
        fetch: "never",
        folders: { app: { path: "m", layout: "flat" as never } },
      })("app"),
    ).rejects.toThrow(/layout must be/);
    await expect(gitMainReader({ run, fetch: "never", folders: {} })("toString")).rejects.toThrow(
      /no folder for source "toString"/,
    );
    for (const ref of ["a..b", "refs/remotes/origin/main"]) {
      expect(() => gitMainReader({ run, fetch: "always", ref, folders: {} })).toThrow(/ref/);
    }
    expect(() => gitMainReader({ run, fetch: "never", folders: null as never })).toThrow(
      /folders must be an object/,
    );
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
    expect(calls.some((c) => c[0] === "fetch" || c[1] === "--is-shallow-repository")).toBe(false);
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

  test("a folder main does not have reads as a new source, with no history", async () => {
    const { run } = fakeGit(SQL_TREE);
    const read = gitMainReader({
      run,
      fetch: "never",
      folders: { app: { path: "nowhere", layout: "sql" } },
    });
    expect(await read("app")).toEqual([]);
    const branch = sql({ "20261003000000_c.sql": C, "0001_x.sql": BARE });
    expect(bare(await checkMigrationOrder(SLICE, [tracked(branch)], read, NOW))).toEqual([
      { source: "app", id: "0001_x.sql", problem: "name" },
      { source: "app", id: "0001_x.sql", problem: "unmarked" },
    ]);
  });

  test("a failed fetch is not kept: the next call fetches again", async () => {
    let failing = true;
    const { run: inner, calls } = fakeGit(SQL_TREE);
    const run = async (args: readonly string[]) => {
      if (args[0] === "fetch" && failing) {
        failing = false;
        throw new Error("network blip");
      }
      return inner(args);
    };
    const read = gitMainReader({
      run,
      fetch: "always",
      folders: { app: { path: "db/mig", layout: "sql" } },
    });
    await expect(read("app")).rejects.toThrow("cannot fetch origin/main — network blip");
    expect(await read("app")).toEqual(sql(MAIN));
    expect(calls.filter((c) => c[0] === "fetch")).toHaveLength(1);
  });

  test("a shell error's stderr is kept and credentials are masked", async () => {
    const run = async () => {
      throw Object.assign(new Error("Failed with exit code 128"), {
        stderr: enc.encode("fatal: unable to access 'https://user:tok3n@gitremote/r.git/'\n"),
      });
    };
    const err = await gitMainReader({ run, fetch: "always", folders: {} })("x").catch((e) => e);
    expect(err.message).toMatch(/no folder for source "x"/);
    const read = gitMainReader({
      run,
      fetch: "always",
      folders: { x: { path: "m", layout: "sql" } },
    });
    const fetchErr = await read("x").catch((e) => e);
    expect(fetchErr.message).toContain(
      "Failed with exit code 128: fatal: unable to access 'https://***@gitremote/r.git/'",
    );
    expect(fetchErr.message).not.toContain("tok3n");
  });

  test("a bad folder is refused before any fetch", async () => {
    const { run, calls } = fakeGit(SQL_TREE);
    await expect(
      gitMainReader({ run, fetch: "always", folders: { app: { path: "", layout: "sql" } } })("app"),
    ).rejects.toThrow(/folder path must be relative/);
    expect(calls).toEqual([]);
  });

  test("reads are bounded: never more than a few git processes at once", async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 40; i++) tree[`m/2026100100${String(i).padStart(4, "0")}_f.sql`] = A;
    const { run: inner } = fakeGit(tree);
    let live = 0;
    let peak = 0;
    const run = async (args: readonly string[]) => {
      live++;
      peak = Math.max(peak, live);
      await Promise.resolve();
      try {
        return await inner(args);
      } finally {
        live--;
      }
    };
    await gitMainReader({ run, fetch: "never", folders: { app: { path: "m", layout: "sql" } } })(
      "app",
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
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
    expect(bare(await checkMigrationOrder(SLICE, [tracked(branch)], read, NOW))).toEqual([
      { source: "app", id: "0003_c.sql", problem: "name" },
      { source: "app", id: "0003_c.sql", problem: "older-than-main" },
    ]);
  });
});
