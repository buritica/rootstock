import { describe, expect, test } from "bun:test";
import { chunkingParamFingerprint, InvalidChunkingParamsError } from "./index.ts";

// Expected digests were computed outside JavaScript, from the preimage text
// shown beside each one.
const KEYS = ["window", "step", "margin"] as const;
// preimage [["window",400],["step",1.05],["margin",8]]
const PINNED = "7106d2b6da771ff0a79da3d62fe893ea2982cb15b88a769b4f2428791c1ce18d";
// preimage [["step",1.05],["window",400],["margin",8]]
const REORDERED_KEYS = "4c335f3b20077fbe57cae5789b78bf4bb4a042312dfa25b75084f39619154fce";
// preimages [["a",1]], [["a",0]], [["a",1e+21]]
const A_ONE = "38d8e023d06e961f835363c4dcad75b818c7e4ca3be9425664f707a69835e209";
const A_ZERO = "6f5da5f0ac3daaeaf13012aea3318a24321013fcb83b780bab214758dbcc9b08";
const A_1E21 = "d596036e7598d999bb686131d89c08e7774b9c9328bd54a913552df2d8b024a4";

// The refusal paths are exercised with inputs the type system would reject,
// so they go through an untyped alias.
const fingerprint = chunkingParamFingerprint as (keys: readonly string[], params: object) => string;

function refusal(keys: readonly string[], params: object): { name: string; message: string } {
  try {
    fingerprint(keys, params);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidChunkingParamsError);
    expect(error).toBeInstanceOf(Error);
    const { name, message } = error as Error;
    return { name, message };
  }
  throw new Error("expected a refusal");
}

describe("chunkingParamFingerprint digests", () => {
  test("pinned digest", () => {
    expect(chunkingParamFingerprint(KEYS, { window: 400, step: 1.05, margin: 8 })).toBe(PINNED);
  });

  test("the order of properties on params is irrelevant", () => {
    expect(chunkingParamFingerprint(KEYS, { margin: 8, step: 1.05, window: 400 })).toBe(PINNED);
    expect(chunkingParamFingerprint(KEYS, { step: 1.05, margin: 8, window: 400 })).toBe(PINNED);
  });

  test("the order of the key list matters", () => {
    const params = { window: 400, step: 1.05, margin: 8 };
    expect(chunkingParamFingerprint(["step", "window", "margin"], params)).toBe(REORDERED_KEYS);
  });

  test("every value moves the digest", () => {
    expect(chunkingParamFingerprint(KEYS, { window: 401, step: 1.05, margin: 8 })).not.toBe(PINNED);
    expect(chunkingParamFingerprint(KEYS, { window: 400, step: 1.06, margin: 8 })).not.toBe(PINNED);
    expect(chunkingParamFingerprint(KEYS, { window: 400, step: 1.05, margin: 9 })).not.toBe(PINNED);
  });

  test("numbers serialize as JSON writes them", () => {
    expect(chunkingParamFingerprint(["a"], { a: 1 })).toBe(A_ONE);
    expect(chunkingParamFingerprint(["a"], { a: 1.0 })).toBe(A_ONE);
    expect(chunkingParamFingerprint(["a"], { a: 0 })).toBe(A_ZERO);
    expect(chunkingParamFingerprint(["a"], { a: -0 })).toBe(A_ZERO);
    expect(chunkingParamFingerprint(["a"], { a: 1e21 })).toBe(A_1E21);
  });

  test("is synchronous and returns 64 lowercase hex", () => {
    const out = chunkingParamFingerprint(["a"], { a: 1 });
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("chunkingParamFingerprint refusals", () => {
  const name = "InvalidChunkingParamsError";
  const CASES: ReadonlyArray<
    readonly [label: string, keys: readonly string[], params: object, message: string]
  > = [
    [
      "duplicate keys, all reported, sorted",
      ["b", "a", "b", "c", "a", "b"],
      { a: 1, b: 2, c: 3 },
      "duplicate chunking param key(s): a, b",
    ],
    [
      "duplicate keys win over an unknown key",
      ["a", "a"],
      { a: 1, zz: 2 },
      "duplicate chunking param key(s): a",
    ],
    [
      "unknown keys, all reported, sorted",
      ["a"],
      { a: 1, z: 2, m: 3, b: 4 },
      "unknown chunking param key(s): b, m, z",
    ],
    [
      "an unknown key wins over a NaN value",
      ["a"],
      { a: Number.NaN, extra: 1 },
      "unknown chunking param key(s): extra",
    ],
    [
      "a missing key",
      ["a", "b"],
      { a: 1 },
      'chunking param "b" must be a finite number, got undefined',
    ],
    ["NaN", ["a"], { a: Number.NaN }, 'chunking param "a" must be a finite number, got NaN'],
    [
      "+Infinity",
      ["a"],
      { a: Number.POSITIVE_INFINITY },
      'chunking param "a" must be a finite number, got Infinity',
    ],
    [
      "-Infinity",
      ["a"],
      { a: Number.NEGATIVE_INFINITY },
      'chunking param "a" must be a finite number, got -Infinity',
    ],
    ["a numeric string", ["a"], { a: "3" }, 'chunking param "a" must be a finite number, got 3'],
    [
      "the first failing key in key-list order wins",
      ["c", "b", "a"],
      { a: Number.NaN, b: "3", c: 1 },
      'chunking param "b" must be a finite number, got 3',
    ],
  ];

  for (const [label, keys, params, message] of CASES) {
    test(label, () => {
      expect(refusal(keys, params)).toEqual({ name, message });
    });
  }

  test("name is an own field of each instance, not only the prototype", () => {
    const error = new InvalidChunkingParamsError("x");
    expect(Object.hasOwn(error, "name")).toBe(true);
    expect(error.name).toBe(name);
    expect(error.message).toBe("x");
    expect(error).toBeInstanceOf(InvalidChunkingParamsError);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("InvalidChunkingParamsError: x");
  });
});

test("export surface", async () => {
  expect(Object.keys(await import("@buritica/rootstock/chunking-version")).sort()).toEqual([
    "InvalidChunkingParamsError",
    "chunkingParamFingerprint",
  ]);
});
