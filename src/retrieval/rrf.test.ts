import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion } from "./rrf.ts";

const key = (s: string) => s;

describe("reciprocalRankFusion", () => {
  test("agreement between lists beats one list's first place", () => {
    const out = reciprocalRankFusion([{ items: ["a", "b", "c"] }, { items: ["d", "b", "e"] }], {
      key,
    });
    expect(out[0]?.item).toBe("b");
    expect(out[0]?.ranks).toEqual({ 0: 2, 1: 2 });
    expect(out[0]?.score).toBeCloseTo(2 / 62, 12);
  });

  test("keeps items that only one list holds", () => {
    const out = reciprocalRankFusion([{ items: ["a"] }, { items: ["b"] }], { key });
    expect(out.map((f) => f.item)).toEqual(["a", "b"]);
  });

  test("ties break by best rank, then first appearance", () => {
    const out = reciprocalRankFusion([{ items: ["x", "a"] }, { items: ["y", "b"] }], { key });
    expect(out.map((f) => f.item)).toEqual(["x", "y", "a", "b"]);
  });

  test("weight scales a list's say", () => {
    const out = reciprocalRankFusion(
      [
        { items: ["a"], weight: 1 },
        { items: ["b"], weight: 2 },
      ],
      {
        key,
      },
    );
    expect(out[0]?.item).toBe("b");
  });

  test("a key repeated in one list counts once, at its best rank", () => {
    const out = reciprocalRankFusion([{ items: ["a", "a", "b"] }], { key });
    expect(out).toHaveLength(2);
    expect(out[0]?.score).toBeCloseTo(1 / 61, 12);
    expect(out[1]?.ranks).toEqual({ 0: 3 });
  });

  test("limit cuts after ranking; empty input is empty", () => {
    expect(reciprocalRankFusion([{ items: ["a", "b", "c"] }], { key, limit: 2 })).toHaveLength(2);
    expect(reciprocalRankFusion([], { key })).toEqual([]);
  });

  test("identity comes from key, the item from the first list that held it", () => {
    const out = reciprocalRankFusion(
      [{ items: [{ id: "1", from: "lex" }] }, { items: [{ id: "1", from: "vec" }] }],
      { key: (x) => x.id },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.item.from).toBe("lex");
  });

  test("rejects a negative k or weight", () => {
    expect(() => reciprocalRankFusion([{ items: ["a"] }], { key, k: -1 })).toThrow();
    expect(() => reciprocalRankFusion([{ items: ["a"], weight: -1 }], { key })).toThrow();
  });
});
