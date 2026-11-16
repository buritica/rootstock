import { describe, expect, test } from "bun:test";
import { msUntilToken, refillTokens } from "./token-bucket-math.ts";

// The formulas the shared math replaces, spelled as each bucket wrote them.
const pacerRefill = (tokens: number, elapsedMs: number, rate: number, cap: number) =>
  Math.min(cap, tokens + Math.max(0, (elapsedMs / 1000) * rate));
const pacerWait = (tokens: number, rate: number) => Math.ceil(((1 - tokens) / rate) * 1000);
// An inbound limiter that never clamped.
const unclamped = (tokens: number, elapsedMs: number, rate: number, cap: number) =>
  Math.min(cap, tokens + (elapsedMs / 1000) * rate);
// An inbound limiter that clamped the elapsed seconds before multiplying.
const clampFirst = (tokens: number, elapsedMs: number, rate: number, cap: number) =>
  Math.min(cap, tokens + Math.max(0, elapsedMs / 1000) * rate);

const RATES = [1, 2, 3, 7, 0.5, 10 / 60, 1 / 3, 20, 120, 0.001];
const CAPS = [1, 2, 3, 10, 30, 60, 120];
const TOKENS = [0, 0.1, 1 / 3, 0.5, 0.999, 1, 1.5, 2.25, 9, 29.75];
const ELAPSED = [0, 1, 7, 33, 100, 333, 999, 1000, 1001, 6000, 59_999, 3_600_000];

function* grid() {
  for (const r of RATES)
    for (const c of CAPS)
      for (const t of TOKENS) if (t <= c) for (const e of ELAPSED) yield [t, e, r, c] as const;
}

describe("refillTokens", () => {
  test("is the pacer's own arithmetic, bit for bit", () => {
    const diffs = [...grid()].filter(
      ([t, e, r, c]) => !Object.is(refillTokens(t, e, r, c), pacerRefill(t, e, r, c)),
    );
    expect(diffs).toEqual([]);
  });

  test("for a clock that never steps back the clamp changes nothing", () => {
    const diffs = [...grid()].filter(
      ([t, e, r, c]) =>
        !Object.is(refillTokens(t, e, r, c), unclamped(t, e, r, c)) ||
        !Object.is(refillTokens(t, e, r, c), clampFirst(t, e, r, c)),
    );
    expect(diffs).toEqual([]);
  });

  test("a clock that steps back refills nothing, where no clamp would remove tokens", () => {
    for (const [t, e, r, c] of grid()) {
      if (e === 0) continue;
      expect(refillTokens(t, -e, r, c)).toBe(Math.min(c, t));
      expect(unclamped(t, -e, r, c)).toBeLessThan(refillTokens(t, -e, r, c));
    }
  });

  test("never passes capacity", () => {
    expect(refillTokens(0, 3_600_000, 5, 10)).toBe(10);
    expect(refillTokens(9.5, 200, 5, 10)).toBe(10);
  });
});

describe("msUntilToken", () => {
  test("is the pacer's own arithmetic, bit for bit", () => {
    for (const r of RATES)
      for (const t of TOKENS)
        if (t < 1) expect(Object.is(msUntilToken(t, r), pacerWait(t, r))).toBe(true);
  });

  test("rounds up to whole milliseconds", () => {
    expect(msUntilToken(0, 3)).toBe(334);
    expect(msUntilToken(0.5, 1)).toBe(500);
    expect(msUntilToken(0, 10 / 60)).toBe(6000);
  });
});
