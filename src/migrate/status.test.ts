import { describe, expect, test } from "bun:test";
import type { SourceMigration } from "./sources.ts";
import { type MigrationStatus, renderMigrationStatus, type SourceStatus } from "./status.ts";

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

function status(sources: SourceStatus[]): MigrationStatus {
  const behind = sources.some((s) => s.pending.length > 0);
  const ahead = sources.some((s) => s.ahead.length > 0);
  const tampered = sources.some((s) => s.tampered.length > 0);
  const trackerRot = sources.some(
    (s) => s.unknown.length > 0 || s.duplicate.length > 0 || s.accepted.some((a) => a.stale),
  );
  return {
    sources,
    behind,
    ahead,
    tampered,
    trackerRot,
    red: behind || ahead || tampered || trackerRot,
  };
}

describe("renderMigrationStatus", () => {
  test("golden: every segment, then both remedy lines", () => {
    const s = status([
      source("rootstock", { applied: ["20261020000000_schema_migrations.sql"] }),
      source("app", {
        applied: ["0000_a", "0001_b", "0003_d"],
        pending: [pending("0002_c"), pending("0004_e")],
        ahead: ["1700000000009"],
        tampered: [{ id: "0001_b", recorded: H1, current: H2 }],
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
        "app: behind: 0002_c, 0004_e; ahead: 1700000000009; TAMPERED: 0001_b recorded 11111111 now 22222222; unknown rows: 7; duplicate keys: 1700000000001; accepted: 0000_a (comment only), 0003_d (reformatted) STALE; out of order: 0002_c",
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
});
