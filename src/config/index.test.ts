import { expect, test } from "bun:test";

test("config exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "defineRootstockConfig",
    "printRootstockConfig",
    "widthBelowPool",
  ]);
});
