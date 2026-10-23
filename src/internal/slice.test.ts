import { describe, expect, test } from "bun:test";
import { concurrencySlice } from "../concurrency/index.ts";
import { clientSlice } from "../db/index.ts";
import { migrateSlice } from "../migrate/index.ts";
import { q, sliceBrand, sliceRefusals } from "./slice.ts";

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
};

describe("q", () => {
  test.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [4, "4"],
    ["4", '"4"'],
    [null, "null"],
    [5n, "5n"],
    // Only a top-level number is spelled out; JSON's rendering stands inside.
    [[Number.NaN], "[null]"],
  ])("%p prints as %s", (value, text) => {
    expect(q(value)).toBe(text);
  });

  test("a cycle still yields text", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(q(cyclic)).toBe("an unserializable value");
  });
});

describe("sliceRefusals", () => {
  const refuse = sliceRefusals("p");

  test("record refuses anything but a plain object, echoing it", () => {
    expect(refuse.record("a.b", { x: 1 })).toEqual({ x: 1 });
    for (const [value, shown] of [
      [4, "4"],
      [null, "null"],
      [[], "[]"],
      ["s", '"s"'],
    ] as const) {
      expect(messageOf(() => refuse.record("a.b", value))).toBe(
        `p: a.b must be an object — got ${shown}`,
      );
    }
  });

  test("an unknown key never echoes its value", () => {
    expect(
      messageOf(() => refuse.refuseUnknownKeys({ url: "pg://u:secret@h" }, new Set(), "a.")),
    ).toBe("p: a.url is not a known key");
  });
});

describe("sliceBrand", () => {
  test("only a marked object passes, and the refusal names the caller", () => {
    const brand = sliceBrand<{ n: number }>("Thing", "thing");
    const marked = brand.mark({ n: 1 });
    expect(brand.has(marked)).toBe(true);
    expect(brand.has({ n: 1 })).toBe(false);
    expect(messageOf(() => brand.assert("use", { n: 1 }))).toBe(
      "use: expected a Thing built by thing() — got an object that parser did not return",
    );
  });
});

// One refusal order in every parser: unknown keys, then required fields,
// then values, at every level.
describe("the three slice parsers check in one order", () => {
  test.each([
    [
      "clientSlice, top level",
      () => clientSlice({ profile: {} } as never),
      "clientSlice: profile is not a known key",
    ],
    [
      "concurrencySlice, top level",
      () => concurrencySlice({ width: {} } as never),
      "concurrencySlice: width is not a known key",
    ],
    [
      "migrateSlice, top level",
      () => migrateSlice({ ahaed: "refuse" } as never),
      "migrateSlice: ahaed is not a known key",
    ],
    [
      "clientSlice, in an entry",
      () => clientSlice({ profiles: { app: { maxx: 1 } } } as never),
      "clientSlice: profiles.app.maxx is not a known key",
    ],
    [
      "concurrencySlice, in an entry",
      () => concurrencySlice({ widths: { fetch: { mx: 1 } } } as never),
      "concurrencySlice: widths.fetch.mx is not a known key",
    ],
  ])("%s: an unknown key is named before a missing field", (_label, run, text) => {
    expect(messageOf(run)).toBe(text);
  });

  test.each([
    [
      "clientSlice",
      () => clientSlice({ profiles: { app: 4 } } as never),
      "clientSlice: profiles.app must be an object — got 4",
    ],
    [
      "concurrencySlice",
      () => concurrencySlice({ widths: { fetch: 4 } } as never),
      "concurrencySlice: widths.fetch must be an object — got 4",
    ],
  ])("%s: an entry that is not an object says so", (_label, run, text) => {
    expect(messageOf(run)).toBe(text);
  });

  test.each([
    ["clientSlice", () => clientSlice(null as never), "clientSlice: profiles is required"],
    [
      "concurrencySlice",
      () => concurrencySlice(null as never),
      "concurrencySlice: widths is required",
    ],
    ["migrateSlice", () => migrateSlice(null as never), "migrateSlice: ahead is required"],
  ])("%s: a missing input refuses like an empty one", (_label, run, text) => {
    expect(messageOf(run)).toBe(text);
  });
});
