import { describe, expect, test } from "bun:test";
import { RUNS_INPUT } from "../runs/fixtures.test-support.ts";
import { defineRootstockConfig } from "./compose.ts";
import type { RootstockConfigInput } from "./define.ts";
import { printRootstockConfig } from "./print.ts";

// W5 contract §8: the usage slice in a config, its invariant and its print.

const PROFILE = {
  max: 1,
  maxCeiling: 1,
  idleTimeoutSeconds: "driver-default",
  maxLifetimeSeconds: "never",
  connectTimeoutSeconds: "driver-default",
  prepare: "driver-default",
  keepAliveSeconds: "driver-default",
  statementTimeoutMs: 0,
  readOnly: false,
} as const;

const BASE: RootstockConfigInput = {
  client: { profiles: { lock: PROFILE } },
  migrate: { schema: "app_rs" },
  concurrency: { widths: { fetch: { default: 1, max: 1 } } },
};

const WITH_RUNS: RootstockConfigInput = {
  ...BASE,
  lock: {
    profile: "lock",
    names: ["alpha-sync", "shared-write", "delta:*"],
    heartbeatSeconds: 5,
    probeStallSeconds: 15,
    maxRecoveries: 5,
    endTimeoutSeconds: 19,
    wait: { maxMs: 30000, pollIntervalMs: 1000 },
  },
  runs: RUNS_INPUT,
};

const USAGE = {
  callLog: { maxBuffered: 1000, maxBatch: 100 },
  keepArgs: true,
  keepOutput: true,
  spend: { unit: "tokens", ceiling: 2_000_000, store: { kind: "rootstock" } },
} as const;

describe("the usage slice in a config", () => {
  test("omitted: null, and the print has no usage key", () => {
    const c = defineRootstockConfig(BASE);
    expect(c.usage).toBeNull();
    expect(printRootstockConfig(c)).not.toContain('"usage"');
  });

  test("given: parsed with the migrate schema as its default, and printed", () => {
    const c = defineRootstockConfig({ ...BASE, usage: USAGE });
    expect(c.usage?.callLog?.table).toEqual({ schema: "app_rs", name: "mcp_calls" });
    expect(c.usage?.spend?.store).toEqual({ kind: "rootstock", schema: "app_rs" });
    expect(c.invariants).toEqual([]);
    expect(Object.isFrozen(c.usage?.spend)).toBe(true);
    const printed = JSON.parse(printRootstockConfig(c));
    expect(printed.usage).toEqual({
      callLog: { maxBatch: 100, maxBuffered: 1000, table: { name: "mcp_calls", schema: "app_rs" } },
      keepArgs: true,
      keepOutput: true,
      spend: { ceiling: 2_000_000, store: { kind: "rootstock", schema: "app_rs" }, unit: "tokens" },
    });
  });

  test("usage-spend-prices: dollars need the runs slice's prices", () => {
    const usd = { ...USAGE, spend: { ...USAGE.spend, unit: "usd", ceiling: 5 } } as const;
    expect(() => defineRootstockConfig({ ...BASE, usage: usd })).toThrow(
      'usage-spend-prices: usage.spend.unit "usd" needs the runs slice\'s prices',
    );
    expect(() =>
      defineRootstockConfig({ ...WITH_RUNS, runs: { ...RUNS_INPUT, prices: {} }, usage: usd }),
    ).toThrow(/usage-spend-prices/);
    const c = defineRootstockConfig({ ...WITH_RUNS, usage: usd });
    expect(c.invariants).toContain("usage-spend-prices");
    expect(defineRootstockConfig({ ...WITH_RUNS, usage: USAGE }).invariants).not.toContain(
      "usage-spend-prices",
    );
  });
});
