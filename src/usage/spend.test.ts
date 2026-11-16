import { describe, expect, test } from "bun:test";
import { RUNS_INPUT } from "../runs/fixtures.test-support.ts";
import { runsSlice } from "../runs/index.ts";
import { usageErrorCode } from "./errors.ts";
import { captureLog, manualClock } from "./fixtures.test-support.ts";
import { createSpendCeiling, type SpendStore, type SpendUnit } from "./spend.ts";

class CeilingReached extends Error {}
const refusal = (used: number, ceiling: number) => `budget reached (${used}/${ceiling})`;
const DAY = 86_400_000;

/** An in-memory store: totals by caller and unit, one shared map. */
function memoryStore(units: readonly SpendUnit[] = ["tokens", "usd"]) {
  const totals = new Map<string, number>();
  const calls = { load: 0, add: 0 };
  let failNext = false;
  const store: SpendStore = {
    units,
    async load(caller, unit) {
      calls.load++;
      return totals.get(`${caller}|${unit}`) ?? 0;
    },
    async add(caller, unit, amount) {
      calls.add++;
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("connection lost"), { code: "CONNECTION_ENDED" });
      }
      const k = `${caller}|${unit}`;
      const next = (totals.get(k) ?? 0) + Number(amount);
      totals.set(k, next);
      return next;
    },
  };
  return {
    store,
    totals,
    calls,
    failNextAdd: () => {
      failNext = true;
    },
  };
}

function ceiling(store: SpendStore, over: Partial<Parameters<typeof createSpendCeiling>[0]> = {}) {
  const { log, events } = captureLog();
  const clock = manualClock(DAY * 20_000 + 1000);
  const charger = createSpendCeiling({
    store,
    unit: "tokens",
    ceiling: 100,
    prices: null,
    refusal,
    errorClass: CeilingReached,
    clock,
    log,
    ...over,
  });
  return { charger, events, clock };
}

const usage = (input: number, output = 0, model = "model-a") => ({ model, input, output });

describe("createSpendCeiling", () => {
  test("refuses once the total reaches the ceiling, with the consumer's error and text", async () => {
    const m = memoryStore();
    const c = ceiling(m.store).charger.forCaller("user-1");
    await c.assertWithin();
    await c.record(usage(60, 39));
    await c.assertWithin();
    await c.record(usage(1));
    const err = await c.assertWithin().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CeilingReached);
    expect((err as Error).message).toBe("budget reached (100/100)");
    expect(m.calls.load).toBe(1);
  });

  test("a mid-call check sees the call's own earlier meter, before its write lands", async () => {
    let release = () => {};
    const m = memoryStore();
    const slow: SpendStore = {
      ...m.store,
      add: (caller, unit, amount) =>
        new Promise((resolve) => {
          release = () => resolve(m.store.add(caller, unit, amount));
        }),
    };
    const c = ceiling(slow).charger.forCaller("user-1");
    await c.assertWithin();
    const write = c.record(usage(150)); // not awaited: the meter is synchronous
    const err = await c.assertWithin().then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toBe("budget reached (150/100)");
    release();
    await write;
    expect(m.totals.get("user-1|tokens")).toBe(150);
  });

  test("two ceilings on one store share the total", async () => {
    const m = memoryStore();
    const a = ceiling(m.store).charger.forCaller("user-1");
    const b = ceiling(m.store).charger.forCaller("user-1");
    await a.record(usage(40));
    await b.assertWithin(); // loads 40
    await b.record(usage(40)); // the store answers 80
    await a.record(usage(10)); // the store answers 90: a learns b's spend
    await a.record(usage(10));
    await expect(a.assertWithin()).rejects.toThrow("budget reached (100/100)");
    // b learns a's later spend on its own next write, not before.
    await b.assertWithin();
    await b.record(usage(1));
    await expect(b.assertWithin()).rejects.toThrow("budget reached (101/100)");
  });

  test("callers are separate", async () => {
    const m = memoryStore();
    const ch = ceiling(m.store).charger;
    await ch.forCaller("user-1").record(usage(100));
    await expect(ch.forCaller("user-1").assertWithin()).rejects.toThrow(CeilingReached);
    await ch.forCaller("user-2").assertWithin();
  });

  test("a failed write is logged and its amount stays in the cache", async () => {
    const m = memoryStore();
    const { charger, events } = ceiling(m.store);
    const c = charger.forCaller("user-1");
    await c.assertWithin();
    m.failNextAdd();
    await c.record(usage(70));
    expect(events).toEqual([
      {
        event: "usage.spend_write_failed",
        fields: { unit: "tokens", errorClass: "CONNECTION_ENDED" },
      },
    ]);
    await c.record(usage(30)); // the store holds 30, the cache 100
    expect(m.totals.get("user-1|tokens")).toBe(30);
    await expect(c.assertWithin()).rejects.toThrow("budget reached (100/100)");
  });

  test("a new UTC day reads the store again", async () => {
    const m = memoryStore();
    const { charger, clock } = ceiling(m.store);
    const c = charger.forCaller("user-1");
    await c.record(usage(100));
    await expect(c.assertWithin()).rejects.toThrow(CeilingReached);
    m.totals.clear(); // the store's row for the new day is empty
    clock.set(clock.now() + DAY);
    await c.assertWithin();
    expect(m.calls.load).toBe(1);
  });

  test("usd charges the priced cost; an unpriced model is logged and charges nothing", async () => {
    const m = memoryStore();
    const { charger, events } = ceiling(m.store, {
      unit: "usd",
      ceiling: 1,
      prices: runsSlice(RUNS_INPUT),
    });
    const c = charger.forCaller("user-1");
    await c.record(usage(1_000_000, 1_000_000)); // 0.1 + 0.4
    expect(m.totals.get("user-1|usd")).toBe(0.5);
    await c.record(usage(5, 5, "model-x"));
    expect(events).toEqual([{ event: "usage.spend_unpriced", fields: { model: "model-x" } }]);
    await c.record(usage(5_000_000));
    await expect(c.assertWithin()).rejects.toThrow("budget reached (1/1)");
  });

  test("zero and malformed usage write nothing", async () => {
    const m = memoryStore();
    const { charger, events } = ceiling(m.store);
    const c = charger.forCaller("user-1");
    await c.record(usage(0));
    await c.record(usage(1.5));
    await c.record(usage(-1));
    expect(m.calls.add).toBe(0);
    expect(events.map((e) => e.event)).toEqual(["usage.spend_bad_usage", "usage.spend_bad_usage"]);
  });

  test("refuses a ceiling it cannot keep", () => {
    const tokensOnly = memoryStore(["tokens"]).store;
    const bad: Partial<Parameters<typeof createSpendCeiling>[0]>[] = [
      { unit: "eur" as never },
      { unit: "usd", store: tokensOnly, prices: runsSlice(RUNS_INPUT) },
      { unit: "usd", prices: null },
      { ceiling: 0 },
      { ceiling: Number.NaN },
    ];
    for (const over of bad) {
      let caught: unknown;
      try {
        ceiling(memoryStore().store, over);
      } catch (err) {
        caught = err;
      }
      expect(usageErrorCode(caught)).toBe("ERR_ROOTSTOCK_USAGE_CONFIG");
    }
  });
});
