import { describe, expect, test } from "bun:test";
import { MIGRATE_USAGE, type MigrateCliDeps, migrateCli } from "./cli.ts";
import { reason } from "./errors.ts";
import { migrateSlice } from "./slice.ts";
import { drizzleTracker } from "./tracked.ts";

// Every case here exits before touching the transactor, which throws if used.
const untouched = new Proxy(
  {},
  {
    get() {
      throw new Error("the transactor was used");
    },
  },
);

function deps(lines: string[]): MigrateCliDeps {
  return {
    transactor: untouched as never,
    slice: untouched as never,
    sources: [],
    backup: { skip: "test" },
    fix: "bun run migrate apply --manual",
    out: (l) => lines.push(l),
  };
}

describe("migrateCli usage", () => {
  test.each([
    [[]],
    [["apply"]],
    [["apply", "--deploy", "--manual"]],
    [["apply", "--deploy", "--allow-heavy"]],
    [["apply", "--allow-heavy"]],
    [["apply", "--manual", "--manual"]],
    [["apply", "--allow-heavy", "--deploy"]],
    [["plan", "--manual"]],
    [["plan", "--deploy", "--deploy"]],
    [["status", "--deploy"]],
    [["statsu"]],
    [["--help"]],
  ])("%j prints usage and exits 2", async (argv) => {
    const lines: string[] = [];
    expect(await migrateCli(argv, deps(lines))).toBe(2);
    expect(lines).toEqual([MIGRATE_USAGE]);
  });
});

describe("migrateCli deps and status refusals", () => {
  test("a caller bug throws before any I/O", async () => {
    await expect(migrateCli(["status"], { ...deps([]), fix: " " })).rejects.toThrow(
      "migrateCli: deps.fix must be",
    );
    await expect(migrateCli(["status"], { ...deps([]), out: undefined as never })).rejects.toThrow(
      "migrateCli: deps.out must be a function",
    );
  });

  test("a leading -- is ignored", async () => {
    const lines: string[] = [];
    expect(await migrateCli(["--", "statsu"], deps(lines))).toBe(2);
    expect(lines).toEqual([MIGRATE_USAGE]);
  });

  test("status turns a coded refusal (bad sources) into 2, could not answer", async () => {
    const lines: string[] = [];
    const code = await migrateCli(["status"], {
      ...deps(lines),
      transactor: { sql: {} } as never,
      slice: migrateSlice({}),
      sources: [{ name: "app", tracker: drizzleTracker(), migrations: [] }],
    });
    expect(code).toBe(2);
    expect(lines).toEqual([
      'status could not answer — rootstock migrate: the first source must be rootstockSource(slice) — got "app"',
    ]);
  });
});

describe("reason redacts credentials", () => {
  test.each([
    ["connect to postgres://u:p@ss@dbhost/x failed", "connect to postgres://***@dbhost/x failed"],
    ["host=db password=s3cr3t dbname=x", "host=db password=*** dbname=x"],
    ["no secret here", "no secret here"],
  ])("%s", (text, want) => {
    expect(reason(new Error(text))).toBe(want);
  });

  test("an AggregateError with no message names its parts", () => {
    expect(reason(new AggregateError([new Error("a"), new Error("b")], ""))).toBe("a; b");
  });
});
