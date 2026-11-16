import { describe, expect, test } from "bun:test";
import { RUNS_INPUT } from "../runs/fixtures.test-support.ts";
import { runsSlice } from "../runs/index.ts";
import type { CallSink, UsageWiring } from "../serve/types.ts";
import { errorClassOf } from "./error-class.ts";
import { usageErrorCode } from "./errors.ts";
import { callPricer, usageWiring } from "./wiring.ts";

const prices = runsSlice(RUNS_INPUT);

describe("callPricer", () => {
  test("prices with the runs table, as a run with the same tokens would cost", () => {
    const price = callPricer(prices);
    expect(price({ "model-a": { input: 1_000_000, output: 1_000_000 } }, false)).toEqual({
      costUsd: "0.500000",
      costNote: null,
    });
    expect(price({ "model-c": { input: 45, output: 0 } }, true)).toEqual({
      costUsd: "0.000032",
      costNote: "estimated",
    });
    expect(
      price(
        {
          zz: { input: 1, output: 1 },
          "model-a": { input: 1, output: 0 },
          aa: { input: 1, output: 0 },
        },
        false,
      ),
    ).toEqual({
      costUsd: null,
      costNote: "unpriced:aa,zz",
    });
  });

  test("fractional or negative estimated counts are rounded, floored at 0, and priced", () => {
    const price = callPricer(prices);
    expect(price({ "model-c": { input: 44.6, output: -3 } }, true)).toEqual({
      costUsd: "0.000032",
      costNote: "estimated",
    });
    expect(price({ "model-a": { input: Number.NaN, output: 0.4 } }, true)).toEqual({
      costUsd: "0.000000",
      costNote: "estimated",
    });
  });

  test("no prices: unpriced with the models sorted", () => {
    expect(
      callPricer(null)(
        { "model-b": { input: 1, output: 0 }, "model-a": { input: 1, output: 0 } },
        true,
      ),
    ).toEqual({
      costUsd: null,
      costNote: "unpriced:model-a,model-b",
    });
  });

  test("unpriced models are listed sorted on both paths", () => {
    const tokens = {
      zeta: { input: 1, output: 0 },
      alpha: { input: 1, output: 0 },
      "model-a": { input: 1, output: 0 },
    };
    expect(callPricer(null)(tokens, false).costNote).toBe("unpriced:alpha,model-a,zeta");
    expect(callPricer(prices)(tokens, false).costNote).toBe("unpriced:alpha,zeta");
  });

  test("nothing metered: no cost and no note, priced or not, and no throw", () => {
    expect(callPricer(prices)({}, false)).toEqual({ costUsd: null, costNote: null });
    expect(callPricer(null)({}, true)).toEqual({ costUsd: null, costNote: null });
  });
});

describe("usageWiring", () => {
  test("binds pricing and classification, frozen", () => {
    const sink: CallSink = { record: () => {} };
    const w: UsageWiring = usageWiring({
      sinks: [sink],
      keepArgs: true,
      keepOutput: false,
      prices,
      spend: null,
      serverSha: "abc",
    });
    expect(w.sinks).toEqual([sink]);
    expect([w.keepArgs, w.keepOutput, w.spend, w.serverSha]).toEqual([true, false, null, "abc"]);
    expect(w.errorClassOf).toBe(errorClassOf);
    expect(w.price({}, true)).toEqual({ costUsd: null, costNote: null });
    expect(w.price({ "model-a": { input: 10, output: 0 } }, false)).toEqual({
      costUsd: "0.000001",
      costNote: null,
    });
    expect(Object.isFrozen(w)).toBe(true);
    expect(Object.isFrozen(w.sinks)).toBe(true);
    expect("prices" in w).toBe(false);
  });

  test("refuses a wiring that is not one", () => {
    for (const bad of [
      { sinks: null, keepArgs: true, keepOutput: true },
      { sinks: [], keepArgs: "yes", keepOutput: true },
      { sinks: [], keepArgs: true, keepOutput: undefined },
    ]) {
      let caught: unknown;
      try {
        usageWiring({ ...bad, prices: null, spend: null, serverSha: null } as never);
      } catch (err) {
        caught = err;
      }
      expect(usageErrorCode(caught)).toBe("ERR_ROOTSTOCK_USAGE_CONFIG");
    }
  });
});
