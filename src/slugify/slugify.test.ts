import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mycelV1 } from "./index.ts";

test("surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/slugify")).sort()).toEqual(["mycelV1"]);
});

describe("mycelV1 profile", () => {
  test("id, freeze and destructuring", () => {
    expect(mycelV1.id).toBe("mycel-v1");
    expect(Object.isFrozen(mycelV1)).toBe(true);
    expect(Object.keys(mycelV1)).toEqual(["id", "slugify"]);
    const { slugify } = mycelV1;
    expect(slugify("Two Words")).toBe("two-words");
  });
});

describe("slugify/mycel-v1 readable slugs", () => {
  const cases: ReadonlyArray<readonly [label: string, input: string, expected: string]> = [
    ["latin diacritics fold", "Caf\u00e9 Ol\u00e9", "cafe-ole"],
    ["digits kept", "\u00c5ngstr\u00f6m 42", "angstrom-42"],
    ["one Latin letter keeps its readable slug", "C", "c"],
    ["one digit keeps its readable slug", " 7 ", "7"],
    ["underscores dropped, edge hyphens stripped", "  --Hello__World--  ", "helloworld"],
    ["hyphen and space runs collapse", "a - -  b", "a-b"],
    ["ideographic space separates", "a\u3000b", "a-b"],
    ["already slug-shaped", "x-abc", "x-abc"],
    ["dotted capital I", "\u0130STANBUL", "istanbul"],
    ["stroked L dropped", "\u0141\u00f3d\u017a \u00dcn\u00efcode", "odz-unicode"],
    ["sharp s dropped", "\u00dftra\u00dfe", "trae"],
    ["zero width space dropped, not a separator", "a\u200bb", "ab"],
    ["next line dropped, not a separator", "a\u0085b", "ab"],
    ["mongolian vowel separator dropped", "a\u180eb", "ab"],
    ["lone surrogate dropped", "a\udc00b", "ab"],
    ["two Latin letters survive a dropped letter", "\u03a9 qr", "qr"],
  ];
  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(mycelV1.slugify(input)).toBe(expected);
    });
  }
});

describe("slugify/mycel-v1 digest fallback", () => {
  const cases: ReadonlyArray<readonly [label: string, input: string, expected: string]> = [
    ["empty string is the empty digest", "", "x-e3b0c44298fc"],
    ["one Latin letter left after a drop", "\u03a9 q", "x-bbd7b65dd7f5"],
    ["digest is of the folded name", "  \u03a9   Q ", "x-bbd7b65dd7f5"],
    ["hyphens only", "---", "x-cb3f91d54eee"],
    ["hangul", "\uac00\ub098", "x-91e6619744ca"],
    ["ideographs with one Latin letter", "\u5c71\u5ddd A", "x-2e1aab45fe52"],
    ["titlecase digraph", "\u01c5", "x-bfbc93eb6625"],
    ["sharp s alone", "\u00df", "x-cd3a7e92a911"],
    ["greek with final sigma", "\u03a3\u0391\u03a3", "x-15d4f8e9eed6"],
    ["zero width space alone", " \u200b ", "x-f4e48e664a60"],
    ["replacement character", "\ufffd", "x-83d544ccc223"],
    ["lone low surrogate hashes as U+FFFD", "\udc00", "x-83d544ccc223"],
    ["lone high surrogate hashes as U+FFFD", "\ud800", "x-83d544ccc223"],
  ];
  for (const [label, input, expected] of cases) {
    test(label, () => {
      expect(mycelV1.slugify(input)).toBe(expected);
    });
  }

  test("the empty-string fallback is the SHA-256 of zero bytes", () => {
    expect(createHash("sha256").update("").digest("hex")).toStartWith("e3b0c44298fc");
  });

  test("a non-string throws a TypeError naming name.normalize", () => {
    for (const value of [undefined, null, 5, {}]) {
      expect(() => mycelV1.slugify(value as unknown as string)).toThrow(TypeError);
      expect(() => mycelV1.slugify(value as unknown as string)).toThrow(/name\.normalize/);
    }
  });
});

describe("slugify/mycel-v1 over a seeded set", () => {
  const FRAGMENTS: readonly string[] = [
    "a",
    "Z",
    "q",
    "7",
    "0",
    " ",
    "  ",
    "-",
    "--",
    "_",
    ".",
    "\u00e9",
    "E\u0301",
    "\u00c5",
    "\u00df",
    "\u0130",
    "\u0141",
    "\u01c5",
    "\u03a3",
    "\u03a9",
    "\uac00",
    "\u5c71",
    "\u0416",
    "\u0645",
    "\u{1d400}",
    "\u{1f600}",
    "\ud800",
    "\udc00",
    "\ufffd",
    "\u00a0",
    "\u2000",
    "\u2028",
    "\u3000",
    "\ufeff",
    "\t",
    "\n",
    "\u200b",
    "\u0085",
    "\u180e",
  ];

  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededNames(seed: number, count: number): string[] {
    const next = mulberry32(seed);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      let name = "";
      const length = Math.floor(next() * 9);
      for (let j = 0; j < length; j++) name += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
      names.push(name);
    }
    return names;
  }

  const names = seededNames(20261012, 5000);
  const slugs = names.map((name) => mycelV1.slugify(name));

  test("every slug is hyphen-joined [a-z0-9] runs or an x- digest, and slugs are fixed points", () => {
    const shape = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*|x-[0-9a-f]{12})$/;
    const bad = slugs.filter((slug) => !shape.test(slug) || mycelV1.slugify(slug) !== slug);
    expect(bad).toEqual([]);
  });

  test("the set exercises both branches", () => {
    const fallbacks = slugs.filter((slug) => slug.startsWith("x-")).length;
    expect([fallbacks, slugs.length - fallbacks]).toEqual([3563, 1437]);
  });

  test("pinned digest of every slug in the set", () => {
    expect(createHash("sha256").update(slugs.join("\n")).digest("hex")).toBe(
      "8f9b76b596bd83bb7198cfe37752b9d6b2563041f2115a8b6eddb1ab492b5a31",
    );
  });
});
