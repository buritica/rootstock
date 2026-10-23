import { describe, expect, test } from "bun:test";
import * as concurrency from "../concurrency/index.ts";
import * as db from "../db/index.ts";
import * as migrate from "../migrate/index.ts";
import { defineRootstockConfig } from "./compose.ts";
import { composeRootstockConfig, type RootstockConfigInput } from "./define.ts";
import { printRootstockConfig } from "./print.ts";
import type { SliceParsers } from "./slices.ts";

const profile = {
  max: 5,
  maxCeiling: 20,
  idleTimeoutSeconds: 20,
  maxLifetimeSeconds: 600,
  connectTimeoutSeconds: 30,
  prepare: "driver-default",
  keepAliveSeconds: "driver-default",
  statementTimeoutMs: 0,
  readOnly: false,
} as const;

const input = {
  client: { profiles: { app: profile } },
  migrate: {},
  concurrency: { widths: { fetch: { default: 2, max: 4 } } },
} as RootstockConfigInput;

const parsers: SliceParsers = {
  clientSlice: db.clientSlice,
  migrateSlice: migrate.migrateSlice,
  concurrencySlice: concurrency.concurrencySlice,
};

describe("defineRootstockConfig", () => {
  test("uses the subpaths' own parsers", () => {
    expect(printRootstockConfig(defineRootstockConfig(input))).toBe(
      printRootstockConfig(composeRootstockConfig(parsers, input)),
    );
  });

  test("a slice parser's refusal reaches the caller unchanged", () => {
    expect(() =>
      defineRootstockConfig({ ...input, migrate: { ahead: "refuse" } as never }),
    ).toThrow("migrateSlice: ahead is not a known key");
  });
});

describe("composed with the real slice parsers", () => {
  test("the composed client slice is still the parser's own, branded slice", () => {
    const config = composeRootstockConfig(parsers, input);
    expect(db.postgresJsOptions(config.client, "app")).toEqual({
      max: 5,
      idle_timeout: 20,
      max_lifetime: 600,
      connect_timeout: 30,
    });
  });

  test("the composed concurrency slice is still the parser's own, branded slice", () => {
    const config = composeRootstockConfig(parsers, input);
    expect(concurrency.width(config.concurrency, "fetch")).toBe(2);
  });

  test("the composed migrate slice is still the parser's own, branded slice", async () => {
    const config = composeRootstockConfig(parsers, input);
    const none = {
      schemaExists: false,
      relkind: null,
      hashType: null,
      keyType: null,
      idType: null,
    };
    const sql = Object.assign(async () => [none], { unsafe: async () => [] });
    const status = await migrate.rootstockMigrationStatus(sql as never, config.migrate);
    expect(status.schema).toBe("rootstock");
  });

  test("print spells out every field the real profile has", () => {
    const config = composeRootstockConfig(parsers, input);
    const printed = JSON.parse(printRootstockConfig(config)).client.profiles.app;
    expect(Object.keys(printed).sort()).toEqual(
      Object.keys(config.client.profiles.app ?? {}).sort(),
    );
  });
});
