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
  migrate: { ahead: "refuse" },
  concurrency: { widths: { fetch: { default: 2, max: 4 } } },
} as RootstockConfigInput;

const exported = {
  clientSlice: (db as Partial<SliceParsers>).clientSlice,
  migrateSlice: (migrate as Partial<SliceParsers>).migrateSlice,
  concurrencySlice: (concurrency as Partial<SliceParsers>).concurrencySlice,
};

describe("defineRootstockConfig", () => {
  test("uses the subpaths' own parsers, or refuses by name while one is missing", () => {
    const missing = Object.entries(exported).find(([, p]) => typeof p !== "function");
    if (missing) {
      expect(() => defineRootstockConfig(input)).toThrow(
        `defineRootstockConfig: ${missing[0]} is not exported by its subpath`,
      );
    } else {
      expect(printRootstockConfig(defineRootstockConfig(input))).toBe(
        printRootstockConfig(composeRootstockConfig(exported as SliceParsers, input)),
      );
    }
  });
});

describe("composed with the real clientSlice", () => {
  const parsers = {
    clientSlice: db.clientSlice,
    migrateSlice: (i: { schema?: string; ahead: string }) => ({
      schema: i.schema ?? "rootstock",
      ahead: i.ahead,
    }),
    concurrencySlice: (i: { widths: Record<string, unknown> }) => ({ widths: { ...i.widths } }),
  } as unknown as SliceParsers;

  test("the composed client slice is still the parser's own, branded slice", () => {
    const config = composeRootstockConfig(parsers, input);
    expect(db.postgresJsOptions(config.client, "app")).toEqual({
      max: 5,
      idle_timeout: 20,
      max_lifetime: 600,
      connect_timeout: 30,
    });
  });

  test("print spells out every field the real profile has", () => {
    const config = composeRootstockConfig(parsers, input);
    const printed = JSON.parse(printRootstockConfig(config)).client.profiles.app;
    expect(Object.keys(printed).sort()).toEqual(
      Object.keys(config.client.profiles.app ?? {}).sort(),
    );
  });
});
