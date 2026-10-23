import { describe, expect, test } from "bun:test";
import { MIGRATE_USAGE, type MigrateCliDeps, migrateCli } from "./cli.ts";

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
