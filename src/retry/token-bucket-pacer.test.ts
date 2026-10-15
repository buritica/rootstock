import { describe, expect, test } from "bun:test";
import { createTokenBucketPacer } from "./token-bucket-pacer.ts";

// A fake clock: sleeping advances it by exactly the requested time and settles immediately, so
// every wait the pacer asks for is observable as a literal. A pacer that spins (a rounding bug
// asking for 0 ms forever) hits the sleep cap and fails its case instead of hanging the suite.
const SLEEP_CAP = 1000;

function fakeClock(startMs = 1_000_000) {
  const state = { t: startMs, nowCalls: 0, sleeps: [] as number[] };
  return {
    state,
    now: () => {
      state.nowCalls++;
      return state.t;
    },
    sleep: async (ms: number) => {
      if (state.sleeps.length >= SLEEP_CAP) throw new Error("fake clock: sleep cap exceeded");
      state.sleeps.push(ms);
      state.t += ms;
    },
    advance: (ms: number) => {
      state.t += ms;
    },
  };
}

describe("createTokenBucketPacer: construction", () => {
  const refusals: [label: string, rate: number, got: string][] = [
    ["zero", 0, "0"],
    ["negative", -1, "-1"],
    ["NaN", Number.NaN, "NaN"],
    ["Infinity", Number.POSITIVE_INFINITY, "Infinity"],
    ["negative Infinity", Number.NEGATIVE_INFINITY, "-Infinity"],
  ];
  for (const [label, rate, got] of refusals) {
    test(`refuses ${label} before reading the clock`, () => {
      const clock = fakeClock();
      expect(() =>
        createTokenBucketPacer({
          ratePerSecond: rate,
          burst: 1,
          now: clock.now,
          sleep: clock.sleep,
        }),
      ).toThrow(
        new Error(`createTokenBucketPacer: ratePerSecond must be a positive number — got ${got}`),
      );
      expect(clock.state.nowCalls).toBe(0);
    });
  }

  test("reads the clock exactly once at creation", () => {
    const clock = fakeClock();
    createTokenBucketPacer({ ratePerSecond: 2, burst: 2, now: clock.now, sleep: clock.sleep });
    expect(clock.state.nowCalls).toBe(1);
  });

  test("exposes rate and burst, and is frozen", () => {
    const clock = fakeClock();
    const pacer = createTokenBucketPacer({
      ratePerSecond: 2.5,
      burst: 4,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(pacer.ratePerSecond).toBe(2.5);
    expect(pacer.burst).toBe(4);
    expect(Object.isFrozen(pacer)).toBe(true);
    expect(Object.keys(pacer).sort()).toEqual(["burst", "ratePerSecond", "take"]);
  });

  test("take works detached", async () => {
    const clock = fakeClock();
    const { take } = createTokenBucketPacer({
      ratePerSecond: 1,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    await take();
    await take();
    expect(clock.state.sleeps).toEqual([1000]);
  });
});

describe("createTokenBucketPacer: sequential spacing", () => {
  // Each take after the burst waits ceil((1 - tokens) / rate * 1000) ms; with burst 1 and an
  // empty bucket that is ceil(1000 / rate).
  const rows: [label: string, rate: number, takes: number, sleeps: number[]][] = [
    ["0.8 rps (1250 ms)", 0.8, 4, [1250, 1250, 1250]],
    ["0.3 rps rounds 3333.33 up to 3334", 0.3, 3, [3334, 3334]],
    ["5 rps (200 ms)", 5, 4, [200, 200, 200]],
    ["1 take never waits", 5, 1, []],
  ];
  for (const [label, rate, takes, sleeps] of rows) {
    test(label, async () => {
      const clock = fakeClock();
      const pacer = createTokenBucketPacer({
        ratePerSecond: rate,
        burst: 1,
        now: clock.now,
        sleep: clock.sleep,
      });
      for (let i = 0; i < takes; i++) await pacer.take();
      expect(clock.state.sleeps).toEqual(sleeps);
    });
  }

  test("the burst is spent without waiting, then the rate applies", async () => {
    const clock = fakeClock();
    const pacer = createTokenBucketPacer({
      ratePerSecond: 2,
      burst: 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 5; i++) await pacer.take();
    expect(clock.state.sleeps).toEqual([500, 500]);
  });
});

describe("createTokenBucketPacer: refill", () => {
  test("idle time refills up to burst and no further", async () => {
    const clock = fakeClock();
    const pacer = createTokenBucketPacer({
      ratePerSecond: 1,
      burst: 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    for (let i = 0; i < 3; i++) await pacer.take();
    expect(clock.state.sleeps).toEqual([]);
    clock.advance(10_000); // ten tokens' worth of idle, clamped to three
    for (let i = 0; i < 3; i++) await pacer.take();
    expect(clock.state.sleeps).toEqual([]);
    await pacer.take();
    expect(clock.state.sleeps).toEqual([1000]);
  });

  test("fractional refill: 600 ms idle leaves 0.6 tokens, so 400 ms more is needed", async () => {
    const clock = fakeClock();
    const pacer = createTokenBucketPacer({
      ratePerSecond: 1,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    await pacer.take();
    clock.advance(600);
    await pacer.take();
    expect(clock.state.sleeps).toEqual([400]);
  });

  test("a clock that runs backwards refills nothing and does not throw", async () => {
    const clock = fakeClock();
    const pacer = createTokenBucketPacer({
      ratePerSecond: 1,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    await pacer.take();
    clock.advance(-5000);
    await pacer.take();
    expect(clock.state.sleeps).toEqual([1000]);
  });
});

describe("createTokenBucketPacer: concurrency", () => {
  test("concurrent takes resolve in call order, one token each", async () => {
    const clock = fakeClock();
    const pacer = createTokenBucketPacer({
      ratePerSecond: 1,
      burst: 1,
      now: clock.now,
      sleep: clock.sleep,
    });
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((i) =>
        pacer.take().then(() => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3]);
    expect(clock.state.sleeps).toEqual([1000, 1000, 1000]);
  });

  test("a sleep that rejects once fails only that take; the next works", async () => {
    const state = { t: 0, calls: 0, sleeps: [] as number[] };
    const now = () => state.t;
    const sleep = async (ms: number) => {
      state.calls++;
      if (state.calls === 1) throw new Error("sleep boom");
      state.sleeps.push(ms);
      state.t += ms;
    };
    const pacer = createTokenBucketPacer({ ratePerSecond: 1, burst: 1, now, sleep });
    await pacer.take();
    await expect(pacer.take()).rejects.toThrow("sleep boom");
    await pacer.take();
    expect(state.sleeps).toEqual([1000]);
  });

  test("a rejection does not wedge takes queued behind it", async () => {
    const state = { t: 0, calls: 0, sleeps: [] as number[] };
    const now = () => state.t;
    const sleep = async (ms: number) => {
      state.calls++;
      if (state.calls === 1) throw new Error("sleep boom");
      state.sleeps.push(ms);
      state.t += ms;
    };
    const pacer = createTokenBucketPacer({ ratePerSecond: 1, burst: 1, now, sleep });
    await pacer.take();
    const settled = await Promise.allSettled([pacer.take(), pacer.take(), pacer.take()]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(state.sleeps).toEqual([1000, 1000]);
  });
});
