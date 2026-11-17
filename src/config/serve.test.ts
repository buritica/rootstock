import { describe, expect, test } from "bun:test";
import { SERVE_INPUT } from "../serve/fixtures.test-support.ts";
import { defineRootstockConfig } from "./compose.ts";
import type { RootstockConfigInput } from "./define.ts";
import { printRootstockConfig } from "./print.ts";

// W5 contract §8: the serve slice in a config, its invariants and its print.

const BASE: RootstockConfigInput = {
  client: {
    profiles: {
      app: {
        max: 5,
        maxCeiling: 5,
        idleTimeoutSeconds: 20,
        maxLifetimeSeconds: 600,
        connectTimeoutSeconds: 30,
        prepare: "driver-default",
        keepAliveSeconds: "driver-default",
        statementTimeoutMs: 0,
        readOnly: false,
      },
    },
  },
  migrate: {},
  concurrency: { widths: { fetch: { default: 1, max: 2 } } },
};

const SERVE = SERVE_INPUT;

describe("the serve slice in a config", () => {
  test("omitted: null, no serve invariant, and the print has no serve key", () => {
    const c = defineRootstockConfig(BASE);
    expect(c.serve).toBeNull();
    expect(c.invariants).toEqual([]);
    expect(printRootstockConfig(c)).not.toContain('"serve"');
  });

  test("given: parsed, both invariants run, and printed in full", () => {
    const c = defineRootstockConfig({ ...BASE, serve: SERVE });
    expect(c.invariants).toEqual(["serve-deadline-idle", "serve-probe-timeout"]);
    expect(Object.isFrozen(c.serve?.limits.perTool)).toBe(true);
    const printed = JSON.parse(printRootstockConfig(c));
    expect(printed.serve).toEqual({
      bodyLimit: { bearer: 131_072, local: 131_072, none: null, oauth: 65_536 },
      deadlineMs: 20_000,
      id: "app.http",
      idleTimeout: 30,
      limits: {
        concurrency: { pair: { max: 1, tools: ["alpha", "beta"] } },
        logIntervalMs: 500,
        perTool: { lookup: { capacity: 7, maxKeys: 512, refillPerSecond: 0.25 } },
        refusal: { capacity: 12, maxKeys: 256, refillPerSecond: 3 },
        serving: { capacity: 90, maxKeys: 256, refillPerSecond: 15 },
        turnBudget: { cap: 24, maxTurns: 500, warnAt: 4 },
      },
      probes: { cacheTtlMs: 4_000, pendingMaxMs: 8_000, timeoutMs: 1_500 },
      shutdown: { drainMs: 3_000, flushMs: 1_500, forceMs: 500, poolEndTimeoutS: 2 },
    });
  });

  test("serve-deadline-idle: the deadline ends before the listener's idle timeout", () => {
    expect(() =>
      defineRootstockConfig({ ...BASE, serve: { ...SERVE, deadlineMs: 30_000 } }),
    ).toThrow(
      "serve-deadline-idle: serve.deadlineMs 30000 must be below serve.idleTimeout 30 × 1000",
    );
    for (const over of [{ deadlineMs: null }, { idleTimeout: null }]) {
      const c = defineRootstockConfig({ ...BASE, serve: { ...SERVE, ...over } });
      expect(c.invariants).toEqual(["serve-probe-timeout"]);
    }
  });

  test("serve-probe-timeout: the probe timeout is below pendingMaxMs", () => {
    const probes = { timeoutMs: 10_000, cacheTtlMs: 5000, pendingMaxMs: 10_000 };
    expect(() => defineRootstockConfig({ ...BASE, serve: { ...SERVE, probes } })).toThrow(
      "serve-probe-timeout: serve.probes.timeoutMs 10000 must be below serve.probes.pendingMaxMs 10000",
    );
  });

  test("both failures are reported at once", () => {
    const bad = {
      ...SERVE,
      deadlineMs: 60_000,
      probes: { timeoutMs: 5, cacheTtlMs: 0, pendingMaxMs: 0 },
    };
    expect(() => defineRootstockConfig({ ...BASE, serve: bad })).toThrow(
      /2 invariant\(s\) failed — serve-deadline-idle: .*; serve-probe-timeout: /,
    );
  });

  test("a consumer invariant reusing a built-in serve id is refused", () => {
    expect(() =>
      defineRootstockConfig({
        ...BASE,
        serve: SERVE,
        invariants: [{ id: "serve-probe-timeout", check: () => null }],
      }),
    ).toThrow('invariant id "serve-probe-timeout" must match');
  });

  test("a slice parser's refusal reaches the caller unchanged", () => {
    expect(() =>
      defineRootstockConfig({ ...BASE, serve: { ...SERVE, mcpPath: "/mcp" } as never }),
    ).toThrow("serveSlice: mcpPath is not a known key");
  });
});
