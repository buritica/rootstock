import { describe, expect, test } from "bun:test";
import { notionEventAge, notionSignatureMatches } from "./notion.ts";

// Literal digests: HMAC-SHA256 of the raw body, computed once outside this suite and
// cross-checked with `openssl dgst -sha256 -hmac`.
const TOKEN = "tok-123";
const BODY = '{"type":"page.created"}';
const DIGEST = "3991c826ecc56d7471eb78d6abbfdbeeba54ddf693d41d1d8bbad3c62068e711";
const DIGEST_EMPTY_BODY = "df11be376697349d650e038434b0c3efb2d43d701a55f4b1c6145a2691b13053";
const DIGEST_EMPTY_TOKEN = "de17fa3cc00d6e3f4329e79782e409cbb753cb6e0d496e9063e639a5248bc752";
const VALID = `sha256=${DIGEST}`;

describe("notionSignatureMatches (strict, decision D2)", () => {
  const rows: [label: string, body: string, header: string | null, token: string, want: boolean][] =
    [
      ["valid signature", BODY, VALID, TOKEN, true],
      ["valid signature over an empty body", "", `sha256=${DIGEST_EMPTY_BODY}`, TOKEN, true],
      ["uppercase hex is accepted", BODY, `sha256=${DIGEST.toUpperCase()}`, TOKEN, true],
      [
        "mixed-case hex is accepted",
        BODY,
        `sha256=${DIGEST.slice(0, 32).toUpperCase()}${DIGEST.slice(32)}`,
        TOKEN,
        true,
      ],
      // Strict per D2: trailing data after the 64th digit is rejected, not ignored.
      ["valid digest plus one hex digit", BODY, `${VALID}0`, TOKEN, false],
      ["valid digest plus non-hex", BODY, `${VALID}zz`, TOKEN, false],
      ["valid digest plus a trailing newline", BODY, `${VALID}\n`, TOKEN, false],
      ["62 hex digits", BODY, VALID.slice(0, -2), TOKEN, false],
      ["63 hex digits", BODY, VALID.slice(0, -1), TOKEN, false],
      ["65 hex digits", BODY, `${VALID}a`, TOKEN, false],
      ["66 hex digits", BODY, `${VALID}ab`, TOKEN, false],
      ["well-shaped but different digest", BODY, `sha256=${"0".repeat(64)}`, TOKEN, false],
      ["wrong token", BODY, VALID, "tok-124", false],
      ["wrong body", `${BODY} `, VALID, TOKEN, false],
      ["uppercase prefix", BODY, `SHA256=${DIGEST}`, TOKEN, false],
      ["leading space", BODY, ` ${VALID}`, TOKEN, false],
      ["bare prefix", BODY, "sha256=", TOKEN, false],
      ["bare digest without prefix", BODY, DIGEST, TOKEN, false],
      ["64 non-hex digits", BODY, `sha256=${"g".repeat(64)}`, TOKEN, false],
      ["multi-byte character in place of a digit", BODY, `${VALID.slice(0, -1)}é`, TOKEN, false],
      ["empty header", BODY, "", TOKEN, false],
      ["null header", BODY, null, TOKEN, false],
      // An empty key is a valid HMAC key, so this header IS the correct digest under "";
      // strict mode refuses it anyway.
      [
        "empty token, header signed with the empty key",
        BODY,
        `sha256=${DIGEST_EMPTY_TOKEN}`,
        "",
        false,
      ],
      ["empty token and empty header", BODY, "", "", false],
    ];
  for (const [label, body, header, token, want] of rows) {
    test(label, () => {
      expect(() => notionSignatureMatches(body, header, token)).not.toThrow();
      expect(notionSignatureMatches(body, header, token)).toBe(want);
    });
  }
});

const BOUNDS = { maxEventAgeSeconds: 90000, maxFutureSkewSeconds: 300 };

function counted(nowMs: number): { now: () => number; calls: () => number } {
  let n = 0;
  return {
    now: () => {
      n += 1;
      return nowMs;
    },
    calls: () => n,
  };
}

describe("notionEventAge (90000 s old, 300 s future)", () => {
  // Every parseable input carries an explicit `Z` or offset, so the suite does not depend
  // on the host time zone.
  const rows: [label: string, timestamp: string, nowMs: number, want: unknown][] = [
    ["same instant", "1970-01-01T00:00:00Z", 0, { kind: "plausible", ageSeconds: 0 }],
    [
      "exactly 90000 old",
      "1970-01-01T00:00:00Z",
      90_000_000,
      { kind: "plausible", ageSeconds: 90000 },
    ],
    [
      "90000.001 old",
      "1970-01-01T00:00:00Z",
      90_000_001,
      { kind: "implausible", ageSeconds: 90000.001 },
    ],
    [
      "exactly 300 in the future",
      "1970-01-01T00:00:00Z",
      -300_000,
      { kind: "plausible", ageSeconds: -300 },
    ],
    [
      "300.001 in the future",
      "1970-01-01T00:00:00Z",
      -300_001,
      { kind: "implausible", ageSeconds: -300.001 },
    ],
    [
      "age is not rounded",
      "1970-01-01T00:00:00.500Z",
      1_000,
      { kind: "plausible", ageSeconds: 0.5 },
    ],
    ["positive offset", "1970-01-01T01:00:00+01:00", 0, { kind: "plausible", ageSeconds: 0 }],
    ["negative offset", "1969-12-31T19:00:00-05:00", 60_000, { kind: "plausible", ageSeconds: 60 }],
    [
      "a realistic instant",
      "2026-10-12T12:00:00.000Z",
      1_791_806_400_000 + 1_000,
      { kind: "plausible", ageSeconds: 1 },
    ],
    [
      "two days old",
      "2026-10-10T12:00:00Z",
      1_791_806_400_000,
      { kind: "implausible", ageSeconds: 172800 },
    ],
  ];
  for (const [label, timestamp, nowMs, want] of rows) {
    test(label, () => {
      const clock = counted(nowMs);
      expect(notionEventAge(timestamp, clock.now, BOUNDS)).toEqual(want as never);
      expect(clock.calls()).toBe(1);
    });
  }
});

describe("notionEventAge: unusable inputs never read the clock", () => {
  const rows: [label: string, timestamp: unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 1_791_806_400_000],
    ["a Date object", new Date(0)],
    ["an object", { timestamp: "1970-01-01T00:00:00Z" }],
    ["empty string", ""],
    ["not a date", "not a date"],
    ["month 13", "2026-13-01T00:00:00Z"],
  ];
  for (const [label, timestamp] of rows) {
    test(label, () => {
      const clock = counted(0);
      expect(notionEventAge(timestamp, clock.now, BOUNDS)).toEqual({ kind: "unusable" });
      expect(clock.calls()).toBe(0);
    });
  }
});

describe("notionEventAge: the bounds are the caller's", () => {
  const rows: [label: string, bounds: typeof BOUNDS, nowMs: number, want: unknown][] = [
    [
      "10 old under a 10 s limit",
      { maxEventAgeSeconds: 10, maxFutureSkewSeconds: 5 },
      10_000,
      { kind: "plausible", ageSeconds: 10 },
    ],
    [
      "11 old under a 10 s limit",
      { maxEventAgeSeconds: 10, maxFutureSkewSeconds: 5 },
      11_000,
      { kind: "implausible", ageSeconds: 11 },
    ],
    [
      "5 ahead under a 5 s skew",
      { maxEventAgeSeconds: 10, maxFutureSkewSeconds: 5 },
      -5_000,
      { kind: "plausible", ageSeconds: -5 },
    ],
    [
      "6 ahead under a 5 s skew",
      { maxEventAgeSeconds: 10, maxFutureSkewSeconds: 5 },
      -6_000,
      { kind: "implausible", ageSeconds: -6 },
    ],
    [
      "zero skew allows no future",
      { maxEventAgeSeconds: 10, maxFutureSkewSeconds: 0 },
      -1,
      { kind: "implausible", ageSeconds: -0.001 },
    ],
  ];
  for (const [label, bounds, nowMs, want] of rows) {
    test(label, () => {
      expect(notionEventAge("1970-01-01T00:00:00Z", () => nowMs, bounds)).toEqual(want as never);
    });
  }
});
