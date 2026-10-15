import { describe, expect, test } from "bun:test";
import {
  type AttemptOutcome,
  type ErrorOutcome,
  type PacedRetryOptions,
  pacedRetry,
} from "./paced-retry.ts";

type Step = AttemptOutcome<string> | { kind: "throw"; error: unknown };

const WHAT = "svc: conversations.history";
const HALT = " — halting rather than hammering";

const ok = (value = "v"): Step => ({ kind: "ok", value });
const rl = (waitMs: number): Step => ({ kind: "rate_limited", waitMs });
const transient = (error: unknown, status?: number | null): Step =>
  status === undefined ? { kind: "transient", error } : { kind: "transient", error, status };
const fatal = (error: unknown): Step => ({ kind: "fatal", error });
const thrown = (error: unknown): Step => ({ kind: "throw", error });

/** Everything observable goes into one ordered event log. */
function harness(
  steps: Step[],
  overrides: Partial<PacedRetryOptions<string>> & {
    budgets?: { maxAttempts: number; maxRateLimitWaits: number };
  } = {},
) {
  const events: string[] = [];
  let i = 0;
  const log = { sleeps: [] as number[], backoffCalls: [] as number[], performs: 0, takes: 0 };
  const options: PacedRetryOptions<string> = {
    what: WHAT,
    limiter: {
      take: async () => {
        log.takes++;
        events.push("take");
      },
    },
    budgets: { maxAttempts: 3, maxRateLimitWaits: 2 },
    sleep: async (ms) => {
      log.sleeps.push(ms);
      events.push(`sleep:${ms}`);
    },
    backoffMs: (attempt) => {
      log.backoffCalls.push(attempt);
      return attempt * 7;
    },
    perform: async () => {
      log.performs++;
      events.push("perform");
      const step = steps[i++];
      if (step === undefined) throw new Error("script exhausted");
      if (step.kind === "throw") throw step.error;
      return step;
    },
    classifyError: (err): ErrorOutcome => ({ kind: "fatal", error: err }),
    ...overrides,
  };
  return { options, events, log };
}

async function outcomeOf(p: Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

describe("pacedRetry: success and rate limits", () => {
  test("ok on the first attempt", async () => {
    const h = harness([ok("first")]);
    expect(await pacedRetry(h.options)).toBe("first");
    expect(h.log).toEqual({ sleeps: [], backoffCalls: [], performs: 1, takes: 1 });
  });

  test("rate-limit waits refund the attempt", async () => {
    // One attempt only, yet three waits are absorbed and the fourth perform succeeds.
    const h = harness([rl(100), rl(200), rl(300), ok("late")], {
      budgets: { maxAttempts: 1, maxRateLimitWaits: 3 },
    });
    expect(await pacedRetry(h.options)).toBe("late");
    expect(h.log.sleeps).toEqual([100, 200, 300]);
    expect(h.log.performs).toBe(4);
    expect(h.log.takes).toBe(4);
    expect(h.log.backoffCalls).toEqual([]);
  });

  test("the two budgets are separate", async () => {
    const h = harness([rl(1500), rl(2500), transient(new Error("503"), 503), ok("done")], {
      budgets: { maxAttempts: 2, maxRateLimitWaits: 3 },
    });
    expect(await pacedRetry(h.options)).toBe("done");
    expect(h.log.sleeps).toEqual([1500, 2500, 7]);
  });

  test("exhausts when waits exceed the budget", async () => {
    const h = harness([rl(10), rl(20), rl(30), ok()], {
      budgets: { maxAttempts: 5, maxRateLimitWaits: 2 },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toEqual(new Error(`${WHAT} rate-limited 3 times${HALT}`));
    expect(h.log.sleeps).toEqual([10, 20]);
    expect(h.log.performs).toBe(3);
  });

  test("a rate-limit budget of zero halts on the first throttle without waiting", async () => {
    const waits: number[] = [];
    const h = harness([rl(10), ok()], {
      budgets: { maxAttempts: 5, maxRateLimitWaits: 0 },
      onRateLimit: (info) => waits.push(info.waits),
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toEqual(new Error(`${WHAT} rate-limited 1 times${HALT}`));
    expect(h.log.sleeps).toEqual([]);
    expect(waits).toEqual([]);
  });

  test("the exhaustion message carries the caller's label verbatim", async () => {
    const h = harness([rl(1)], {
      what: "other prefix: files.list F1",
      budgets: { maxAttempts: 1, maxRateLimitWaits: 0 },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect((r.error as Error).message).toBe(
      `other prefix: files.list F1 rate-limited 1 times${HALT}`,
    );
  });
});

describe("pacedRetry: transient failures", () => {
  test("a custom curve is honored, called once per backoff, never on the last attempt", async () => {
    const e1 = new Error("e1");
    const e2 = new Error("e2");
    const e3 = new Error("e3");
    const h = harness([transient(e1), transient(e2), transient(e3)], {
      budgets: { maxAttempts: 3, maxRateLimitWaits: 0 },
      backoffMs: (a) => {
        h.log.backoffCalls.push(a);
        return a * 7;
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(e3);
    expect(h.log.backoffCalls).toEqual([1, 2]);
    expect(h.log.sleeps).toEqual([7, 14]);
  });

  test("the last transient rethrows by identity with no sleep", async () => {
    const err = new Error("boom");
    const h = harness([transient(err)], { budgets: { maxAttempts: 1, maxRateLimitWaits: 0 } });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(err);
    expect(h.log.sleeps).toEqual([]);
    expect(h.log.backoffCalls).toEqual([]);
  });

  test("a transient that recovers returns the value", async () => {
    const h = harness([transient(new Error("x")), ok("healed")]);
    expect(await pacedRetry(h.options)).toBe("healed");
    expect(h.log.sleeps).toEqual([7]);
  });

  test("onTransient status: missing, null and a number, with 0 kept", async () => {
    const seen: (number | null)[] = [];
    const h = harness(
      [
        transient(new Error("a")),
        transient(new Error("b"), null),
        transient(new Error("c"), 503),
        transient(new Error("d"), 0),
        ok(),
      ],
      {
        budgets: { maxAttempts: 5, maxRateLimitWaits: 0 },
        onTransient: (info) => seen.push(info.status),
      },
    );
    await pacedRetry(h.options);
    expect(seen).toEqual([null, null, 503, 0]);
  });

  test("onTransient receives the error, attempt and computed backoff", async () => {
    const infos: unknown[] = [];
    const e1 = new Error("e1");
    const e2 = new Error("e2");
    const h = harness([transient(e1, 502), transient(e2, 504), ok()], {
      onTransient: (info) => infos.push(info),
    });
    await pacedRetry(h.options);
    expect(infos).toEqual([
      { error: e1, status: 502, attempt: 1, backoffMs: 7 },
      { error: e2, status: 504, attempt: 2, backoffMs: 14 },
    ]);
  });
});

describe("pacedRetry: fatal and classified errors", () => {
  test("fatal is rethrown by identity, untouched, with no wait", async () => {
    const err = new Error("nope");
    const h = harness([fatal(err)]);
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(err);
    expect(h.log.sleeps).toEqual([]);
    expect(h.log.performs).toBe(1);
  });

  test("a non-Error fatal value is thrown as is", async () => {
    const h = harness([fatal("plain string")]);
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe("plain string");
  });

  test("a thrown error is classified: rate_limited", async () => {
    const h = harness([thrown(new Error("429")), ok("after")], {
      classifyError: () => ({ kind: "rate_limited", waitMs: 4000 }),
    });
    expect(await pacedRetry(h.options)).toBe("after");
    expect(h.log.sleeps).toEqual([4000]);
  });

  test("a thrown error is classified: transient", async () => {
    const err = new Error("net");
    const h = harness([thrown(err), ok("after")], {
      classifyError: (e) => ({ kind: "transient", error: e }),
    });
    expect(await pacedRetry(h.options)).toBe("after");
    expect(h.log.sleeps).toEqual([7]);
  });

  test("a thrown error is classified: fatal", async () => {
    const err = new Error("bad request");
    const h = harness([thrown(err)], {
      classifyError: (e) => ({ kind: "fatal", error: e }),
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(err);
  });

  test("the classifier sees the thrown value", async () => {
    const seen: unknown[] = [];
    const h = harness([thrown("a string"), thrown(null)], {
      classifyError: (e) => {
        seen.push(e);
        return { kind: "transient", error: e };
      },
      budgets: { maxAttempts: 2, maxRateLimitWaits: 0 },
    });
    await outcomeOf(pacedRetry(h.options));
    expect(seen).toEqual(["a string", null]);
  });

  test("classifier throw, error without a cause: original rethrown, classifier error becomes cause", async () => {
    const original = new Error("upstream 503");
    const classifierError = new Error("classifier bug");
    const h = harness([thrown(original)], {
      classifyError: () => {
        throw classifierError;
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(original);
    expect((r.error as Error).cause).toBe(classifierError);
    expect(h.log.sleeps).toEqual([]);
  });

  test("classifier throw, error with a cause: the existing cause is kept", async () => {
    const existing = new Error("root cause");
    const original = new Error("upstream", { cause: existing });
    const h = harness([thrown(original)], {
      classifyError: () => {
        throw new Error("classifier bug");
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(original);
    expect((r.error as Error).cause).toBe(existing);
  });

  test("classifier throw, thrown string: the string is rethrown, nothing attached", async () => {
    const h = harness([thrown("upstream said no")], {
      classifyError: () => {
        throw new Error("classifier bug");
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe("upstream said no");
  });
});

describe("pacedRetry: maxAttempts that is not a positive integer", () => {
  const rows: [
    label: string,
    maxAttempts: number,
    steps: Step[],
    performs: number,
    text: string,
  ][] = [
    ["0", 0, [], 0, "0"],
    ["-1", -1, [], 0, "-1"],
    ["NaN", Number.NaN, [], 0, "NaN"],
    ["1.5 falls through after one transient retry", 1.5, [transient(new Error("x"))], 1, "1.5"],
  ];
  for (const [label, maxAttempts, steps, performs, text] of rows) {
    test(label, async () => {
      const h = harness(steps, { budgets: { maxAttempts, maxRateLimitWaits: 0 } });
      const r = await outcomeOf(pacedRetry(h.options));
      expect(r.error).toEqual(new Error(`${WHAT} still failing after ${text} attempts${HALT}`));
      expect(h.log.performs).toBe(performs);
      expect(h.log.takes).toBe(performs);
    });
  }

  test("1.5 with an immediate ok still succeeds", async () => {
    const h = harness([ok("fine")], { budgets: { maxAttempts: 1.5, maxRateLimitWaits: 0 } });
    expect(await pacedRetry(h.options)).toBe("fine");
  });
});

describe("pacedRetry: event order and hooks", () => {
  test("beforeAttempt runs before take, on every attempt including refunded ones", async () => {
    const h = harness([rl(1500), transient(new Error("503"), 503), ok("end")], {
      budgets: { maxAttempts: 3, maxRateLimitWaits: 2 },
    });
    const events = h.events;
    await pacedRetry({
      ...h.options,
      beforeAttempt: () => events.push("before"),
      onSuccess: () => events.push("success"),
      onRateLimit: (info) => events.push(`rl:${info.waitMs}/${info.waits}`),
      onRateLimitExhausted: () => events.push("exhausted"),
      onTransient: (info) => events.push(`tr:${info.attempt}/${info.backoffMs}/${info.status}`),
    });
    expect(events).toEqual([
      "before",
      "take",
      "perform",
      "rl:1500/1",
      "sleep:1500",
      "before",
      "take",
      "perform",
      "tr:1/7/503",
      "sleep:7",
      "before",
      "take",
      "perform",
      "success",
    ]);
  });

  test("a beforeAttempt throw propagates by identity before any take", async () => {
    const abort = new Error("abort");
    const h = harness([ok()], {
      beforeAttempt: () => {
        throw abort;
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(abort);
    expect(h.log.takes).toBe(0);
    expect(h.log.performs).toBe(0);
  });

  test("a beforeAttempt throw on a later attempt stops the loop there", async () => {
    const abort = new Error("abort");
    let calls = 0;
    const h = harness([transient(new Error("x")), ok()], {
      beforeAttempt: () => {
        calls++;
        if (calls === 2) throw abort;
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(abort);
    expect(h.log.takes).toBe(1);
    expect(h.log.sleeps).toEqual([7]);
  });

  test("a beforeAttempt throw is not classified", async () => {
    let classified = 0;
    const h = harness([ok()], {
      beforeAttempt: () => {
        throw new Error("abort");
      },
      classifyError: (e) => {
        classified++;
        return { kind: "fatal", error: e };
      },
    });
    await outcomeOf(pacedRetry(h.options));
    expect(classified).toBe(0);
  });

  test("onSuccess fires once, and only on ok", async () => {
    let successes = 0;
    const onSuccess = () => successes++;
    await pacedRetry(harness([rl(1), transient(new Error("t")), ok()], { onSuccess }).options);
    expect(successes).toBe(1);

    successes = 0;
    await outcomeOf(pacedRetry(harness([fatal(new Error("f"))], { onSuccess }).options));
    await outcomeOf(
      pacedRetry(
        harness([transient(new Error("t"))], {
          onSuccess,
          budgets: { maxAttempts: 1, maxRateLimitWaits: 0 },
        }).options,
      ),
    );
    await outcomeOf(
      pacedRetry(
        harness([rl(1)], { onSuccess, budgets: { maxAttempts: 1, maxRateLimitWaits: 0 } }).options,
      ),
    );
    expect(successes).toBe(0);
  });

  test("onRateLimitExhausted gets the wait count before the throw", async () => {
    const events: string[] = [];
    const h = harness([rl(10), rl(20), rl(30)], {
      budgets: { maxAttempts: 5, maxRateLimitWaits: 2 },
      onRateLimitExhausted: (info) => events.push(`exhausted:${info.waits}`),
    });
    const r = await outcomeOf(
      pacedRetry({
        ...h.options,
        sleep: async (ms) => {
          events.push(`sleep:${ms}`);
        },
      }),
    );
    expect(events).toEqual(["sleep:10", "sleep:20", "exhausted:3"]);
    expect((r.error as Error).message).toBe(`${WHAT} rate-limited 3 times${HALT}`);
  });

  test("a throw from onRateLimitExhausted wins over the halting error", async () => {
    const hookError = new Error("hook says stop");
    const h = harness([rl(10)], {
      budgets: { maxAttempts: 5, maxRateLimitWaits: 0 },
      onRateLimitExhausted: () => {
        throw hookError;
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(hookError);
  });

  test("onRateLimitExhausted is not called while the budget holds", async () => {
    let calls = 0;
    const h = harness([rl(10), rl(20), ok("ok")], {
      budgets: { maxAttempts: 5, maxRateLimitWaits: 2 },
      onRateLimitExhausted: () => calls++,
    });
    expect(await pacedRetry(h.options)).toBe("ok");
    expect(calls).toBe(0);
  });

  test("hooks are optional, and so is every one of them being undefined", async () => {
    const h = harness([rl(1), transient(new Error("t")), ok("fine")], {
      beforeAttempt: undefined,
      onSuccess: undefined,
      onRateLimit: undefined,
      onRateLimitExhausted: undefined,
      onTransient: undefined,
    });
    expect(await pacedRetry(h.options)).toBe("fine");
  });

  test("the limiter is asked for a token on every attempt, retries included", async () => {
    const h = harness([rl(1), transient(new Error("t")), transient(new Error("t")), ok()], {
      budgets: { maxAttempts: 3, maxRateLimitWaits: 1 },
    });
    await pacedRetry(h.options);
    expect(h.log.takes).toBe(4);
  });

  test("a rejecting limiter fails the request without calling perform", async () => {
    const boom = new Error("limiter boom");
    const h = harness([ok()], {
      limiter: {
        take: async () => {
          throw boom;
        },
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(boom);
    expect(h.log.performs).toBe(0);
  });

  test("a rejecting sleep propagates", async () => {
    const boom = new Error("sleep boom");
    const h = harness([rl(1), ok()], {
      sleep: async () => {
        throw boom;
      },
    });
    const r = await outcomeOf(pacedRetry(h.options));
    expect(r.error).toBe(boom);
  });
});

describe("pacedRetry: call parity (`this`)", () => {
  test("limiter.take sees the limiter; the detached callables see undefined; hooks see options", async () => {
    const seen: Record<string, unknown[]> = {
      take: [],
      perform: [],
      classifyError: [],
      sleep: [],
      backoffMs: [],
      beforeAttempt: [],
      onSuccess: [],
      onRateLimit: [],
      onRateLimitExhausted: [],
      onTransient: [],
    };
    const limiter = {
      async take(this: unknown) {
        seen.take?.push(this);
      },
    };
    let n = 0;
    const options: PacedRetryOptions<string> = {
      what: WHAT,
      limiter,
      budgets: { maxAttempts: 3, maxRateLimitWaits: 1 },
      async sleep(this: unknown) {
        seen.sleep?.push(this);
      },
      backoffMs(this: unknown) {
        seen.backoffMs?.push(this);
        return 1;
      },
      async perform(this: unknown) {
        seen.perform?.push(this);
        n++;
        if (n === 1) return { kind: "rate_limited", waitMs: 1 };
        if (n === 2) throw new Error("net");
        if (n === 3) return { kind: "transient", error: new Error("t") };
        return { kind: "ok", value: "end" };
      },
      classifyError(this: unknown, err) {
        seen.classifyError?.push(this);
        return { kind: "transient", error: err };
      },
      beforeAttempt(this: unknown) {
        seen.beforeAttempt?.push(this);
      },
      onSuccess(this: unknown) {
        seen.onSuccess?.push(this);
      },
      onRateLimit(this: unknown) {
        seen.onRateLimit?.push(this);
      },
      onRateLimitExhausted(this: unknown) {
        seen.onRateLimitExhausted?.push(this);
      },
      onTransient(this: unknown) {
        seen.onTransient?.push(this);
      },
    };
    expect(await pacedRetry(options)).toBe("end");
    for (const t of seen.take ?? []) expect(t).toBe(limiter);
    for (const name of ["perform", "classifyError", "sleep", "backoffMs"]) {
      expect(seen[name]?.length, name).toBeGreaterThan(0);
      for (const t of seen[name] ?? []) expect(t, name).toBeUndefined();
    }
    for (const name of ["beforeAttempt", "onSuccess", "onRateLimit", "onTransient"]) {
      expect(seen[name]?.length, name).toBeGreaterThan(0);
      for (const t of seen[name] ?? []) expect(t, name).toBe(options);
    }

    // The exhaustion hook gets its own run, ending in a throttle that outlasts the budget.
    const exhausted: PacedRetryOptions<string> = {
      ...options,
      budgets: { maxAttempts: 1, maxRateLimitWaits: 0 },
      perform: async () => ({ kind: "rate_limited", waitMs: 1 }),
    };
    await outcomeOf(pacedRetry(exhausted));
    expect(seen.onRateLimitExhausted).toEqual([exhausted]);
  });

  test("hooks are read lazily, at the point of use", async () => {
    const log: string[] = [];
    const options = {
      ...harness([ok("v")]).options,
      get onSuccess() {
        log.push("read onSuccess");
        return () => log.push("call onSuccess");
      },
      get beforeAttempt() {
        log.push("read beforeAttempt");
        return () => log.push("call beforeAttempt");
      },
    };
    await pacedRetry(options);
    expect(log).toEqual([
      "read beforeAttempt",
      "call beforeAttempt",
      "read onSuccess",
      "call onSuccess",
    ]);
  });
});

describe("pacedRetry: concurrent envelopes interleave at the documented await points", () => {
  test("two requests sharing one log interleave one await step at a time", async () => {
    const log: string[] = [];
    const make = (id: string, steps: Step[]) => {
      let i = 0;
      return pacedRetry<string>({
        what: id,
        limiter: {
          take: async () => {
            log.push(`${id}:take`);
          },
        },
        budgets: { maxAttempts: 3, maxRateLimitWaits: 2 },
        sleep: async (ms) => {
          log.push(`${id}:sleep:${ms}`);
        },
        backoffMs: (a) => a * 7,
        perform: async () => {
          log.push(`${id}:perform`);
          const step = steps[i++];
          if (step === undefined || step.kind === "throw") throw new Error("bad script");
          return step;
        },
        classifyError: (error) => ({ kind: "fatal", error }),
      });
    };
    await Promise.all([
      make("A", [rl(5), ok("a")]),
      make("B", [transient(new Error("t")), ok("b")]),
    ]);
    // Each envelope awaits take, perform and sleep as separate microtask hops, so the two
    // requests alternate. The literal below pins that order.
    expect(log).toEqual([
      "A:take",
      "B:take",
      "A:perform",
      "B:perform",
      "A:sleep:5",
      "B:sleep:7",
      "A:take",
      "B:take",
      "A:perform",
      "B:perform",
    ]);
  });
});
