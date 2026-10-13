import { describe, expect, test } from "bun:test";
import { mycelV1 } from "./index.ts";

/** The 25 UTF-16 code units JavaScript's `\s` and `String.prototype.trim` treat as whitespace. */
const WHITESPACE_UNITS =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

test("surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/normalize")).sort()).toEqual(["mycelV1"]);
});

describe("mycelV1 profile", () => {
  test("id, freeze and destructuring", () => {
    expect(mycelV1.id).toBe("mycel-v1");
    expect(Object.isFrozen(mycelV1)).toBe(true);
    expect(Object.keys(mycelV1)).toEqual(["id", "normalizeName"]);
    const { normalizeName } = mycelV1;
    expect(normalizeName("  A  B ")).toBe("a b");
  });
});

describe("normalize.name/mycel-v1", () => {
  const cases: ReadonlyArray<readonly [label: string, input: string, expected: string]> = [
    ["empty", "", ""],
    ["blank", "   ", ""],
    ["latin diacritics fold", "Caf\u00e9 Ol\u00e9", "cafe ole"],
    ["trim and collapse", "  \u00c5ngstr\u00f6m \t\n 42  ", "angstrom 42"],
    ["inner hyphens and underscores kept", "  --Hello__World--  ", "--hello__world--"],
    // NFD decomposes Hangul syllables into jamo, and nothing recomposes them.
    ["hangul stays decomposed", "\uac00\ub098", "\u1100\u1161\u1102\u1161"],
    ["final sigma", "\u03a3\u0391\u03a3", "\u03c3\u03b1\u03c2"],
    ["lone capital sigma", "\u03a3", "\u03c3"],
    [
      "final sigma before a space",
      "\u039f\u0394\u039f\u03a3 \u0391",
      "\u03bf\u03b4\u03bf\u03c2 \u03b1",
    ],
    [
      "greek tonos stripped, sigma by position",
      "\u038c\u03a3\u039f\u03a3",
      "\u03bf\u03c3\u03bf\u03c2",
    ],
    // Pin both ends of the stripped range U+0300 to U+036F and the code points just outside it.
    ["grave decomposes to U+0300, stripped", "\u00e0", "a"],
    ["bare U+0300 stripped", "a\u0300", "a"],
    ["U+036F stripped", "a\u036f", "a"],
    ["U+02FF just below the range kept", "a\u02ff", "a\u02ff"],
    ["U+0370 just above the range kept and lowercased", "a\u0370", "a\u0371"],
    ["dotted capital I", "\u0130", "i"],
    ["dotted capital I in a word", "\u0130STANBUL", "istanbul"],
    ["titlecase digraph", "\u01c5", "\u01c6"],
    ["stroked L has no decomposition", "\u0141", "\u0142"],
    ["sharp s stays", "\u00df", "\u00df"],
    ["sharp s in a word", "\u00dftra\u00dfe", "\u00dftra\u00dfe"],
    ["compatibility ligature untouched", "\ufb01", "\ufb01"],
    ["roman numeral lowercases", "\u216b", "\u217b"],
    ["astral letters pass through", "\u{1d400}\u{1d401} C", "\u{1d400}\u{1d401} c"],
    ["quad spaces trimmed after decomposition", "\u2000x\u2001", "x"],
    ["zero width space kept", "a\u200bb", "a\u200bb"],
    ["zero width space survives trim", " \u200b ", "\u200b"],
    ["next line kept", "a\u0085b", "a\u0085b"],
    ["next line survives trim", " \u0085 ", "\u0085"],
    ["mongolian vowel separator kept", "a\u180eb", "a\u180eb"],
    ["mongolian vowel separator alone", "\u180e", "\u180e"],
    ["lone high surrogate", "\ud800", "\ud800"],
    ["lone low surrogate inside", "A\udc00B", "a\udc00b"],
    ["reversed pair", "\udc00\ud800", "\udc00\ud800"],
  ];
  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(mycelV1.normalizeName(input)).toBe(expected);
    });
  }

  test("all 25 whitespace units trim and collapse to one space", () => {
    expect(WHITESPACE_UNITS.length).toBe(25);
    for (const unit of WHITESPACE_UNITS) {
      const hex = unit.charCodeAt(0).toString(16);
      expect(mycelV1.normalizeName(`a${unit}${unit}b`), hex).toBe("a b");
      expect(mycelV1.normalizeName(`${unit}a${unit}`), hex).toBe("a");
      expect(mycelV1.normalizeName(unit), hex).toBe("");
    }
    expect(mycelV1.normalizeName(`x${WHITESPACE_UNITS}y`)).toBe("x y");
  });

  test("a non-string throws a TypeError naming name.normalize", () => {
    for (const value of [undefined, null, 5, {}]) {
      expect(() => mycelV1.normalizeName(value as unknown as string)).toThrow(TypeError);
      expect(() => mycelV1.normalizeName(value as unknown as string)).toThrow(/name\.normalize/);
    }
  });
});
