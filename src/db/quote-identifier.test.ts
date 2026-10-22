import { describe, expect, test } from "bun:test";
import { quoteIdentifier } from "./quote-identifier.ts";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "(did not throw)";
}

const refusal = (value: unknown) =>
  `rootstock: identifier must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${JSON.stringify(value)}`;

describe("quoteIdentifier", () => {
  test("a valid identifier comes back double-quoted", () => {
    expect(quoteIdentifier("rootstock")).toBe('"rootstock"');
    expect(quoteIdentifier("_x9")).toBe('"_x9"');
    expect(quoteIdentifier("rs_t_0a1b")).toBe('"rs_t_0a1b"');
  });

  test("a 32-hex test schema name passes, with and without a suffix", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(quoteIdentifier(`test_${hex}`)).toBe(`"test_${hex}"`);
    expect(quoteIdentifier(`test_${hex}_rs`)).toBe(`"test_${hex}_rs"`);
  });

  test("63 bytes is the longest accepted", () => {
    expect(quoteIdentifier("a".repeat(63))).toBe(`"${"a".repeat(63)}"`);
  });

  test("identifier-64-bytes-refused", () => {
    const name = "a".repeat(64);
    expect(messageOf(() => quoteIdentifier(name))).toBe(refusal(name));
  });

  test("a non-string is refused, even one whose string form would pass", () => {
    for (const value of [undefined, null, 123, ["ok"]]) {
      expect(messageOf(() => quoteIdentifier(value as unknown as string))).toBe(refusal(value));
    }
  });

  test("names outside [a-z_][a-z0-9_]* are refused with E-ID", () => {
    for (const name of ["", "Root", "9lives", "rs-t", 'x"y', "rs t", "é", "a;drop"]) {
      expect(messageOf(() => quoteIdentifier(name))).toBe(refusal(name));
    }
  });
});
