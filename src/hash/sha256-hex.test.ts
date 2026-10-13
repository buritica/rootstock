import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256Hex as goldenSha256Hex } from "../golden/index.ts";
import { sha256Hex } from "./index.ts";

// Expected digests were computed outside JavaScript, from the UTF-8 bytes of
// each input (a lone surrogate written as U+FFFD).
const LITERALS: ReadonlyArray<readonly [label: string, input: string, digest: string]> = [
  ["empty string", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["FIPS abc", "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "FIPS 448-bit message",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  [
    "ASCII",
    "rootstock hashes bytes",
    "3c8db723f3933caa3038d761a14c6d9024563b44a92dea6792d6e39c6435fd73",
  ],
  ["NFC e-acute", "caf\u00e9", "850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e"],
  [
    "NFD e + U+0301",
    "cafe\u0301",
    "81ef060bcd98adc7824eb5c1ada83c32491b16018e11e79f00ab9d09e04b015a",
  ],
  [
    "astral code point",
    "\u{1F331} seedling",
    "877c8f908c21c12791604ac12d38da011d1a131509bb6ea200444b23a6427f1a",
  ],
  [
    "lone high surrogate",
    "\uD800",
    "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097",
  ],
  [
    "lone low surrogate mid-string",
    "a\uDC00b",
    "05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b",
  ],
  [
    "reversed surrogate pair",
    "\uDC00\uD800",
    "52793f8dc1d85e409f8c88be99d8b31d58f676246340150f406289e04a11151e",
  ],
  ["NUL", "a\u0000b", "59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138"],
  ["leading BOM", "\uFEFFbom", "2623148f0d047ef6feae63422c0d60741888ae7f45fd979ba232e1c975c14702"],
  ["CR", "a\rb", "af9081672dd5ef3247a30c2db5b0dafcc9bcf981a26aefb3c55d210d43fcc14e"],
  ["LF", "a\nb", "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78"],
  ["CRLF", "a\r\nb", "18745f36a05e29072709042d6062ce54f1b08ff36c27ba80c39f81fb010c8ce2"],
  [
    "100k characters",
    "x".repeat(100_000),
    "d69e68988157833272305aaf21f453c800346e8a3640db6578e260215542e5d4",
  ],
];

describe("sha256Hex", () => {
  for (const [label, input, digest] of LITERALS) {
    test(`${label}: literal digest, and parity with node:crypto and the golden hasher`, () => {
      expect(sha256Hex(input)).toBe(digest);
      expect(createHash("sha256").update(input, "utf8").digest("hex")).toBe(digest);
      expect(goldenSha256Hex(input)).toBe(digest);
    });
  }

  test("a lone surrogate hashes as U+FFFD", () => {
    expect(sha256Hex("\uD800")).toBe(sha256Hex("\uFFFD"));
    expect(sha256Hex("\uDC00")).toBe(sha256Hex("\uFFFD"));
  });

  test("no normalization: NFC and NFD spellings differ", () => {
    expect(sha256Hex("caf\u00e9")).not.toBe(sha256Hex("cafe\u0301"));
  });

  test("a Uint8Array hashes its bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(sha256Hex(bytes)).toBe(
      "3f2d1552cdc7483f40dd720c80b900225dfecfd5cae7cd168d79ab6ee5959885",
    );
    expect(goldenSha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  test("a subarray view hashes only the bytes it views", () => {
    const view = new Uint8Array([0, 1, 2, 253, 254, 255]).subarray(2, 5);
    expect(view.byteOffset).toBe(2);
    expect(view.buffer.byteLength).toBe(6);
    expect(sha256Hex(view)).toBe(
      "6db5d349e72a2e80a94302b9dddc4ae3fd597b7ab674c7f951166e7cf17661fb",
    );
    expect(sha256Hex(view)).toBe(sha256Hex(new Uint8Array([2, 253, 254])));
    expect(goldenSha256Hex(view)).toBe(sha256Hex(view));
  });

  test("UTF-8 bytes and the string hash the same", () => {
    const text = "\u{1F331} seedling";
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(sha256Hex(text));
  });

  test("the golden harness keeps its own node:crypto implementation, not the hash subpath", async () => {
    expect(goldenSha256Hex).not.toBe(sha256Hex);

    const goldenDir = new URL("../golden/", import.meta.url).pathname;
    const sources = [...new Bun.Glob("*.ts").scanSync(goldenDir)].filter(
      (name) => !name.endsWith(".test.ts"),
    );
    expect(sources).toContain("canonical.ts");

    // Collect every module specifier the harness sources import or re-export.
    const specifier = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
    const hashSubpath = /(^|\/)(hash|sha256-hex)(\/|\.|$)|^@buritica\/rootstock\/hash/;
    const offending: string[] = [];
    for (const name of sources) {
      const text = await Bun.file(`${goldenDir}${name}`).text();
      for (const match of text.matchAll(specifier)) {
        if (hashSubpath.test(match[1] ?? "")) offending.push(`${name}: ${match[1]}`);
      }
    }
    expect(offending).toEqual([]);

    const canonical = await Bun.file(`${goldenDir}canonical.ts`).text();
    expect(canonical).toMatch(/from\s+["']node:crypto["']/);
    expect(canonical).toMatch(/createHash\(\s*["']sha256["']\s*\)/);
  });
});

test("export surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/hash")).sort()).toEqual(["sha256Hex"]);
});
