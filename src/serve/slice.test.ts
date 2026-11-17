import { describe, expect, test } from "bun:test";
import { SERVE_INPUT } from "./fixtures.test-support.ts";
import { type ServeSlice, type ServeSliceInput, serveSlice } from "./slice.ts";

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
const BUCKET = { capacity: 1, refillPerSecond: 1, maxKeys: 1 };

describe("serveSlice", () => {
  test("parses every number as given, deep-frozen", () => {
    const s = serveSlice(SERVE_INPUT);
    expect({ ...s }).toEqual(SERVE_INPUT as never);
    const { limits } = s;
    for (const part of [
      s,
      s.bodyLimit,
      s.shutdown,
      limits,
      limits.refusal,
      limits.serving,
      limits.perTool,
      limits.perTool.lookup,
      limits.concurrency,
      limits.concurrency.pair,
      limits.concurrency.pair?.tools,
      limits.turnBudget,
      s.probes,
    ]) {
      expect(part).not.toBeNull();
      expect(Object.isFrozen(part)).toBe(true);
    }
  });

  test("its type is read-only all the way down, nullable members included", () => {
    // Never called: the checks are the compiler's.
    const _types = (s: ServeSlice) => {
      if (s.limits.refusal === null || s.limits.turnBudget === null) return;
      // @ts-expect-error a nullable bucket's numbers are read-only
      s.limits.refusal.capacity = 1;
      // @ts-expect-error so is the turn budget's
      s.limits.turnBudget.cap = 1;
      // @ts-expect-error and a group's tool list
      s.limits.concurrency.pair?.tools.push("gamma");
      // @ts-expect-error and the body limits
      s.bodyLimit.oauth = 1;
    };
    expect(typeof _types).toBe("function");
  });

  test("copies its input: a later change to the input does not reach the slice", () => {
    const tools = ["alpha"];
    const s = serveSlice(withLimits({ concurrency: { g: { tools, max: 1 } } }) as ServeSliceInput);
    tools.push("beta");
    expect(s.limits.concurrency.g?.tools).toEqual(["alpha"]);
  });

  test("a tool or group named __proto__ is kept as a name", () => {
    const perTool = JSON.parse(`{"__proto__": ${JSON.stringify(BUCKET)}}`);
    const concurrency = JSON.parse('{"__proto__": {"tools": ["alpha"], "max": 1}}');
    const s = serveSlice(withLimits({ perTool, concurrency }) as ServeSliceInput);
    expect(Object.hasOwn(s.limits.perTool, "__proto__")).toBe(true);
    expect(Object.keys(s.limits.perTool)).toEqual(["__proto__"]);
    expect(Object.hasOwn(s.limits.concurrency, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(s.limits.perTool)).toBe(Object.prototype);
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

  test("refuses unknown keys at every level", () => {
    const cases: [unknown, string][] = [
      [{ ...SERVE_INPUT, mcpPath: "/mcp" }, "mcpPath"],
      [
        { ...SERVE_INPUT, bodyLimit: { ...SERVE_INPUT.bodyLimit, service: 1 } },
        "bodyLimit.service",
      ],
      [{ ...SERVE_INPUT, shutdown: { ...SERVE_INPUT.shutdown, extra: 1 } }, "shutdown.extra"],
      [{ ...SERVE_INPUT, probes: { ...SERVE_INPUT.probes, retries: 1 } }, "probes.retries"],
      [{ ...SERVE_INPUT, limits: { ...SERVE_INPUT.limits, global: null } }, "limits.global"],
      [withLimits({ refusal: { ...BUCKET, burst: 1 } }), "limits.refusal.burst"],
      [withLimits({ perTool: { echo: { ...BUCKET, burst: 1 } } }), "limits.perTool.echo.burst"],
      [
        withLimits({ concurrency: { g: { tools: ["alpha"], max: 1, busy: "text" } } }),
        "limits.concurrency.g.busy",
      ],
      [
        withLimits({ turnBudget: { cap: 3, warnAt: 1, maxTurns: 9, exhausted: "text" } }),
        "limits.turnBudget.exhausted",
      ],
    ];
    for (const [input, path] of cases) {
      expect(refusal(input)).toBe(`serveSlice: ${path} is not a known key`);
    }
  });

  test("refuses a missing key at every level", () => {
    const { probes: _, ...noProbes } = SERVE_INPUT;
    expect(refusal(noProbes)).toBe("serveSlice: probes is required");
    expect(refusal({ ...SERVE_INPUT, deadlineMs: undefined })).toBe(
      "serveSlice: deadlineMs is required",
    );
    expect(refusal({ ...SERVE_INPUT, bodyLimit: { oauth: 1, bearer: 1, local: 1 } })).toBe(
      "serveSlice: bodyLimit.none is required",
    );
    expect(refusal(withLimits({ serving: { capacity: 1, refillPerSecond: 1 } }))).toBe(
      "serveSlice: limits.serving.maxKeys is required",
    );
    expect(refusal(null)).toBe("serveSlice: id is required");
  });

  test("refuses a non-object where an object belongs", () => {
    const cases: [unknown, string, string][] = [
      [{ ...SERVE_INPUT, shutdown: null }, "shutdown", "null"],
      [{ ...SERVE_INPUT, limits: "x" }, "limits", '"x"'],
      [{ ...SERVE_INPUT, bodyLimit: [] }, "bodyLimit", "[]"],
      [{ ...SERVE_INPUT, probes: 5 }, "probes", "5"],
      [withLimits({ concurrency: 1 }), "limits.concurrency", "1"],
      [withLimits({ perTool: [] }), "limits.perTool", "[]"],
      [withLimits({ refusal: "on" }), "limits.refusal", '"on"'],
      [withLimits({ turnBudget: [] }), "limits.turnBudget", "[]"],
      [withLimits({ concurrency: { g: 1 } }), "limits.concurrency.g", "1"],
    ];
    for (const [input, path, got] of cases) {
      expect(refusal(input)).toBe(`serveSlice: ${path} must be an object — got ${got}`);
    }
  });

  test("refuses a bad id or a bad top-level number", () => {
    for (const id of ["App", "", "-x", "a b", 7]) {
      expect(refusal({ ...SERVE_INPUT, id })).toBe(
        `serveSlice: id must be a string matching [a-z0-9][a-z0-9.-]* — got ${JSON.stringify(id)}`,
      );
    }
    expect(refusal({ ...SERVE_INPUT, bodyLimit: { ...SERVE_INPUT.bodyLimit, oauth: 1.5 } })).toBe(
      "serveSlice: bodyLimit.oauth must be an integer > 0 — got 1.5",
    );
    expect(refusal({ ...SERVE_INPUT, deadlineMs: 0 })).toBe(
      "serveSlice: deadlineMs must be an integer > 0 — got 0",
    );
    for (const idleTimeout of [0, 0.5, 256, Number.NaN, "30"]) {
      expect(refusal({ ...SERVE_INPUT, idleTimeout })).toMatch(
        /^serveSlice: idleTimeout must be an integer from 1 to 255 — got /,
      );
    }
    expect(serveSlice({ ...SERVE_INPUT, idleTimeout: 255 }).idleTimeout).toBe(255);
    expect(refusal({ ...SERVE_INPUT, shutdown: { ...SERVE_INPUT.shutdown, flushMs: -1 } })).toBe(
      "serveSlice: shutdown.flushMs must be a finite number >= 0 — got -1",
    );
    expect(refusal({ ...SERVE_INPUT, probes: { ...SERVE_INPUT.probes, timeoutMs: "1" } })).toBe(
      'serveSlice: probes.timeoutMs must be a finite number >= 0 — got "1"',
    );
  });

  test("refuses the limits' numbers the limiters would refuse", () => {
    expect(refusal(withLimits({ refusal: { ...BUCKET, capacity: 0 } }))).toBe(
      "serveSlice: limits.refusal.capacity must be a finite number > 0 — got 0",
    );
    expect(refusal(withLimits({ perTool: { echo: { ...BUCKET, refillPerSecond: 0 } } }))).toBe(
      "serveSlice: limits.perTool.echo.refillPerSecond must be a finite number > 0 — got 0",
    );
    expect(refusal(withLimits({ perTool: { "": BUCKET } }))).toMatch(
      /^serveSlice: limits\.perTool must be keyed by non-empty names — got /,
    );
    expect(refusal(withLimits({ concurrency: { "": { tools: ["alpha"], max: 1 } } }))).toMatch(
      /^serveSlice: limits\.concurrency must be keyed by non-empty names — got /,
    );
    for (const tools of [[], [1], [""], "alpha", null]) {
      expect(refusal(withLimits({ concurrency: { g: { tools, max: 1 } } }))).toBe(
        `serveSlice: limits.concurrency.g.tools must be a non-empty array of tool names — got ${JSON.stringify(tools)}`,
      );
    }
    expect(refusal(withLimits({ concurrency: { g: { tools: ["alpha"], max: 0 } } }))).toBe(
      "serveSlice: limits.concurrency.g.max must be an integer > 0 — got 0",
    );
    expect(refusal(withLimits({ turnBudget: { cap: 0, warnAt: 1, maxTurns: 1 } }))).toBe(
      "serveSlice: limits.turnBudget.cap must be an integer > 0 — got 0",
    );
    for (const warnAt of [-1, 2.5]) {
      expect(refusal(withLimits({ turnBudget: { cap: 3, warnAt, maxTurns: 1 } }))).toBe(
        `serveSlice: limits.turnBudget.warnAt must be an integer >= 0 — got ${warnAt}`,
      );
    }
    expect(refusal(withLimits({ turnBudget: { cap: 3, warnAt: 0, maxTurns: 0 } }))).toBe(
      "serveSlice: limits.turnBudget.maxTurns must be an integer > 0 — got 0",
    );
    expect(refusal(withLimits({ logIntervalMs: Number.POSITIVE_INFINITY }))).toBe(
      "serveSlice: limits.logIntervalMs must be a finite number >= 0 — got Infinity",
    );
  });

  test("refuses a tool listed twice in a group, or in two groups", () => {
    expect(refusal(withLimits({ concurrency: { g: { tools: ["alpha", "alpha"], max: 1 } } }))).toBe(
      'serveSlice: limits.concurrency.g.tools must be tools in one group only, each once (twice in this group) — got "alpha"',
    );
    expect(
      refusal(
        withLimits({
          concurrency: { g: { tools: ["alpha"], max: 1 }, h: { tools: ["beta", "alpha"], max: 2 } },
        }),
      ),
    ).toBe(
      'serveSlice: limits.concurrency.h.tools must be tools in one group only, each once (also in group g) — got "alpha"',
    );
  });
});
