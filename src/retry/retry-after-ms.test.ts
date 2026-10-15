import { describe, expect, test } from "bun:test";
import { retryAfterMs } from "./retry-after-ms.ts";

// Literal expectations, derived from the documented rule rather than from running the code:
// seconds = Number(header); falsy header, non-finite or non-positive seconds -> defaultMs;
// otherwise min(seconds * 1000, capMs).
const BOUNDS = { defaultMs: 10_000, capMs: 120_000 };

describe("retryAfterMs", () => {
  const rows: [label: string, header: string | null, want: number][] = [
    ["null header", null, 10_000],
    ["empty string", "", 10_000],
    ["zero", "0", 10_000],
    ["negative zero", "-0", 10_000],
    ["negative", "-1", 10_000],
    ["tiny positive", "0.0001", 0.1],
    ["fractional seconds", "1.5", 1500],
    ["padded with spaces", " 2 ", 2000],
    ["hex literal", "0x10", 16_000],
    ["exponent", "1e2", 100_000],
    ["Infinity", "Infinity", 10_000],
    ["negative Infinity", "-Infinity", 10_000],
    ["not a number", "soon", 10_000],
    ["HTTP-date form is unparsable", "Wed, 21 Oct 2026 07:28:00 GMT", 10_000],
    ["one second below the cap", "119", 119_000],
    ["exactly the cap", "120", 120_000],
    ["one second above the cap", "121", 120_000],
    ["far above the cap", "100000", 120_000],
  ];
  for (const [label, header, want] of rows) {
    test(label, () => {
      expect(retryAfterMs(header, BOUNDS)).toBe(want);
    });
  }

  test("both bounds are taken from the argument", () => {
    expect(retryAfterMs(null, { defaultMs: 5000, capMs: 30_000 })).toBe(5000);
    expect(retryAfterMs("31", { defaultMs: 5000, capMs: 30_000 })).toBe(30_000);
    expect(retryAfterMs("29", { defaultMs: 5000, capMs: 30_000 })).toBe(29_000);
  });

  test("a default above the cap is returned as given", () => {
    expect(retryAfterMs("", { defaultMs: 500_000, capMs: 1000 })).toBe(500_000);
  });
});
