import { expect, test } from "bun:test";

test("the split surface is exactly the frozen list", async () => {
  expect(Object.keys(await import("@buritica/rootstock/split")).sort()).toEqual([
    "dianArticles",
    "locateWindows",
    "mycelV1",
    "packWithinBudget",
    "partCharBudget",
    "sliceLongLines",
    "splitBodyWithinBudget",
    "windowBody",
  ]);
});

test("profiles are the only objects with an id, and both are frozen", async () => {
  const mod: Record<string, unknown> = await import("@buritica/rootstock/split");
  const profiles = Object.entries(mod)
    .filter(([, v]) => v !== null && typeof v === "object" && "id" in v)
    .map(([k, v]) => [k, (v as { id: string }).id, Object.isFrozen(v)]);
  expect(profiles.sort()).toEqual([
    ["dianArticles", "dian-articles", true],
    ["mycelV1", "mycel-v1", true],
  ]);
});
