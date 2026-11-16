import { describe, expect, test } from "bun:test";
import {
  createConcurrencyLimiter,
  createRateLimiter,
  createTurnBudget,
  exhaustedResult,
  rateLimitedLog,
  withCountdown,
} from "./limits.ts";
import type { Clock } from "./types.ts";

function fakeClock(
  start = 1_000_000,
): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    monotonic: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

describe("createRateLimiter", () => {
  test("spends capacity, then refills at the rate", () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 10, clock });
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.peek("a")).toBe(false);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true);
    clock.advance(999);
    expect(rl.peek("a")).toBe(false);
    clock.advance(1);
    expect(rl.peek("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
  });

  test("peek spends nothing and a fresh key holds capacity", () => {
    const rl = createRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      maxKeys: 10,
      clock: fakeClock(),
    });
    for (let i = 0; i < 5; i++) expect(rl.peek("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.peek("k")).toBe(false);
  });

  // The clamp is a no-op for every recorded case: an unclamped backwards step
  // could only remove tokens, never add any.
  test("a backwards clock step refills nothing and removes nothing; the refill time follows the clock", () => {
    const clock = fakeClock(10_000);
    const rl = createRateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 10, clock });
    expect(rl.allow("a")).toBe(true); // 1 left
    clock.set(5_000);
    expect(rl.allow("a")).toBe(true); // still had 1, now 0, at = 5000
    expect(rl.allow("a")).toBe(false);
    clock.set(6_000); // one second after the reset point, not after 10_000
    expect(rl.allow("a")).toBe(true);
  });

  test("prunes full buckets once past maxKeys", () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 2, clock });
    rl.allow("a");
    rl.allow("b");
    clock.advance(1_000);
    // a and b are full again, so both are dropped before c is added; a then starts full
    rl.allow("c");
    expect(rl.allow("a")).toBe(true);
  });

  test("allowN spends n at once; a refusal spends the whole tokens, as n single charges would", () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ capacity: 3, refillPerSecond: 1, maxKeys: 10, clock });
    expect(rl.allowN("a", 0)).toBe(true);
    expect(rl.allowN("a", 2)).toBe(true); // 1 left
    clock.advance(500); // 1.5
    expect(rl.allowN("a", 2)).toBe(false); // spends the 1, keeps the 0.5
    expect(rl.peek("a")).toBe(false);
    clock.advance(500);
    expect(rl.allow("a")).toBe(true);
  });

  test("prunes from the least recently touched end, stopping at the first bucket not yet full", () => {
    const clock = fakeClock();
    const rl = createRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 2, clock });
    rl.allow("a");
    clock.advance(1_000);
    rl.allow("b"); // a is full again, b is empty; order a, b
    rl.allow("c"); // prunes a, stops at b
    expect(rl.allow("b")).toBe(false);
    expect(rl.allow("a")).toBe(true);
  });

  for (const [field, bad] of [
    ["capacity", 0],
    ["refillPerSecond", Number.NaN],
    ["maxKeys", Number.POSITIVE_INFINITY],
    ["capacity", -1],
    ["refillPerSecond", "1"],
  ] as const) {
    test(`refuses ${field} = ${String(bad)}`, () => {
      const o = { capacity: 1, refillPerSecond: 1, maxKeys: 1, clock: fakeClock(), [field]: bad };
      expect(() => createRateLimiter(o as never)).toThrow(
        expect.objectContaining({ code: "ERR_ROOTSTOCK_SERVE_CONFIG" }),
      );
    });
  }
});

describe("createConcurrencyLimiter", () => {
  test("per key, refuses over max, idempotent release", () => {
    const c = createConcurrencyLimiter(1);
    const r1 = c.tryAcquire("a");
    expect(r1).toBeFunction();
    expect(c.tryAcquire("a")).toBeUndefined();
    expect(c.tryAcquire("b")).toBeFunction();
    r1?.();
    r1?.();
    const r2 = c.tryAcquire("a");
    expect(r2).toBeFunction();
    expect(c.tryAcquire("a")).toBeUndefined();
  });

  test("refuses a max that is not a positive integer", () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/max must be an integer > 0/);
    expect(() => createConcurrencyLimiter(1.5)).toThrow(/max must be an integer > 0/);
  });
});

describe("createTurnBudget", () => {
  test("counts per turn up to the cap, then exhausted", () => {
    const b = createTurnBudget({ cap: 2, maxTurns: 10 });
    const t = b.forTurn("t1");
    expect(t()).toEqual({ used: 1, remaining: 1, exhausted: false });
    expect(t()).toEqual({ used: 2, remaining: 0, exhausted: false });
    expect(t()).toEqual({ used: 3, remaining: 0, exhausted: true });
    expect(b.forTurn("t2")()).toEqual({ used: 1, remaining: 1, exhausted: false });
  });

  test("forgets the least recently charged turn past maxTurns", () => {
    const b = createTurnBudget({ cap: 5, maxTurns: 2 });
    b.forTurn("a")();
    b.forTurn("b")();
    b.forTurn("a")();
    b.forTurn("c")(); // evicts b
    expect(b.forTurn("a")().used).toBe(3);
    expect(b.forTurn("b")().used).toBe(1);
  });

  test("exhaustedResult and withCountdown", () => {
    const charge = { used: 31, remaining: 0, exhausted: true };
    expect(exhaustedResult(charge, (n) => `spent ${n}`)).toEqual({
      turnBudget: { remaining: 0, exhausted: true },
      message: "spent 30",
    });
    expect(withCountdown({ a: 1 }, { used: 25, remaining: 5, exhausted: false }, 5)).toEqual({
      a: 1,
    });
    expect(withCountdown({ a: 1 }, { used: 26, remaining: 4, exhausted: false }, 5)).toEqual({
      a: 1,
      turnBudget: { remaining: 4 },
    });
    expect(withCountdown([1], { used: 26, remaining: 4, exhausted: false }, 5)).toEqual([1]);
  });

  test("refuses a bad cap", () => {
    expect(() => createTurnBudget({ cap: 0, maxTurns: 1 })).toThrow(/cap must be/);
    expect(() => createTurnBudget({ cap: 1, maxTurns: 0 })).toThrow(/maxTurns must be/);
  });
});

test("rateLimitedLog throttles per bucket and counts what it suppressed", () => {
  const clock = fakeClock();
  const lines: [string, Record<string, unknown>][] = [];
  const log = rateLimitedLog((e, f) => lines.push([e, { ...f }]), clock, 1000);
  log("refusal", { sourceKey: "s" });
  log("refusal", { sourceKey: "s" });
  log("serving", { caller: "c" });
  log("refusal", { sourceKey: "s" });
  clock.advance(1000);
  log("refusal", { sourceKey: "s" });
  expect(lines).toEqual([
    ["serve.rate_limited", { sourceKey: "s", bucket: "refusal", suppressed: 0 }],
    ["serve.rate_limited", { caller: "c", bucket: "serving", suppressed: 0 }],
    ["serve.rate_limited", { sourceKey: "s", bucket: "refusal", suppressed: 2 }],
  ]);
});
