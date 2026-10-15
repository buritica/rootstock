import { expect, test } from "bun:test";

test("retry exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "createTokenBucketPacer",
    "isRateLimitExhausted",
    "mentionsRateLimitExhausted",
    "pacedRetry",
    "retryAfterMs",
  ]);
});
