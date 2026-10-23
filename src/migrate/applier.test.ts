import { describe, expect, test } from "bun:test";
import type { Transactor } from "../db/index.ts";
import { type ApplyOptions, applyMigrations } from "./applier.ts";
import { rootstockSource } from "./apply.ts";
import { type MigrateSlice, migrateSlice } from "./slice.ts";
import { drizzleTracker, filenameTracker, type TrackedSource } from "./tracked.ts";

// Every refusal here comes before the database is reached.

const untouched = (): never => {
  throw new Error("the database was reached");
};
const transactor = {
  id: "bun-sql",
  sql: Object.assign(untouched, { unsafe: untouched }),
  begin: untouched,
} as unknown as Transactor;
const slice = migrateSlice({});
const root = rootstockSource(slice);
const app: TrackedSource = { name: "app", tracker: drizzleTracker(), migrations: [] };
const ok = { entry: "deploy", backup: { skip: "x" }, fix: "f" } as ApplyOptions;

async function refusal(
  sources: unknown,
  opts: unknown,
  s: MigrateSlice = slice,
): Promise<[string, unknown]> {
  try {
    await applyMigrations(transactor, s, sources as TrackedSource[], opts as ApplyOptions);
  } catch (err) {
    return [(err as Error).message, (err as { code?: unknown }).code];
  }
  throw new Error("expected a refusal");
}

describe("applyMigrations options", () => {
  test.each([
    [{ backup: { skip: "x" }, fix: "f" }, "applyMigrations: options.entry is required"],
    [
      { ...ok, entry: "ci" },
      'applyMigrations: options.entry must be "deploy" or "manual" — got "ci"',
    ],
    [
      { ...ok, backup: { skip: "x", run: async () => {} } },
      'applyMigrations: options.backup must be exactly one of run or skip — got "both"',
    ],
    [
      { ...ok, backup: {} },
      'applyMigrations: options.backup must be exactly one of run or skip — got "neither"',
    ],
    [
      { ...ok, backup: { skip: " " } },
      'applyMigrations: options.backup.skip must be a non-empty reason — got " "',
    ],
    [
      { ...ok, backup: { run: 1 } },
      "applyMigrations: options.backup.run must be a function — got 1",
    ],
    [{ ...ok, fix: "" }, 'applyMigrations: options.fix must be a non-empty command — got ""'],
    [{ ...ok, planOnly: "yes" }, 'applyMigrations: options.planOnly must be a boolean — got "yes"'],
    [{ ...ok, onEvent: 1 }, "applyMigrations: options.onEvent must be a function — got 1"],
    [{ ...ok, ahead: "allow" }, "applyMigrations: options.ahead is not a known key"],
  ])("refuses %j", async (opts, message) => {
    expect(await refusal([root], opts)).toEqual([message, undefined]);
  });

  test("an unbranded slice is refused", async () => {
    const forged = Object.freeze({ schema: "r", accepted: [] }) as unknown as MigrateSlice;
    expect((await refusal([root], ok, forged))[0]).toBe(
      "applyMigrations: expected a MigrateSlice built by migrateSlice() — got an object that parser did not return",
    );
  });
});

describe("applyMigrations coded refusals before the database", () => {
  test("allowHeavy with entry deploy is E-MIG-DEPLOY-HEAVY and emits migrate.refused", async () => {
    const events: unknown[] = [];
    const opts = { ...ok, allowHeavy: true, onEvent: (e: unknown) => events.push(e) };
    expect(await refusal([root], opts)).toEqual([
      'rootstock migrate: options.allowHeavy is for entry "manual" only — a deploy never applies a heavy migration',
      "ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY",
    ]);
    expect(events).toEqual([{ type: "migrate.refused", code: "ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY" }]);
  });

  test("a source refusal emits migrate.refused", async () => {
    const events: unknown[] = [];
    await refusal([app, root], { ...ok, onEvent: (e: unknown) => events.push(e) });
    expect(events).toEqual([{ type: "migrate.refused", code: "ERR_ROOTSTOCK_MIG_SRC_ORDER" }]);
  });

  test("an async hook that rejects is not an unhandled rejection", async () => {
    let unhandled = 0;
    const count = (): void => {
      unhandled += 1;
    };
    process.on("unhandledRejection", count);
    try {
      await refusal([app, root], { ...ok, onEvent: async () => Promise.reject(new Error("hook")) });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off("unhandledRejection", count);
    }
    expect(unhandled).toBe(0);
  });
});

describe("applyMigrations sources", () => {
  test.each([
    ["none", [], "applyMigrations: sources must be a non-empty array — got []", undefined],
    [
      "rootstock not first",
      [app, root],
      'rootstock migrate: the first source must be rootstockSource(slice) — got "app"',
      "ERR_ROOTSTOCK_MIG_SRC_ORDER",
    ],
    [
      "a name twice",
      [root, app, { ...app, tracker: filenameTracker() }],
      'rootstock migrate: source name "app" is used by more than one source',
      "ERR_ROOTSTOCK_MIG_SRC_DUP",
    ],
    [
      "a table twice",
      [root, app, { ...app, name: "b" }],
      'rootstock migrate: tracker table "drizzle.__drizzle_migrations" is used by more than one source',
      "ERR_ROOTSTOCK_MIG_SRC_DUP",
    ],
    [
      "rootstock's tracker twice",
      [root, { ...root, name: "x", migrations: [] }],
      'rootstock migrate: tracker "rootstock" is used by more than one source',
      "ERR_ROOTSTOCK_MIG_SRC_DUP",
    ],
    [
      "a bad name",
      [root, { ...app, name: "App" }],
      'applyMigrations: sources[1].name must be a name matching [a-z][a-z0-9-]* — got "App"',
      undefined,
    ],
    [
      "another source's migration",
      [root, { ...app, migrations: root.migrations }],
      `rootstock migrate: sources[1].migrations must all be source "app"'s — got "${root.migrations[0]?.id}" of source "rootstock"`,
      "ERR_ROOTSTOCK_MIG_SRC",
    ],
  ])("%s", async (_label, sources, message, code) => {
    expect(await refusal(sources, ok)).toEqual([message, code]);
  });
});
