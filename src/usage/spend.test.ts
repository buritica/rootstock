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

/** A store whose "today" is the server's day, set by the test, apart from the app clock. */
function serverDayStore() {
  const totals = new Map<string, number>();
  let day = 0;
  const key = (caller: string) => `${day}|${caller}`;
  const gates: (() => void)[] = [];
  let hold = false;
  const store: SpendStore = {
    units: ["tokens"],
    async load(caller) {
      return totals.get(key(caller)) ?? 0;
    },
    add(caller, _unit, amount) {
      // Commits when issued, on the server's day then; a held answer arrives later.
      const k = key(caller);
      const next = (totals.get(k) ?? 0) + Number(amount);
      totals.set(k, next);
      if (!hold) return Promise.resolve(next);
      return new Promise((resolve) => gates.push(() => resolve(next)));
    },
  };
  return {
    store,
    setDay: (d: number) => {
      day = d;
    },
    seed: (caller: string, n: number) => totals.set(key(caller), n),
    holdAdds: (on: boolean) => {
      hold = on;
    },
    /** Delivers the held answers, newest first when `reverse`. */
    releaseAdds: (reverse = false) => {
      const held = gates.splice(0);
      for (const go of reverse ? held.reverse() : held) go();
    },
  };
}

describe("createSpendCeiling", () => {
  test("idle() resolves once every write issued so far has settled, a failed one included", async () => {
    const m = memoryStore();
    const gates: (() => void)[] = [];
    const slow: SpendStore = {
      ...m.store,
      add: (caller, unit, amount) =>
        new Promise<void>((r) => gates.push(r)).then(() => m.store.add(caller, unit, amount)),
    };
    const { charger } = ceiling(slow);
    await charger.idle?.(); // nothing in flight
    const c = charger.forCaller("user-1");
    void c.record(usage(10));
    void c.record(usage(5));
    let idled = false;
    const idle = charger.idle?.().then(() => {
      idled = true;
    });
    await Bun.sleep(1);
    expect(idled).toBe(false);
    gates[0]?.();
    await Bun.sleep(1);
    expect(idled).toBe(false);
    m.failNextAdd();
    gates[1]?.();
    await idle;
    expect(idled).toBe(true);
    expect(m.totals.get("user-1|tokens")).toBe(10);
  });

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
    // Marked for the client: serve's toolThrow "generic" passes it through.
    expect((err as Record<symbol, unknown>)[Symbol.for("rootstock.clientFacing")]).toBe(true);
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
        fields: { caller: "user-1", unit: "tokens", amount: 70, errorClass: "CONNECTION_ENDED" },
      },
    ]);
    await c.record(usage(30)); // the store holds 30, the cache 100
    expect(m.totals.get("user-1|tokens")).toBe(30);
    expect(events.at(-1)).toEqual({
      event: "usage.spend_write_recovered",
      fields: { caller: "user-1" },
    });
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
    expect(events).toEqual([
      { event: "usage.spend_unpriced", fields: { caller: "user-1", model: "model-x" } },
    ]);
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

  test("app midnight before the server's: yesterday's total refuses once, then the next check reads today's", async () => {
    const s = serverDayStore();
    const { charger, clock } = ceiling(s.store);
    const c = charger.forCaller("user-1");
    s.seed("user-1", 150); // the server's yesterday
    clock.set(DAY * 20_001); // the app's midnight; the server has not turned yet
    await expect(c.assertWithin()).rejects.toThrow("budget reached (150/100)");
    s.setDay(1); // the server's midnight
    // Inside the second after a refusal: refused from the cache, no read.
    clock.set(DAY * 20_001 + 999);
    await expect(c.assertWithin()).rejects.toThrow("budget reached (150/100)");
    // A second later the refused caller reads again, and today's total sets the cache.
    clock.set(DAY * 20_001 + 1000);
    await c.assertWithin();
  });

  test("two adds answering out of order: the larger total stays, whichever arrives last", async () => {
    const m = memoryStore();
    const answers: ((n: number) => void)[] = [];
    const store: SpendStore = {
      ...m.store,
      add: () => new Promise<number>((resolve) => answers.push(resolve)),
    };
    const c = ceiling(store, { ceiling: 71 }).charger.forCaller("user-1");
    await c.assertWithin(); // loads 0
    const first = c.record(usage(40)); // issued first, commits second: answers 70
    const second = c.record(usage(30)); // issued second, commits first: answers 30
    answers[1]?.(30);
    await second;
    answers[0]?.(70);
    await first;
    await c.assertWithin(); // 70 < 71
    m.totals.set("user-1|tokens", 70);
    const third = c.record(usage(1));
    answers[2]?.(71);
    await third;
    await expect(c.assertWithin()).rejects.toThrow("budget reached (71/71)");
    // And the reverse arrival: a smaller answer landing last never lowers the cache.
    const c2 = ceiling(store, { ceiling: 71 }).charger.forCaller("user-2");
    await c2.assertWithin();
    const p1 = c2.record(usage(40));
    const p2 = c2.record(usage(31));
    answers[3]?.(71);
    await p1;
    answers[4]?.(31);
    await p2;
    await expect(c2.assertWithin()).rejects.toThrow("budget reached (71/71)");
  });

  test("a read issued before an add but answered after it never lowers the cache", async () => {
    const m = memoryStore();
    let answerLoad: (n: number) => void = () => {};
    const store: SpendStore = {
      ...m.store,
      load: () =>
        new Promise<number>((resolve) => {
          answerLoad = resolve;
        }),
      add: async () => 60,
    };
    const c = ceiling(store).charger.forCaller("user-1");
    const check = c.assertWithin(); // the read is issued
    await c.record(usage(60)); // an add issued after it answers 60 first
    answerLoad(10); // the read's older snapshot
    await check;
    await c.record(usage(0));
    // 60 from the add stands: a 40-token add takes it to 100 locally.
    let answerAdd: (n: number) => void = () => {};
    (store as { add: SpendStore["add"] }).add = () =>
      new Promise<number>((resolve) => {
        answerAdd = resolve;
      });
    const pending = c.record(usage(40));
    await expect(c.assertWithin()).rejects.toThrow("budget reached (100/100)");
    answerAdd(100);
    await pending;
  });

  test("a read issued after an add was applied sets the cache, even lower", async () => {
    const m = memoryStore();
    const { charger, clock } = ceiling(m.store);
    const c = charger.forCaller("user-1");
    await c.record(usage(100)); // the cache holds 100
    await expect(c.assertWithin()).rejects.toThrow(CeilingReached);
    m.totals.set("user-1|tokens", 20); // the store now says less (yesterday's row was read)
    clock.set(clock.now() + 1000);
    await c.assertWithin(); // the reload sets 20
  });

  test("concurrent checks of one caller share one read", async () => {
    const m = memoryStore();
    let answer: (n: number) => void = () => {};
    let loads = 0;
    const store: SpendStore = {
      ...m.store,
      load: () => {
        loads++;
        return new Promise<number>((resolve) => {
          answer = resolve;
        });
      },
    };
    const c = ceiling(store).charger.forCaller("user-1");
    const checks = [c.assertWithin(), c.assertWithin(), c.assertWithin()];
    answer(5);
    await Promise.all(checks);
    expect(loads).toBe(1);
    await c.assertWithin();
    expect(loads).toBe(1);
  });

  test("a refused caller is read again at most once a second, and refused from the cache in between", async () => {
    const m = memoryStore();
    const { charger, clock, events } = ceiling(m.store);
    const c = charger.forCaller("user-1");
    m.totals.set("user-1|tokens", 100);
    const t0 = clock.now();
    for (let i = 0; i < 5; i++) await expect(c.assertWithin()).rejects.toThrow(CeilingReached);
    expect(m.calls.load).toBe(1);
    clock.set(t0 + 1000);
    await expect(c.assertWithin()).rejects.toThrow(CeilingReached);
    expect(m.calls.load).toBe(2);
    clock.set(t0 + 1500);
    await expect(c.assertWithin()).rejects.toThrow(CeilingReached);
    expect(m.calls.load).toBe(2);
    // Logged once per caller per cache day.
    expect(events.filter((e) => e.event === "usage.spend_refused")).toEqual([
      {
        event: "usage.spend_refused",
        fields: { caller: "user-1", used: 100, ceiling: 100, unit: "tokens" },
      },
    ]);
  });

  test("record never rejects: a throwing clock or a malformed usage is logged", async () => {
    const m = memoryStore();
    const { log, events } = captureLog();
    const broken = createSpendCeiling({
      store: m.store,
      unit: "tokens",
      ceiling: 100,
      prices: null,
      refusal,
      errorClass: CeilingReached,
      clock: {
        now: () => {
          throw new Error("clock down");
        },
        monotonic: () => 0,
      },
      log,
    });
    await broken.forCaller("user-1").record(usage(5));
    expect(events).toEqual([
      { event: "usage.spend_record_failed", fields: { caller: "user-1", errorClass: "Error" } },
    ]);
    const { charger, events: ev2 } = ceiling(m.store);
    await charger.forCaller("user-1").record(null as never);
    await charger.forCaller("user-1").record({ model: "m", input: "1", output: 0 } as never);
    const hostile = Object.defineProperty({}, "input", {
      get() {
        throw new Error("gotcha");
      },
    });
    await charger.forCaller("user-1").record(hostile as never);
    expect(ev2.map((e) => e.event)).toEqual([
      "usage.spend_bad_usage",
      "usage.spend_bad_usage",
      "usage.spend_record_failed",
    ]);
  });

  test("the day boundary: a millisecond before midnight is still today, midnight starts a new cache", async () => {
    const m = memoryStore();
    const { charger, clock } = ceiling(m.store);
    const c = charger.forCaller("user-1");
    const midnight = DAY * 20_001;
    clock.set(midnight - 2);
    await c.assertWithin();
    clock.set(midnight - 1);
    await c.assertWithin();
    expect(m.calls.load).toBe(1);
    clock.set(midnight);
    await c.assertWithin();
    expect(m.calls.load).toBe(2);
  });

  test("a write still pending across the rollover does not reach the new day's cache", async () => {
    const s = serverDayStore();
    const { charger, clock } = ceiling(s.store);
    const c = charger.forCaller("user-1");
    const midnight = DAY * 20_001;
    clock.set(midnight - 1);
    s.seed("user-1", 90);
    await c.assertWithin();
    s.holdAdds(true);
    const late = c.record(usage(60)); // yesterday's row, answers 150 after midnight
    clock.set(midnight);
    s.setDay(1);
    await c.assertWithin(); // a new day: reads today's 0
    s.holdAdds(false);
    s.releaseAdds();
    await late;
    await c.assertWithin(); // yesterday's 150 went to yesterday's entry only
  });

  test("a failed load rejects the check and the next check loads again", async () => {
    const m = memoryStore();
    let failLoad = true;
    const store: SpendStore = {
      ...m.store,
      load: async (caller, unit) => {
        if (failLoad) throw new Error("connection lost");
        return m.store.load(caller, unit);
      },
    };
    const c = ceiling(store).charger.forCaller("user-1");
    await expect(c.assertWithin()).rejects.toThrow("connection lost");
    failLoad = false;
    await c.assertWithin();
    expect(m.calls.load).toBe(1);
  });

  test("a non-finite total from the store fails closed and is read again next time", async () => {
    const m = memoryStore();
    let answer = Number.NaN;
    const store: SpendStore = { ...m.store, load: async () => answer };
    const c = ceiling(store).charger.forCaller("user-1");
    await expect(c.assertWithin()).rejects.toThrow(/not a finite number/);
    answer = 5;
    await c.assertWithin();
  });

  test("usd: an unpriced model is never charged and is logged once per model per day (fail open, decided)", async () => {
    const m = memoryStore();
    const { charger, events, clock } = ceiling(m.store, {
      unit: "usd",
      ceiling: 1,
      prices: runsSlice(RUNS_INPUT),
    });
    const c = charger.forCaller("user-1");
    for (let i = 0; i < 3; i++) await c.record(usage(10_000_000, 10_000_000, "model-x"));
    expect(m.calls.add).toBe(0);
    await c.record(usage(1, 1, "model-y"));
    await charger.forCaller("user-2").record(usage(1, 1, "model-x"));
    expect(events.map((e) => [e.event, e.fields.model])).toEqual([
      ["usage.spend_unpriced", "model-x"],
      ["usage.spend_unpriced", "model-y"],
    ]);
    clock.set(clock.now() + DAY);
    await c.record(usage(1, 1, "model-x"));
    expect(events).toHaveLength(3);
    await c.assertWithin();
  });

  test("refuses a ceiling it cannot keep", () => {
    const tokensOnly = memoryStore(["tokens"]).store;
    const bad: Partial<Parameters<typeof createSpendCeiling>[0]>[] = [
      { unit: "eur" as never },
      { unit: "usd", store: tokensOnly, prices: runsSlice(RUNS_INPUT) },
      { unit: "usd", prices: null },
      { unit: "usd", prices: { ...runsSlice(RUNS_INPUT) } as never },
      { prices: {} as never },
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
