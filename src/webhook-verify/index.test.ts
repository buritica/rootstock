import { expect, test } from "bun:test";

test("webhook-verify exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("./index.ts")).sort()).toEqual([
    "notionEventAge",
    "notionSignatureMatches",
    "slackSignatureMatches",
    "verifySlackRequest",
  ]);
});
