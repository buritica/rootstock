import { describe, expect, test } from "bun:test";
import {
  type ConcurrencySlice,
  type ConcurrencySliceInput,
  concurrencySlice,
  width,
} from "./width.ts";

const input: ConcurrencySliceInput = {
  widths: { fetch: { default: 4, max: 8 }, write: { default: 2, max: 2 } },
};

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
}

const parse = (value: unknown): string =>
  message(() => concurrencySlice(value as ConcurrencySliceInput));

describe("concurrencySlice", () => {
  test("parses the widths into a deep-frozen copy", () => {
    const slice = concurrencySlice(input);
    expect(slice).toEqual({
      widths: { fetch: { default: 4, max: 8 }, write: { default: 2, max: 2 } },
    } as unknown as ConcurrencySlice);
    expect(Object.isFrozen(slice)).toBe(true);
    expect(Object.isFrozen(slice.widths)).toBe(true);
    expect(Object.isFrozen(slice.widths.fetch)).toBe(true);
    expect(slice.widths).not.toBe(input.widths);
    expect(slice.widths.fetch).not.toBe(input.widths.fetch);
    // No prototype, so an undeclared "constructor" reads as absent everywhere.
    expect(Object.getPrototypeOf(slice.widths)).toBe(null);
    expect(slice.widths.constructor).toBeUndefined();
  });

  test("accepts the bounds: default 1, and max 256", () => {
    const slice = concurrencySlice({ widths: { fetch: { default: 1, max: 256 } } });
    expect(width(slice, "fetch")).toBe(1);
    expect(width(slice, "fetch", 256)).toBe(256);
  });

  test.each<[string, unknown, string]>([
    ["missing widths", {}, "concurrencySlice: widths is required"],
    ["null input", null, "concurrencySlice: widths is required"],
    ["array input", [], "concurrencySlice: widths is required"],
    ["unknown key with widths absent", { width: {} }, "concurrencySlice: width is not a known key"],
    [
      "empty widths",
      { widths: {} },
      "concurrencySlice: widths must be an object with at least one width — got {}",
    ],
    [
      "array widths",
      { widths: [] },
      "concurrencySlice: widths must be an object with at least one width — got []",
    ],
    [
      "string widths",
      { widths: "fetch" },
      'concurrencySlice: widths must be an object with at least one width — got "fetch"',
    ],
    [
      "unknown top-level key",
      { widths: { fetch: { default: 1, max: 1 } }, profiles: 1 },
      "concurrencySlice: profiles is not a known key",
    ],
    [
      "uppercase name",
      { widths: { Fetch: { default: 1, max: 1 } } },
      'concurrencySlice: widths.Fetch must be a name matching [a-z][a-zA-Z0-9]* — got "Fetch"',
    ],
    [
      "dashed name",
      { widths: { "fetch-all": { default: 1, max: 1 } } },
      'concurrencySlice: widths.fetch-all must be a name matching [a-z][a-zA-Z0-9]* — got "fetch-all"',
    ],
    [
      "missing default",
      { widths: { fetch: { max: 4 } } },
      "concurrencySlice: widths.fetch.default is required",
    ],
    [
      "missing max",
      { widths: { fetch: { default: 4 } } },
      "concurrencySlice: widths.fetch.max is required",
    ],
    [
      "default only inherited",
      { widths: { fetch: Object.assign(Object.create({ default: 1 }), { max: 4 }) } },
      "concurrencySlice: widths.fetch.default is required",
    ],
    [
      "entry that is not an object",
      { widths: { fetch: 4 } },
      "concurrencySlice: widths.fetch.default is required",
    ],
    [
      "unknown key holding a secret-looking value",
      { widths: { fetch: { default: 1, max: 1 } }, url: "postgres://user:secret@db/x" },
      "concurrencySlice: url is not a known key",
    ],
    [
      "unknown width key",
      { widths: { fetch: { default: 1, max: 1, min: 1 } } },
      "concurrencySlice: widths.fetch.min is not a known key",
    ],
    [
      "max 0",
      { widths: { fetch: { default: 1, max: 0 } } },
      "concurrencySlice: widths.fetch.max must be an integer from 1 to 256 — got 0",
    ],
    [
      "max 257",
      { widths: { fetch: { default: 1, max: 257 } } },
      "concurrencySlice: widths.fetch.max must be an integer from 1 to 256 — got 257",
    ],
    [
      "max 1.5",
      { widths: { fetch: { default: 1, max: 1.5 } } },
      "concurrencySlice: widths.fetch.max must be an integer from 1 to 256 — got 1.5",
    ],
    [
      "max as a string",
      { widths: { fetch: { default: 1, max: "4" } } },
      'concurrencySlice: widths.fetch.max must be an integer from 1 to 256 — got "4"',
    ],
    [
      "default 0",
      { widths: { fetch: { default: 0, max: 4 } } },
      "concurrencySlice: widths.fetch.default must be an integer >= 1 and <= max — got 0",
    ],
    [
      "default above max",
      { widths: { fetch: { default: 5, max: 4 } } },
      "concurrencySlice: widths.fetch.default must be an integer >= 1 and <= max — got 5",
    ],
    [
      "default NaN",
      { widths: { fetch: { default: Number.NaN, max: 4 } } },
      "concurrencySlice: widths.fetch.default must be an integer >= 1 and <= max — got null",
    ],
  ])("refuses %s with the exact text", (_label, value, text) => {
    expect(parse(value)).toBe(text);
  });
});

describe("width", () => {
  // Built inside each test, not at collection or in a hook, so a parser
  // regression fails these tests by name instead of erroring the whole block.
  const slice = (): ConcurrencySlice => concurrencySlice(input);

  test("an undefined request gives the default", () => {
    expect(width(slice(), "fetch")).toBe(4);
    expect(width(slice(), "fetch", undefined)).toBe(4);
    expect(width(slice(), "write")).toBe(2);
  });

  test("a request inside the bound is returned as is", () => {
    expect(width(slice(), "fetch", 1)).toBe(1);
    expect(width(slice(), "fetch", 6)).toBe(6);
  });

  test("width-at-max-accepted", () => {
    expect(width(slice(), "fetch", 8)).toBe(8);
    expect(width(slice(), "write", 2)).toBe(2);
  });

  test.each<[string, number, string]>([
    ["above max", 9, 'width: "fetch" requested 9 — must be an integer from 1 to 8'],
    ["zero", 0, 'width: "fetch" requested 0 — must be an integer from 1 to 8'],
    ["negative", -1, 'width: "fetch" requested -1 — must be an integer from 1 to 8'],
    ["fractional", 1.5, 'width: "fetch" requested 1.5 — must be an integer from 1 to 8'],
    ["NaN", Number.NaN, 'width: "fetch" requested null — must be an integer from 1 to 8'],
  ])("refuses a request %s with the exact text", (_label, requested, text) => {
    expect(message(() => width(slice(), "fetch", requested))).toBe(text);
  });

  test("refuses a request that is not a number", () => {
    expect(message(() => width(slice(), "fetch", "2" as unknown as number))).toBe(
      'width: "fetch" requested "2" — must be an integer from 1 to 8',
    );
  });

  test.each(["missing", "toString", "constructor"])("refuses an undeclared name %s", (name) => {
    expect(message(() => width(slice(), name))).toBe(
      `width: no width "${name}" — declared: fetch, write`,
    );
  });

  test("unbranded-slice-refused", () => {
    const literal = { widths: { fetch: { default: 4, max: 8 } } } as unknown as ConcurrencySlice;
    const text =
      "width: expected a ConcurrencySlice built by concurrencySlice() — got an object that parser did not return";
    expect(message(() => width(literal, "fetch"))).toBe(text);
    // A copy of a real slice is not the slice.
    expect(message(() => width({ ...slice() } as ConcurrencySlice, "fetch"))).toBe(text);
    expect(message(() => width(null as unknown as ConcurrencySlice, "fetch"))).toBe(text);
  });

  test("the brand is checked before the name", () => {
    const literal = {} as unknown as ConcurrencySlice;
    expect(message(() => width(literal, "missing"))).toStartWith(
      "width: expected a ConcurrencySlice",
    );
  });
});
