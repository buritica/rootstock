import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./map-with-concurrency.ts";

// Drains the microtask queue far enough for every chained continuation here.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// One deferred per item; `fn` records what started and how many are in flight.
function harness(n: number) {
  const gates = Array.from({ length: n }, () => Promise.withResolvers<string>());
  const started: Array<[string, number]> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (item: string, index: number): Promise<string> => {
    started.push([item, index]);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await (gates[index] as PromiseWithResolvers<string>).promise;
    } finally {
      inFlight--;
    }
  };
  return { gates, started, fn, maxInFlight: () => maxInFlight };
}

describe("mapWithConcurrency", () => {
  test("order-and-index", async () => {
    const h = harness(4);
    const call = mapWithConcurrency(["a", "b", "c", "d"], 2, h.fn);
    await flush();
    expect(h.started).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    // Out-of-order completion: the second item finishes first.
    h.gates[1]?.resolve("B");
    await flush();
    expect(h.started).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    h.gates[3]?.resolve("D");
    h.gates[2]?.resolve("C");
    await flush();
    expect(h.started.at(-1)).toEqual(["d", 3]);
    h.gates[0]?.resolve("A");
    expect(await call).toEqual(["A", "B", "C", "D"]);
    expect(h.maxInFlight()).toBe(2);
  });

  test("the empty list resolves to an empty array without calling fn", async () => {
    let calls = 0;
    const result = await mapWithConcurrency([], 3, async () => {
      calls++;
    });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a limit larger than the list starts every item at once", async () => {
    const h = harness(3);
    const call = mapWithConcurrency(["a", "b", "c"], 10, h.fn);
    await flush();
    expect(h.started.length).toBe(3);
    for (const [i, g] of h.gates.entries()) g.resolve(String(i));
    expect(await call).toEqual(["0", "1", "2"]);
    expect(h.maxInFlight()).toBe(3);
  });

  test.each([
    ["0", 0],
    ["-1", -1],
    ["NaN", Number.NaN],
  ])("limit %s starts nothing and resolves to a sparse array", async (_label, limit) => {
    let calls = 0;
    const result = await mapWithConcurrency(["a", "b", "c"], limit, async () => {
      calls++;
      return 1;
    });
    expect(result.length).toBe(3);
    expect(Object.keys(result).length).toBe(0);
    expect(calls).toBe(0);
  });

  test("an infinite limit starts every item, one worker per item", async () => {
    const h = harness(3);
    const call = mapWithConcurrency(["a", "b", "c"], Number.POSITIVE_INFINITY, h.fn);
    await flush();
    expect(h.started.length).toBe(3);
    for (const [i, g] of h.gates.entries()) g.resolve(String(i));
    expect(await call).toEqual(["0", "1", "2"]);
  });

  test("a fractional limit of 1.5 starts one worker", async () => {
    const h = harness(2);
    const call = mapWithConcurrency(["a", "b"], 1.5, h.fn);
    await flush();
    expect(h.started).toEqual([["a", 0]]);
    h.gates[0]?.resolve("A");
    await flush();
    h.gates[1]?.resolve("B");
    expect(await call).toEqual(["A", "B"]);
    expect(h.maxInFlight()).toBe(1);
  });

  test("a rejection rejects the call while the other workers keep running", async () => {
    const h = harness(3);
    const call = mapWithConcurrency(["a", "b", "c"], 2, h.fn);
    const settled = call.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await flush();
    const boom = new Error("boom");
    h.gates[0]?.reject(boom);
    expect(await settled).toBe(boom);
    // The surviving worker is detached, not cancelled: it finishes its item
    // and pulls the next one.
    h.gates[1]?.resolve("B");
    await flush();
    expect(h.started.at(-1)).toEqual(["c", 2]);
    h.gates[2]?.resolve("C");
    await flush();
  });
});
