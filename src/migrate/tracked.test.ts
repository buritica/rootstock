import { describe, expect, test } from "bun:test";
import { migrateSlice } from "./slice.ts";
import { drizzleTracker, filenameTracker, trackerTable } from "./tracked.ts";

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
