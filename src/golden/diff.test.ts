import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical.ts";
import { diffCanonicalTexts } from "./diff.ts";

const diff = (expected: unknown, actual: unknown) =>
  diffCanonicalTexts(canonicalJson(expected), canonicalJson(actual));

const E_ACUTE = String.fromCharCode(0xe9);
const GRIN = String.fromCodePoint(0x1f600); // two UTF-16 code units
const GRIN_2 = String.fromCodePoint(0x1f601); // same high surrogate as GRIN
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe("paths", () => {
  test("root value", () => {
    expect(diff(1, 2)).toEqual({
      diffs: [{ path: "$", change: "changed", expected: "1", actual: "2" }],
      diffsOmitted: 0,
    });
  });

  test("dot form only for identifier keys, brackets otherwise, in code-unit key order", () => {
    const expected = {
      [E_ACUTE]: 1,
      list: [0, 1, 2, 3],
      "a b": 1,
      a: 1,
      _y: 1,
      "9z": 1,
      "10": 1,
      $x: 1,
    };
    const actual = {
      [E_ACUTE]: 2,
      list: [0, 1, 2, 4],
      "a b": 2,
      a: 2,
      _y: 2,
      "9z": 2,
      "10": 2,
      $x: 2,
    };
    const changed = (path: string, from: string, to: string) => ({
      path,
      change: "changed" as const,
      expected: from,
      actual: to,
    });
    expect(diff(expected, actual)).toEqual({
      diffs: [
        changed("$.$x", "1", "2"),
        changed('$["10"]', "1", "2"),
        changed('$["9z"]', "1", "2"),
        changed("$._y", "1", "2"),
        changed("$.a", "1", "2"),
        changed('$["a b"]', "1", "2"),
        changed("$.list[3]", "3", "4"),
        changed(`$["${E_ACUTE}"]`, "1", "2"),
      ],
      diffsOmitted: 0,
    });
  });

  test("depth-first: a nested object finishes before the next key", () => {
    const expected = { c: 1, b: [{ y: 1 }], a: { z: 1, b: 1 } };
    const actual = { c: 2, b: [{ y: 2 }], a: { z: 2, b: 2 } };
    expect(diff(expected, actual).diffs.map((d) => d.path)).toEqual([
      "$.a.b",
      "$.a.z",
      "$.b[0].y",
      "$.c",
    ]);
  });
});

describe("change kinds", () => {
  test("added, removed and type", () => {
    expect(
      diff(
        { a: 1, b: { x: 1 }, c: [1], d: null, e: "s" },
        { b: [1], c: { "0": 1 }, d: false, e: 1, f: true },
      ),
    ).toEqual({
      diffs: [
        { path: "$.a", change: "removed", expected: "1" },
        { path: "$.b", change: "type", expected: '{"x":1}', actual: "[1]" },
        { path: "$.c", change: "type", expected: "[1]", actual: '{"0":1}' },
        { path: "$.d", change: "type", expected: "null", actual: "false" },
        { path: "$.e", change: "type", expected: '"s"', actual: "1" },
        { path: "$.f", change: "added", actual: "true" },
      ],
      diffsOmitted: 0,
    });
  });

  test("array growth is added at the old length; shrink is removed", () => {
    expect(diff([1, 2], [1, 2, 3, { k: 4 }]).diffs).toEqual([
      { path: "$[2]", change: "added", actual: "3" },
      { path: "$[3]", change: "added", actual: '{"k":4}' },
    ]);
    expect(diff([1, 2, 3], [1]).diffs).toEqual([
      { path: "$[1]", change: "removed", expected: "2" },
      { path: "$[2]", change: "removed", expected: "3" },
    ]);
  });

  test("booleans and numbers change in place", () => {
    expect(diff({ t: true, n: 1.5 }, { t: false, n: 1e21 }).diffs).toEqual([
      { path: "$.n", change: "changed", expected: "1.5", actual: "1e+21" },
      { path: "$.t", change: "changed", expected: "true", actual: "false" },
    ]);
  });
});

describe("strings", () => {
  test("at counts UTF-16 code units past an astral character", () => {
    expect(diff(`${GRIN}abc`, `${GRIN}abd`).diffs).toEqual([
      {
        path: "$",
        change: "changed",
        expected: `"${GRIN}abc"`,
        actual: `"${GRIN}abd"`,
        at: 4,
        expectedLength: 5,
        actualLength: 5,
      },
    ]);
  });

  test("a difference inside a pair still shows the whole pair", () => {
    expect(diff(GRIN, GRIN_2).diffs).toEqual([
      {
        path: "$",
        change: "changed",
        expected: `"${GRIN}"`,
        actual: `"${GRIN_2}"`,
        at: 1,
        expectedLength: 2,
        actualLength: 2,
      },
    ]);
  });

  test("a prefix differs at the shorter length", () => {
    expect(diff("abc", "abcd").diffs).toEqual([
      {
        path: "$",
        change: "changed",
        expected: '"abc"',
        actual: '"abcd"',
        at: 3,
        expectedLength: 3,
        actualLength: 4,
      },
    ]);
  });

  test("excerpts are 32 units either side of at", () => {
    const before = `${"a".repeat(50)}X${"b".repeat(49)}`;
    const after = `${"a".repeat(50)}Y${"b".repeat(49)}`;
    expect(diff({ s: before }, { s: after }).diffs).toEqual([
      {
        path: "$.s",
        change: "changed",
        expected: `"${"a".repeat(32)}X${"b".repeat(31)}"`,
        actual: `"${"a".repeat(32)}Y${"b".repeat(31)}"`,
        at: 50,
        expectedLength: 100,
        actualLength: 100,
      },
    ]);
  });

  test("an excerpt start never splits a pair", () => {
    // at = 41, so at - 32 = 9 lands on the low half of the fifth pair.
    expect(diff(`${GRIN.repeat(20)}zx`, `${GRIN.repeat(20)}zy`).diffs).toEqual([
      {
        path: "$",
        change: "changed",
        expected: `"${GRIN.repeat(15)}zx"`,
        actual: `"${GRIN.repeat(15)}zy"`,
        at: 41,
        expectedLength: 42,
        actualLength: 42,
      },
    ]);
  });

  test("an excerpt end never splits a pair", () => {
    // at = 0, so at + 32 = 32 lands on the low half of the sixteenth pair.
    expect(diff(`x${GRIN.repeat(20)}`, `y${GRIN.repeat(20)}`).diffs).toEqual([
      {
        path: "$",
        change: "changed",
        expected: `"x${GRIN.repeat(15)}"`,
        actual: `"y${GRIN.repeat(15)}"`,
        at: 0,
        expectedLength: 41,
        actualLength: 41,
      },
    ]);
  });

  test("U+2028 and U+2029 are escaped in excerpts", () => {
    expect(diff(`a${LS}b${PS}`, `a${LS}c${PS}`).diffs).toEqual([
      {
        path: "$",
        change: "changed",
        expected: '"a\\u2028b\\u2029"',
        actual: '"a\\u2028c\\u2029"',
        at: 2,
        expectedLength: 4,
        actualLength: 4,
      },
    ]);
  });

  test("a string that changes type is canonical JSON, not an excerpt", () => {
    expect(diff({ s: "1" }, { s: 1 }).diffs).toEqual([
      { path: "$.s", change: "type", expected: '"1"', actual: "1" },
    ]);
  });
});

describe("values", () => {
  test("long values are cut at 160 units with the remainder counted", () => {
    const numbers = Array.from({ length: 100 }, (_, i) => i);
    expect(diff(numbers, "x").diffs).toEqual([
      {
        path: "$",
        change: "type",
        expected:
          "[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,5…(+131)",
        actual: '"x"',
      },
    ]);
  });

  test("a cut never splits a pair", () => {
    // '"' then pairs: unit 159 is a high surrogate, so the cut moves to 159.
    expect(diff(GRIN.repeat(100), 1).diffs).toEqual([
      { path: "$", change: "type", expected: `"${GRIN.repeat(79)}…(+43)`, actual: "1" },
    ]);
  });

  test("-0 and 0 never differ, nor a Date and its ISO string", () => {
    expect(
      diff(
        { z: 0, d: "2026-01-02T03:04:05.006Z", n: 1 },
        { z: -0, d: new Date("2026-01-02T03:04:05.006Z"), n: 2 },
      ),
    ).toEqual({
      diffs: [{ path: "$.n", change: "changed", expected: "1", actual: "2" }],
      diffsOmitted: 0,
    });
  });
});

describe("limit", () => {
  test("keeps the first 20 and counts the rest", () => {
    const result = diff(Array(25).fill(0), Array(25).fill(1));
    expect(result.diffs.map((d) => d.path)).toEqual(
      Array.from({ length: 20 }, (_, i) => `$[${i}]`),
    );
    expect(result.diffs[19]).toEqual({
      path: "$[19]",
      change: "changed",
      expected: "0",
      actual: "1",
    });
    expect(result.diffsOmitted).toBe(5);
  });

  test("exactly 20 omits nothing", () => {
    expect(diff(Array(20).fill(0), Array(20).fill(1)).diffsOmitted).toBe(0);
  });

  test("the same texts give the same result", () => {
    const a = canonicalJson({ x: [1, { y: "abc" }], z: null });
    const b = canonicalJson({ x: [2, { y: "abd" }], w: true });
    expect(diffCanonicalTexts(a, b)).toEqual(diffCanonicalTexts(a, b));
  });
});
