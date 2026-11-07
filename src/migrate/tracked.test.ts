import { describe, expect, test } from "bun:test";
import { migrateSlice } from "./slice.ts";
import { applyOrder, drizzleTracker, filenameTracker, trackerTable } from "./tracked.ts";

describe("tracker factories", () => {
  test("default to each origin's own table", () => {
    expect(drizzleTracker()).toEqual({
      kind: "drizzle",
      schema: "drizzle",
      table: "__drizzle_migrations",
    });
    expect(filenameTracker()).toEqual({
      kind: "filename",
      schema: "public",
      table: "schema_migrations",
    });
    expect(Object.isFrozen(drizzleTracker())).toBe(true);
    expect(Object.isFrozen(filenameTracker({ table: "t" }))).toBe(true);
  });

  test("take a schema and table, each defaulting on its own", () => {
    expect(drizzleTracker({ schema: "auth_drizzle" })).toEqual({
      kind: "drizzle",
      schema: "auth_drizzle",
      table: "__drizzle_migrations",
    });
    expect(filenameTracker({ table: "auth_migrations" })).toEqual({
      kind: "filename",
      schema: "public",
      table: "auth_migrations",
    });
  });

  test.each([
    [() => drizzleTracker({ schema: "Drizzle" }), /drizzleTracker: options\.schema must match/],
    [() => filenameTracker({ table: "a;b" }), /filenameTracker: options\.table must match/],
    [() => filenameTracker({ table: "x".repeat(64) }), /at most 63 bytes/],
    [
      () => drizzleTracker({ tabel: "x" } as never),
      /drizzleTracker: options\.tabel is not a known key/,
    ],
    [() => filenameTracker("public" as never), /filenameTracker: options must be an object/],
  ])("refuse a bad option (%#)", (call, message) => {
    expect(call).toThrow(message);
  });

  test("an inherited option is ignored, as every slice parser ignores one", () => {
    expect(filenameTracker(Object.create({ table: "x" }))).toEqual(filenameTracker());
  });

  test("trackerTable resolves rootstock's own into the slice's schema", () => {
    const slice = migrateSlice({ schema: "rs" });
    expect(trackerTable({ kind: "rootstock" }, slice)).toEqual({
      schema: "rs",
      table: "schema_migrations",
    });
    expect(trackerTable(filenameTracker({ table: "app_migrations" }), slice)).toEqual({
      schema: "public",
      table: "app_migrations",
    });
    expect(trackerTable(drizzleTracker(), slice)).toEqual({
      schema: "drizzle",
      table: "__drizzle_migrations",
    });
  });
});

describe("applyOrder", () => {
  const m = (id: string, key: string) =>
    ({ source: "app", id, key, sha256: "", kind: null, baselined: false }) as never;
  const of = (kind: "drizzle" | "filename" | "rootstock") =>
    applyOrder({
      name: kind === "rootstock" ? "rootstock" : "app",
      migrations: [],
      tracker: kind === "rootstock" ? { kind } : { kind, schema: "s", table: "t" },
    });

  test("drizzle orders by key as an integer", () => {
    const order = of("drizzle");
    expect(order.of(m("0001_b", "900"))).toBe("900");
    expect(order.compare("900", "1000")).toBeLessThan(0);
    expect(order.compare("1000", "1000")).toBe(0);
  });

  test("filename and rootstock order by id, in code-unit order", () => {
    for (const kind of ["filename", "rootstock"] as const) {
      const order = of(kind);
      expect(order.of(m("20260101000100_a.sql", "0001_a.sql"))).toBe("20260101000100_a.sql");
      expect(order.compare("20260101000100_a.sql", "init.sql")).toBeLessThan(0);
    }
  });

  test("refuses a drizzle key that is not an integer, with the source code", () => {
    const err = (() => {
      try {
        of("drizzle").compare("0001_a.sql", "1000");
      } catch (e) {
        return e as { code?: string };
      }
    })();
    expect(err?.code).toBe("ERR_ROOTSTOCK_MIG_SRC");
  });
});
