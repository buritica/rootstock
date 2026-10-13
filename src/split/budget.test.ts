import { describe, expect, test } from "bun:test";
import {
  packWithinBudget,
  partCharBudget,
  sliceLongLines,
  splitBodyWithinBudget,
} from "./index.ts";

/** The message `fn` throws, so a refusal is matched exactly rather than as a substring. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
}

const len = (n: number) => n;

describe("packWithinBudget", () => {
  const cases: Array<[string, number[], number, number, boolean | undefined, number[][]]> = [
    // name, item sizes, budget, separatorCost, separatorChargedOnFirst, groups
    ["separator only between items", [3, 3, 3], 7, 1, undefined, [[3, 3], [3]]],
    ["explicit false is the default", [3, 3, 3], 7, 1, false, [[3, 3], [3]]],
    ["separator charged on the first item too", [3, 3, 3], 7, 1, true, [[3], [3], [3]]],
    ["oversize item gets a group of its own", [2, 9, 1, 1], 4, 1, undefined, [[2], [9], [1, 1]]],
    ["the breaking item pays no separator in its new group", [4, 3], 6, 2, undefined, [[4], [3]]],
    ["zero-cost separator fills to the budget", [1, 1, 1, 1], 4, 0, true, [[1, 1, 1, 1]]],
    [
      "oversize item first gets a group of its own, no empty group before it",
      [9, 1],
      4,
      1,
      undefined,
      [[9], [1]],
    ],
    ["an item over the budget with the separator charged on first", [4], 4, 1, true, [[4]]],
    ["empty input", [], 4, 1, undefined, []],
  ];
  for (const [name, items, budget, separatorCost, onFirst, groups] of cases) {
    test(name, () => {
      const options =
        onFirst === undefined
          ? { budget, sizeOf: len, separatorCost }
          : { budget, sizeOf: len, separatorCost, separatorChargedOnFirst: onFirst };
      expect(packWithinBudget(items, options)).toEqual(groups);
    });
  }

  test("packs strings by their UTF-16 length", () => {
    expect(
      packWithinBudget(["ab", "😀", "c", "def"], {
        budget: 5,
        sizeOf: (s) => s.length,
        separatorCost: 1,
      }),
    ).toEqual([
      ["ab", "😀"],
      ["c", "def"],
    ]);
  });

  const refusals: Array<[number, string]> = [
    [0, "packWithinBudget: budget must be at least 1 char, got 0"],
    [-1, "packWithinBudget: budget must be at least 1 char, got -1"],
    [0.5, "packWithinBudget: budget must be at least 1 char, got 0.5"],
    [Number.NaN, "packWithinBudget: budget must be at least 1 char, got NaN"],
  ];
  for (const [budget, message] of refusals) {
    test(`refuses budget ${budget}`, () => {
      let caught: unknown;
      try {
        packWithinBudget([1], { budget, sizeOf: len, separatorCost: 1 });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("Error");
      expect((caught as Error).message).toBe(message);
    });
  }

  test("refuses before measuring anything, even for empty input", () => {
    expect(
      messageOf(() => packWithinBudget([], { budget: 0, sizeOf: len, separatorCost: 1 })),
    ).toBe("packWithinBudget: budget must be at least 1 char, got 0");
  });
});

describe("sliceLongLines", () => {
  const cases: Array<[string, string[], number, string[]]> = [
    ["slices only lines over the width", ["abcdefg", "hi", ""], 3, ["abc", "def", "g", "hi", ""]],
    ["a line of exactly the width is kept", ["abc"], 3, ["abc"]],
    ["width 1", ["abc"], 1, ["a", "b", "c"]],
    ["a cut can split a surrogate pair", ["a😀b"], 2, ["a\uD83D", "\uDE00b"]],
    [
      "a fractional width slices at its floor and the remainder is the last piece",
      ["abcde"],
      2.5,
      ["ab", "cde"],
    ],
    ["empty input", [], 5, []],
  ];
  for (const [name, lines, width, out] of cases) {
    test(name, () => {
      expect(sliceLongLines(lines, width)).toEqual(out);
    });
  }

  const refusals: Array<[number, string]> = [
    [0, "sliceLongLines: width must be at least 1 char, got 0"],
    [-2, "sliceLongLines: width must be at least 1 char, got -2"],
    [Number.NaN, "sliceLongLines: width must be at least 1 char, got NaN"],
  ];
  for (const [width, message] of refusals) {
    test(`refuses width ${width}`, () => {
      let caught: unknown;
      try {
        sliceLongLines(["a"], width);
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).name).toBe("Error");
      expect((caught as Error).message).toBe(message);
    });
  }
});

describe("partCharBudget", () => {
  const window = { maxInputTokens: 2048, tokenMargin: 8, joinChars: 0, labelReserveChars: 0 };
  const cases: Array<[string, string, number, typeof window, number]> = [
    ["(2048 - 8) * 2.8", "", 2.8, window, 5712],
    ["less the join chars", "", 2.8, { ...window, joinChars: 4 }, 5708],
    [
      "less title, label reserve and join chars",
      "abc",
      2.8,
      { ...window, joinChars: 4, labelReserveChars: 16 },
      5689,
    ],
    ["floors a fractional result", "", 1.5, { ...window, maxInputTokens: 11, tokenMargin: 0 }, 16],
    [
      "goes negative for a long title",
      "x".repeat(6000),
      2.8,
      { ...window, joinChars: 4, labelReserveChars: 16 },
      -308,
    ],
    ["NaN charsPerToken passes through", "t", Number.NaN, window, Number.NaN],
    [
      "NaN maxInputTokens passes through",
      "t",
      2.8,
      { ...window, maxInputTokens: Number.NaN },
      Number.NaN,
    ],
  ];
  for (const [name, title, charsPerToken, params, out] of cases) {
    test(name, () => {
      expect(partCharBudget(title, charsPerToken, params)).toBe(out);
    });
  }

  test("reads its parameters in formula order", () => {
    const reads: string[] = [];
    const params = new Proxy(
      { maxInputTokens: 100, tokenMargin: 8, joinChars: 4, labelReserveChars: 16 },
      {
        get(target, key, receiver) {
          reads.push(String(key));
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expect(partCharBudget("ab", 2, params)).toBe(162);
    expect(reads).toEqual(["maxInputTokens", "tokenMargin", "labelReserveChars", "joinChars"]);
  });
});

describe("splitBodyWithinBudget", () => {
  const cases: Array<[string, string, number, string[]]> = [
    ["empty body is one empty part", "", 10, [""]],
    ["a trailing blank run leaves one empty paragraph", "a\n\nb\n\n\n", 10, ["a\n\nb\n\n"]],
    ["blank lines only", "\n\n\n\n", 10, ["\n\n"]],
    [
      "blank runs normalize to one blank line",
      "one\n\ntwo\n\nthree\n\n\n\nfour",
      10,
      ["one\n\ntwo", "three", "four"],
    ],
    ["CRLF is not a paragraph break", "a\r\n\r\nb", 100, ["a\r\n\r\nb"]],
    ["CRLF paragraph hard-splits at \\n, keeping \\r", "aa\r\n\r\nbb", 3, ["aa\r", "\r", "bb"]],
    ["hard split charges each joining \\n", "abc\nde", 5, ["abc", "de"]],
    ["a paragraph of exactly the budget is not hard-split", "ab\nde", 5, ["ab\nde"]],
    ["hard split packs lines up to the budget", "ab\ncd\nef", 5, ["ab\ncd", "ef"]],
    ["a long line is sliced", "abcdefghij\nk\n\nxy", 4, ["abcd", "efgh", "ij\nk", "xy"]],
  ];
  for (const [name, body, charBudget, parts] of cases) {
    test(name, () => {
      expect(splitBodyWithinBudget("t", body, { charBudget, adapter: "a" })).toEqual(parts);
    });
  }

  const budgetRefusals: Array<[number, string]> = [
    [
      0,
      'lbl: char budget for title "My \\"T\\"\\n" is 0 — the title alone exceeds the embedding window',
    ],
    [
      -3,
      'lbl: char budget for title "My \\"T\\"\\n" is -3 — the title alone exceeds the embedding window',
    ],
    [
      Number.NaN,
      'lbl: char budget for title "My \\"T\\"\\n" is NaN — the title alone exceeds the embedding window',
    ],
  ];
  for (const [charBudget, message] of budgetRefusals) {
    test(`refuses char budget ${charBudget}, naming the JSON-encoded title`, () => {
      expect(
        messageOf(() => splitBodyWithinBudget('My "T"\n', "x", { charBudget, adapter: "lbl" })),
      ).toBe(message);
    });
  }

  test("refuses when packing yields zero parts", () => {
    // Only reachable when the body's split yields nothing, which a real string never does.
    const body = { split: () => [] } as unknown as string;
    expect(
      messageOf(() => splitBodyWithinBudget("t", body, { charBudget: 5, adapter: "lbl" })),
    ).toBe(
      'lbl: splitter produced zero parts for title "t" — the packer dropped every block, which must never happen',
    );
  });
});
