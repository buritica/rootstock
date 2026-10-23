import { describe, expect, test } from "bun:test";
import { rootstockSource } from "./apply.ts";
import { migrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import {
  migrationStatus,
  renderMigrationStatus,
  type SourceStatus,
  summarizeStatus,
} from "./status.ts";
import { drizzleTracker, type TrackedSource } from "./tracked.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

function source(name: string, over: Partial<SourceStatus> = {}): SourceStatus {
  return {
    source: name,
    tracked: true,
    hashTracking: true,
    applied: [],
    pending: [],
    ahead: [],
    tampered: [],
    accepted: [],
    unknown: [],
    duplicate: [],
    outOfOrder: [],
    unhashed: [],
    ...over,
  };
}

const pending = (id: string): SourceMigration => ({
  source: "app",
  id,
  key: id,
  sha256: H1,
  kind: "additive",
  baselined: false,
  statements: [],
});

const status = summarizeStatus;

describe("renderMigrationStatus", () => {
  test("golden: every segment, then both remedy lines", () => {
    const s = status([
      source("rootstock", { applied: ["20261020000000_schema_migrations.sql"] }),
      source("app", {
        applied: ["0000_a", "0001_b", "0003_d"],
        pending: [pending("0002_c"), pending("0004_e")],
        ahead: ["1700000000009"],
        tampered: [{ id: "0001_b", recorded: H1, current: H2, acceptedCurrent: H3 }],
        accepted: [
          { id: "0000_a", recorded: H2, current: H3, reason: "comment only", stale: false },
          { id: "0003_d", recorded: H2, current: H3, reason: "reformatted", stale: true },
        ],
        unknown: [{ rowId: 7, hash: "x" }],
        duplicate: ["1700000000001"],
        outOfOrder: ["0002_c"],
      }),
      source("auth", {
        applied: ["20260101000000_u.sql"],
        hashTracking: false,
        unhashed: ["20260101000000_u.sql"],
        accepted: [
          { id: "20260101000000_u.sql", recorded: H1, current: H2, reason: "census", stale: false },
        ],
      }),
      source("ops", { ahead: ["20270101000000_x.sql"] }),
    ]);
    expect(renderMigrationStatus(s, { fix: "bun run migrate --manual" })).toBe(
      [
        "rootstock: ok (1 applied)",
        "app: behind: 0002_c, 0004_e; ahead: 1700000000009; TAMPERED: 0001_b recorded 11111111 now 22222222; accepted: 0000_a (comment only), 0003_d (reformatted) STALE; unknown rows: 7; duplicate keys: 1700000000001; out of order: 0002_c",
        "auth: ok (1 applied); accepted: 20260101000000_u.sql (census); hashes not yet stamped: 1",
        "ops: ahead: 20270101000000_x.sql",
        "fix: bun run migrate --manual",
        "ahead: fix forward with a deploy that carries app/1700000000009, ops/20270101000000_x.sql; do not run the migrate command",
        "",
      ].join("\n"),
    );
  });

  test("a stale acceptance alone is not ok, and needs neither remedy", () => {
    const s = status([
      source("app", {
        applied: ["0000_a"],
        accepted: [{ id: "0000_a", recorded: H1, current: H2, reason: "r", stale: true }],
      }),
    ]);
    expect(s.red).toBe(true);
    expect(renderMigrationStatus(s, { fix: "f" })).toBe("app: accepted: 0000_a (r) STALE\n");
  });

  test("ahead only: the deploy remedy, never the migrate command", () => {
    const out = renderMigrationStatus(status([source("app", { ahead: ["9"] })]), { fix: "f" });
    expect(out).not.toContain("fix: f");
    expect(out).toContain("do not run the migrate command");
  });

  test("refuses an empty fix command", () => {
    expect(() => renderMigrationStatus(status([source("app")]), { fix: " " })).toThrow(
      "renderMigrationStatus: opts.fix must be a non-empty command",
    );
  });
});

describe("summarizeStatus", () => {
  const stale = { id: "a", recorded: H1, current: H2, reason: "r", stale: true };
  test.each([
    ["nothing", {}, {}],
    ["pending", { pending: [pending("a")] }, { behind: true }],
    ["ahead", { ahead: ["9"] }, { ahead: true }],
    ["tampered", { tampered: [{ id: "a", recorded: H1, current: H2 }] }, { tampered: true }],
    ["unknown", { unknown: [{ rowId: 1, hash: "h" }] }, { trackerRot: true }],
    ["duplicate", { duplicate: ["1"] }, { trackerRot: true }],
    ["stale acceptance", { accepted: [stale] }, { trackerRot: true }],
    ["fresh acceptance", { accepted: [{ ...stale, stale: false }] }, {}],
    ["out of order and unhashed alone", { outOfOrder: ["a"], unhashed: ["a"] }, {}],
  ] as [string, Partial<SourceStatus>, Record<string, boolean>][])("%s", (_l, over, flags) => {
    const s = summarizeStatus([source("x"), source("app", over)]);
    const want = { behind: false, ahead: false, tampered: false, trackerRot: false, ...flags };
    expect({ ...s, sources: undefined }).toEqual({
      sources: undefined,
      ...want,
      red: Object.values(want).some(Boolean),
    });
  });
});

describe("migrationStatus", () => {
  test("refuses bad sources before any read", async () => {
    const sql = Object.assign(
      async () => {
        throw new Error("read");
      },
      { unsafe: async () => Promise.reject(new Error("read")) },
    );
    const slice = migrateSlice({});
    const app = { name: "app", tracker: drizzleTracker(), migrations: [] };
    for (const [sources, code] of [
      [[app], "ERR_ROOTSTOCK_MIG_SRC_ORDER"],
      [[rootstockSource(slice), app, { ...app }], "ERR_ROOTSTOCK_MIG_SRC_DUP"],
      [[], "ERR_ROOTSTOCK_MIG_SRC"],
    ] as const) {
      await expect(
        migrationStatus(sql as never, slice, sources as unknown as TrackedSource[]),
      ).rejects.toMatchObject({ code });
    }
  });
});
