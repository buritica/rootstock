import { expect, test } from "bun:test";
import { raceDeadline } from "./deadline.ts";
import { fakeTime } from "./fakes.test-support.ts";

test("raceDeadline: the value when work wins, and the timer is cancelled", async () => {
  const time = fakeTime();
  expect(await raceDeadline(time, 1_000, Promise.resolve(7))).toEqual({ value: 7 });
  expect(time.pending()).toBe(0);
});

test("raceDeadline: timeout when the timer fires first; a rejection before it rethrows", async () => {
  const time = fakeTime();
  const late = raceDeadline(time, 1_000, new Promise<never>(() => {}));
  time.advance(1_000);
  expect(await late).toBe("timeout");
  expect(time.pending()).toBe(0);
  await expect(raceDeadline(time, 1_000, Promise.reject(new RangeError("x")))).rejects.toThrow(
    RangeError,
  );
  expect(time.pending()).toBe(0);
});
