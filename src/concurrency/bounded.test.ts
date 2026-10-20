import { describe, expect, test } from "bun:test";
import { forEachBounded } from "./bounded.ts";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drains the microtask queue far enough for every chained continuation here.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// Resolves to "pending" while `p` has not settled, otherwise to its outcome.
async function state(p: Promise<unknown>): Promise<unknown> {
  const outcome = p.then(
    () => "resolved",
    (err: unknown) => ({ rejected: err }),
  );
  await flush();
  return Promise.race([outcome, Promise.resolve("pending")]);
}

// Records every gate and dispatch in order; each run waits on its own deferred.
function harness(n: number) {
  const runs = Array.from({ length: n }, () => deferred());
  const events: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async (i: number): Promise<void> => {
    events.push(`run:${i}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await (runs[i] as Deferred).promise;
    } finally {
      inFlight--;
      events.push(`done:${i}`);
    }
  };
  return { runs, events, run, maxInFlight: () => maxInFlight };
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("forEachBounded", () => {
  test("gates and dispatches in item order, never more than width in flight", async () => {
    const h = harness(4);
    const before = async (i: number) => {
      h.events.push(`gate:${i}`);
    };
    const pass = forEachBounded(range(4), { width: 2, before }, h.run);
    await flush();
    // A run starts on the microtask after its dispatch, so the next gate can
    // land first; what is fixed is that each gate precedes its own run.
    expect(h.events).toEqual(["gate:0", "gate:1", "run:0", "run:1"]);
    h.runs[0]?.resolve();
    await flush();
    expect(h.events.slice(4)).toEqual(["done:0", "gate:2", "run:2"]);
    for (const r of h.runs) r.resolve();
    await pass;
    expect(h.events.filter((e) => e.startsWith("gate:"))).toEqual([
      "gate:0",
      "gate:1",
      "gate:2",
      "gate:3",
    ]);
    expect(h.maxInFlight()).toBe(2);
  });

  test("slot-wait starts the next item as soon as any one finishes", async () => {
    const h = harness(4);
    const pass = forEachBounded(range(4), { width: 2 }, h.run);
    await flush();
    // The second item finishes while the first is still running.
    h.runs[1]?.resolve();
    await flush();
    expect(h.events).toEqual(["run:0", "run:1", "done:1", "run:2"]);
    for (const r of h.runs) r.resolve();
    await pass;
  });

  test("a gate throw dispatches nothing after it and lets in-flight work finish", async () => {
    const h = harness(4);
    const refused = new Error("gate refused");
    const before = async (i: number) => {
      if (i === 2) throw refused;
    };
    const pass = forEachBounded(range(4), { width: 4, before }, h.run);
    await flush();
    expect(h.events).toEqual(["run:0", "run:1"]);
    expect(await state(pass)).toBe("pending");
    h.runs[0]?.resolve();
    h.runs[1]?.resolve();
    expect(await rejection(pass)).toBe(refused);
    expect(h.events).toEqual(["run:0", "run:1", "done:0", "done:1"]);
  });

  test("rejection-during-gate", async () => {
    const h = harness(3);
    const gate1 = deferred();
    const before = async (i: number) => {
      if (i === 1) await gate1.promise;
    };
    const pass = forEachBounded(range(3), { width: 2, before }, h.run);
    await flush();
    expect(h.events).toEqual(["run:0"]);
    // The in-flight item rejects while the next item's gate is awaited.
    const boom = new Error("boom");
    h.runs[0]?.reject(boom);
    await flush();
    gate1.resolve();
    await flush();
    // Settle everything, so a dispatched item shows up instead of hanging the pass.
    for (const r of h.runs) r.resolve();
    expect(await rejection(pass)).toBe(boom);
    expect(h.events).toEqual(["run:0", "done:0"]);
  });

  test("a synchronous throw from run is a rejection, and in-flight work finishes", async () => {
    const h = harness(3);
    const sync = new Error("sync");
    const run = (i: number): Promise<void> => {
      if (i === 1) throw sync;
      return h.run(i);
    };
    const pass = forEachBounded(range(3), { width: 2 }, run);
    await flush();
    expect(h.events).toEqual(["run:0"]);
    expect(await state(pass)).toBe("pending");
    h.runs[0]?.resolve();
    expect(await rejection(pass)).toBe(sync);
    expect(h.events).toEqual(["run:0", "done:0"]);
  });

  test("first-error-wins", async () => {
    const h = harness(2);
    const pass = forEachBounded(range(2), { width: 2 }, h.run);
    await flush();
    const first = new Error("first");
    const second = new Error("second");
    h.runs[0]?.reject(first);
    await flush();
    h.runs[1]?.reject(second);
    expect(await rejection(pass)).toBe(first);
  });

  test("generator-finally-runs-on-abort", async () => {
    let pulled = 0;
    let cleaned = false;
    function* items(): Generator<number> {
      try {
        for (let i = 0; i < 10; i++) {
          pulled++;
          yield i;
        }
      } finally {
        cleaned = true;
      }
    }
    const boom = new Error("boom");
    const pass = forEachBounded(items(), { width: 1 }, async (i) => {
      if (i === 1) throw boom;
    });
    expect(await rejection(pass)).toBe(boom);
    expect(cleaned).toBe(true);
    // Nothing is pulled once the pass has aborted.
    expect(pulled).toBe(2);
  });

  test("a throwing return() does not mask the error that aborted the pass", async () => {
    const refused = new Error("gate refused");
    const cleanup = new Error("cleanup");
    let returned = 0;
    const iterable: Iterable<number> = {
      [Symbol.iterator]: () => ({
        next: () => ({ done: false, value: 0 }),
        return: () => {
          returned++;
          throw cleanup;
        },
      }),
    };
    const before = async () => {
      throw refused;
    };
    const pass = forEachBounded(iterable, { width: 1, before }, async () => {});
    expect(await rejection(pass)).toBe(refused);
    expect(returned).toBe(1);
  });

  test("return() is not called on an exhausted iterator", async () => {
    let returned = 0;
    const values = [1, 2];
    const iterable: Iterable<number> = {
      [Symbol.iterator]: () => {
        let i = 0;
        return {
          next: () =>
            i < values.length
              ? { done: false, value: values[i++] as number }
              : { done: true, value: undefined },
          return: () => {
            returned++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const seen: number[] = [];
    await forEachBounded(iterable, { width: 2 }, async (v) => {
      seen.push(v);
    });
    expect(seen).toEqual([1, 2]);
    expect(returned).toBe(0);
  });

  test.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
  ])("falsy-throw-still-throws (%s)", async (_label, thrown) => {
    const pass = forEachBounded([1], { width: 1 }, async () => {
      throw thrown;
    });
    const err = await rejection(pass);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("forEachBounded: aborted with a falsy error");
  });

  test("a falsy gate throw still throws", async () => {
    const before = async () => {
      throw undefined;
    };
    const pass = forEachBounded([1], { width: 1, before }, async () => {});
    expect(((await rejection(pass)) as Error).message).toBe(
      "forEachBounded: aborted with a falsy error",
    );
  });

  test("a falsy but non-nullish throw is rethrown as is", async () => {
    const pass = forEachBounded([1], { width: 1 }, async () => {
      throw 0;
    });
    expect(await rejection(pass)).toBe(0);
  });

  test.each<[string, unknown, string]>([
    ["0", 0, "forEachBounded: width must be a positive integer, got 0"],
    ["1.5", 1.5, "forEachBounded: width must be a positive integer, got 1.5"],
    ["NaN", Number.NaN, "forEachBounded: width must be a positive integer, got null"],
    ['"2"', "2", 'forEachBounded: width must be a positive integer, got "2"'],
  ])("refuses width %s with the verbatim text and pulls nothing", async (_label, w, text) => {
    let pulled = 0;
    const items: Iterable<number> = {
      [Symbol.iterator]: () => {
        pulled++;
        return [1][Symbol.iterator]();
      },
    };
    const err = await rejection(forEachBounded(items, { width: w as number }, async () => {}));
    expect((err as Error).message).toBe(text);
    expect(pulled).toBe(0);
  });

  test("the empty iterable resolves without calling anything", async () => {
    let calls = 0;
    await forEachBounded([], { width: 2, before: async () => void calls++ }, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
