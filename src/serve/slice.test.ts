import { describe, expect, test } from "bun:test";
import { type ServeSliceInput, serveSlice } from "./slice.ts";

const SERVE_INPUT: ServeSliceInput = {
  id: "app.http",
  bodyLimit: { oauth: 4_194_304, bearer: 9_437_184, local: 9_437_184, none: null },
  deadlineMs: 30_000,
  idleTimeout: 45,
  shutdown: { drainMs: 10_000, forceMs: 2_000, poolEndTimeoutS: 5, flushMs: 2_000 },
  limits: {
    refusal: { capacity: 20, refillPerSecond: 2, maxKeys: 4096 },
    serving: null,
    perTool: { search: { capacity: 10, refillPerSecond: 10 / 60, maxKeys: 4096 } },
    concurrency: { dedup: { tools: ["slow", "boom"], max: 1 } },
    turnBudget: { cap: 30, warnAt: 5, maxTurns: 2000 },
    logIntervalMs: 1000,
  },
  probes: { timeoutMs: 2000, cacheTtlMs: 5000, pendingMaxMs: 10_000 },
};

const refusal = (input: unknown): string => {
  try {
    serveSlice(input as ServeSliceInput);
  } catch (err) {
    return (err as Error).message;
  }
  return "parsed";
};

const withLimits = (over: Record<string, unknown>) => ({
  ...SERVE_INPUT,
  limits: { ...SERVE_INPUT.limits, ...over },
});

describe("serveSlice", () => {
  test("parses every number as given, deep-frozen", () => {
    const s = serveSlice(SERVE_INPUT);
    expect({ ...s }).toEqual(SERVE_INPUT as never);
    for (const part of [
      s,
      s.bodyLimit,
      s.shutdown,
      s.limits,
      s.limits.perTool,
      s.limits.perTool.search,
      s.limits.concurrency.dedup,
      s.limits.concurrency.dedup?.tools,
      s.probes,
    ]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  test("copies its input: a later change to the input does not reach the slice", () => {
    const tools = ["slow"];
    const s = serveSlice(withLimits({ concurrency: { g: { tools, max: 1 } } }) as ServeSliceInput);
    tools.push("boom");
    expect(s.limits.concurrency.g?.tools).toEqual(["slow"]);
  });

  test("null where a profile has none", () => {
    const s = serveSlice({
      ...SERVE_INPUT,
      deadlineMs: null,
      idleTimeout: null,
      bodyLimit: { oauth: null, bearer: null, local: null, none: null },
      limits: {
        refusal: null,
        serving: null,
        perTool: {},
        concurrency: {},
        turnBudget: null,
        logIntervalMs: 0,
      },
    });
    expect([s.deadlineMs, s.idleTimeout, s.limits.turnBudget, s.limits.refusal]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  test("refuses, in the parsers' order: unknown keys, required, values", () => {
    expect(refusal({ ...SERVE_INPUT, mcpPath: "/mcp" })).toBe(
      "serveSlice: mcpPath is not a known key",
    );
    const { probes: _, ...noProbes } = SERVE_INPUT;
    expect(refusal(noProbes)).toBe("serveSlice: probes is required");
    expect(refusal({ ...SERVE_INPUT, deadlineMs: undefined })).toBe(
      "serveSlice: deadlineMs is required",
    );
    expect(refusal({ ...SERVE_INPUT, id: "App" })).toBe(
      'serveSlice: id must be a string matching [a-z0-9][a-z0-9.-]* — got "App"',
    );
    expect(refusal({ ...SERVE_INPUT, bodyLimit: { oauth: 1, bearer: 1, local: 1 } })).toBe(
      "serveSlice: bodyLimit.none is required",
    );
    expect(refusal({ ...SERVE_INPUT, bodyLimit: { ...SERVE_INPUT.bodyLimit, oauth: 1.5 } })).toBe(
      "serveSlice: bodyLimit.oauth must be an integer > 0 — got 1.5",
    );
    expect(refusal({ ...SERVE_INPUT, deadlineMs: 0 })).toBe(
      "serveSlice: deadlineMs must be an integer > 0 — got 0",
    );
    expect(refusal({ ...SERVE_INPUT, idleTimeout: Number.NaN })).toBe(
      "serveSlice: idleTimeout must be a finite number > 0 — got NaN",
    );
    expect(refusal({ ...SERVE_INPUT, shutdown: { ...SERVE_INPUT.shutdown, flushMs: -1 } })).toBe(
      "serveSlice: shutdown.flushMs must be a finite number >= 0 — got -1",
    );
    expect(refusal({ ...SERVE_INPUT, shutdown: { ...SERVE_INPUT.shutdown, extra: 1 } })).toBe(
      "serveSlice: shutdown.extra is not a known key",
    );
    expect(refusal({ ...SERVE_INPUT, probes: { ...SERVE_INPUT.probes, timeoutMs: "1" } })).toBe(
      'serveSlice: probes.timeoutMs must be a finite number >= 0 — got "1"',
    );
    expect(refusal(null)).toBe("serveSlice: id is required");
  });

  test("refuses the limits' numbers the limiters would refuse", () => {
    expect(refusal(withLimits({ refusal: { capacity: 0, refillPerSecond: 1, maxKeys: 1 } }))).toBe(
      "serveSlice: limits.refusal.capacity must be a finite number > 0 — got 0",
    );
    expect(refusal(withLimits({ serving: { capacity: 1, refillPerSecond: 1 } }))).toBe(
      "serveSlice: limits.serving.maxKeys is required",
    );
    expect(
      refusal(withLimits({ perTool: { echo: { capacity: 1, refillPerSecond: 0, maxKeys: 1 } } })),
    ).toBe("serveSlice: limits.perTool.echo.refillPerSecond must be a finite number > 0 — got 0");
    expect(refusal(withLimits({ perTool: [] }))).toBe(
      "serveSlice: limits.perTool must be an object — got []",
    );
    expect(refusal(withLimits({ concurrency: { g: { tools: [], max: 1 } } }))).toBe(
      "serveSlice: limits.concurrency.g.tools must be a non-empty array of tool names — got []",
    );
    expect(refusal(withLimits({ concurrency: { g: { tools: ["slow"], max: 0 } } }))).toBe(
      "serveSlice: limits.concurrency.g.max must be an integer > 0 — got 0",
    );
    expect(
      refusal(withLimits({ concurrency: { g: { tools: ["slow"], max: 1, busy: "text" } } })),
    ).toBe("serveSlice: limits.concurrency.g.busy is not a known key");
    expect(refusal(withLimits({ turnBudget: { cap: 30, warnAt: -1, maxTurns: 1 } }))).toBe(
      "serveSlice: limits.turnBudget.warnAt must be an integer >= 0 — got -1",
    );
    expect(refusal(withLimits({ turnBudget: { cap: 30, warnAt: 5, maxTurns: 0 } }))).toBe(
      "serveSlice: limits.turnBudget.maxTurns must be an integer > 0 — got 0",
    );
    expect(refusal(withLimits({ logIntervalMs: Number.POSITIVE_INFINITY }))).toBe(
      "serveSlice: limits.logIntervalMs must be a finite number >= 0 — got Infinity",
    );
  });
});
