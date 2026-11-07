import { expect, test } from "bun:test";
import { consecutiveBreaker } from "./breaker.ts";
import type { RootstockRunsError } from "./errors.ts";
import type { RunsEvent } from "./events.ts";
import { runsInput } from "./fixtures.test-support.ts";
import { type RunsSlice, runsSlice } from "./slice.ts";

// R-D6 (contract §7, §13.7): the quota breaker, pure.

const SLICE = runsSlice(runsInput()); // alpha-quota: limit 5

const thrown = (fn: () => unknown): RootstockRunsError => {
  try {
    fn();
  } catch (err) {
    return err as RootstockRunsError;
  }
  throw new Error("expected a refusal");
};

test("RK1: limit hits trip and latch; clear resets before the trip, not after; check throws; one event", () => {
  const events: RunsEvent[] = [];
  const b = consecutiveBreaker("alpha-quota", SLICE, { onEvent: (e) => events.push(e) });
  for (let i = 0; i < 4; i++) b.hit();
  expect([b.count, b.tripped]).toEqual([4, false]);
  b.clear();
  expect([b.count, b.tripped]).toEqual([0, false]);
  expect(() => b.check()).not.toThrow();
  for (let i = 0; i < 4; i++) b.hit();
  expect(events).toEqual([]);
  b.hit();
  expect([b.count, b.tripped]).toEqual([5, true]);
  expect(events).toEqual([{ type: "runs.breaker_tripped", breaker: "alpha-quota", count: 5 }]);
  b.hit();
  b.clear();
  expect([b.count, b.tripped]).toEqual([6, true]);
  expect(events).toHaveLength(1);
  const err = thrown(() => b.check());
  expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_BREAKER");
  expect(err.message).toBe(
    "rootstock runs: alpha-quota tripped after 6 consecutive quota failures — stopping",
  );
  // No deps, and a hook that throws: the breaker still trips.
  const quiet = consecutiveBreaker("alpha-quota", SLICE, {
    onEvent: () => {
      throw new Error("hook");
    },
  });
  for (let i = 0; i < 5; i++) quiet.hit();
  expect(quiet.tripped).toBe(true);
  expect(consecutiveBreaker("alpha-quota", SLICE).tripped).toBe(false);
});

test("RK1: an undeclared breaker and an unbranded slice refuse", () => {
  expect(thrown(() => consecutiveBreaker("omega", SLICE)).message).toBe(
    'rootstock runs: consecutiveBreaker("omega"): not a breaker this slice declares — declared: alpha-quota',
  );
  expect(() => consecutiveBreaker("alpha-quota", { ...SLICE } as RunsSlice)).toThrow(
    "consecutiveBreaker",
  );
});
