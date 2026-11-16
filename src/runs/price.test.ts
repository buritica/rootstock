import { describe, expect, test } from "bun:test";
import { RUNS_INPUT } from "./fixtures.test-support.ts";
import { priceTokens } from "./price.ts";
import { runsSlice } from "./slice.ts";

// priceTokens is the arithmetic the run record's cost uses (the RR5 cases in
// record.test.ts pin it through finish()); usage prices a tool call with it.

const slice = runsSlice(RUNS_INPUT);
const m = (entries: [string, number, number][]) =>
  new Map(entries.map(([model, input, output]) => [model, { input, output }]));
const metered = { metered: true, estimated: false };

describe("priceTokens", () => {
  test("unmetered wins over everything", () => {
    expect(priceTokens(slice, m([["model-x", 1, 1]]), { metered: false, estimated: true })).toEqual(
      { costUsd: null, costNote: "unmetered" },
    );
  });

  test("sums in micro-dollars and rounds half up once", () => {
    expect(priceTokens(slice, m([["model-c", 45, 0]]), metered)).toEqual({
      costUsd: "0.000032",
      costNote: null,
    });
    expect(
      priceTokens(
        slice,
        m([
          ["model-a", 1_000_000, 1_000_000],
          ["model-b", 2_000_000, 0],
        ]),
        metered,
      ),
    ).toEqual({ costUsd: "3.000000", costNote: null });
  });

  test("an empty map costs zero", () => {
    expect(priceTokens(slice, new Map(), metered)).toEqual({ costUsd: "0.000000", costNote: null });
  });

  test("estimated is noted only on a priced cost", () => {
    expect(priceTokens(slice, m([["model-a", 10, 0]]), { metered: true, estimated: true })).toEqual(
      { costUsd: "0.000001", costNote: "estimated" },
    );
    expect(
      priceTokens(
        slice,
        m([
          ["zz", 1, 0],
          ["model-a", 1, 0],
          ["aa", 1, 0],
        ]),
        {
          metered: true,
          estimated: true,
        },
      ),
    ).toEqual({ costUsd: null, costNote: "unpriced:aa,zz" });
  });

  test("the unpriced note is cut at 200 characters", () => {
    const note = priceTokens(slice, m([["x".repeat(300), 1, 0]]), metered).costNote as string;
    expect(note).toBe(`unpriced:${"x".repeat(200)}`);
  });

  test("refuses a slice runsSlice did not return", () => {
    expect(() => priceTokens({ ...slice }, new Map(), metered)).toThrow(/priceMicros/);
  });
});
