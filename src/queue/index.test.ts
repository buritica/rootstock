import { expect, test } from "bun:test";

test("queue exports exactly the frozen surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/queue")).sort()).toEqual([
    "RootstockQueueError",
    "ack",
    "claim",
    "cursorTable",
    "depth",
    "enqueue",
    "extendClaim",
    "fail",
    "getCursor",
    "listDead",
    "queueErrorCode",
    "queueSlice",
    "retryDead",
    "setCursor",
    "touchCursor",
  ]);
});
