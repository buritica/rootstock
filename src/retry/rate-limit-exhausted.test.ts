import { describe, expect, test } from "bun:test";
import { isRateLimitExhausted, mentionsRateLimitExhausted } from "./rate-limit-exhausted.ts";

const THROTTLE = "svc: conversations.history rate-limited 3 times — halting rather than hammering";
const TRANSIENT =
  "svc: conversations.history still failing after 5 attempts — halting rather than hammering";

describe("mentionsRateLimitExhausted", () => {
  const rows: [label: string, text: string, want: boolean][] = [
    ["the throttle sentence", THROTTLE, true],
    ["inside a wrapper, before", `run failed: ${THROTTLE}`, true],
    ["inside a wrapper, after", `${THROTTLE} (2 more channels skipped)`, true],
    ["multi-digit count", "x rate-limited 12 times — halting rather than hammering", true],
    ["the transient sentence", TRANSIENT, false],
    [
      "hyphen in place of the em dash",
      "x rate-limited 3 times - halting rather than hammering",
      false,
    ],
    [
      "en dash in place of the em dash",
      "x rate-limited 3 times – halting rather than hammering",
      false,
    ],
    ["non-numeric count", "x rate-limited 1x times — halting rather than hammering", false],
    [
      "empty count between two spaces",
      "x rate-limited  times — halting rather than hammering",
      false,
    ],
    ["missing count", "x rate-limited times — halting rather than hammering", false],
    [
      "no leading space before the phrase",
      "rate-limited 3 times — halting rather than hammering",
      false,
    ],
    ["empty text", "", false],
  ];
  for (const [label, text, want] of rows) {
    test(label, () => {
      expect(mentionsRateLimitExhausted(text)).toBe(want);
    });
  }

  test("is stateless across calls", () => {
    expect(mentionsRateLimitExhausted(THROTTLE)).toBe(true);
    expect(mentionsRateLimitExhausted(THROTTLE)).toBe(true);
    expect(mentionsRateLimitExhausted(TRANSIENT)).toBe(false);
  });
});

describe("isRateLimitExhausted", () => {
  test("an Error carrying the throttle sentence", () => {
    expect(isRateLimitExhausted(new Error(THROTTLE))).toBe(true);
  });

  test("an Error wrapping it in a longer message", () => {
    expect(isRateLimitExhausted(new Error(`aggregate: ${THROTTLE}; other: boom`))).toBe(true);
  });

  test("an Error subclass counts", () => {
    class Wrapped extends Error {}
    expect(isRateLimitExhausted(new Wrapped(THROTTLE))).toBe(true);
  });

  test("the transient sentence is not it", () => {
    expect(isRateLimitExhausted(new Error(TRANSIENT))).toBe(false);
  });

  test("only the message is read, not the cause", () => {
    expect(isRateLimitExhausted(new Error("outer", { cause: new Error(THROTTLE) }))).toBe(false);
  });

  test("non-Error values are never it, even with the right text", () => {
    expect(isRateLimitExhausted(THROTTLE)).toBe(false);
    expect(isRateLimitExhausted({ message: THROTTLE })).toBe(false);
    expect(isRateLimitExhausted(null)).toBe(false);
    expect(isRateLimitExhausted(undefined)).toBe(false);
  });
});
