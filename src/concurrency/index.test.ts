import { expect, test } from "bun:test";

test("concurrency exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "concurrencySlice",
    "forEachBounded",
    "mapWithConcurrency",
    "width",
  ]);
});
