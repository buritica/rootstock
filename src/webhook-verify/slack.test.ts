import { describe, expect, test } from "bun:test";
import { type SlackVerifyInput, slackSignatureMatches, verifySlackRequest } from "./slack.ts";

// Literal digests: HMAC-SHA256 of `v0:<timestamp>:<body>`, computed once outside this suite
// and cross-checked with `openssl dgst -sha256 -hmac`.
const SECRET = "s3cret";
const TS = "1700000000";
const BODY = '{"a":1}';
const SIG = "v0=bd185b05da99402f371e04f620aeca81515f08c0ef7fcf979fccaa4d2f87d47c";
const SIG_EMPTY_BODY = "v0=3dca9c196245317cb04ffa45810b5530cc4db2c5ae33b77da61ab2e6633b016f";
const SIG_EMPTY_SECRET_HELLO =
  "v0=1d1506566a49e489b5aa154d9f2b82eb6ec32c7e9c07951bfe6cfcaf61725d11";
const OTHER_HEX = "v0=0000000000000000000000000000000000000000000000000000000000000000";

describe("slackSignatureMatches", () => {
  const rows: [
    label: string,
    secret: string,
    ts: string,
    body: string,
    provided: string,
    want: boolean,
  ][] = [
    ["valid signature", SECRET, TS, BODY, SIG, true],
    ["valid signature over an empty body", SECRET, TS, "", SIG_EMPTY_BODY, true],
    ["empty secret still computes and compares", "", TS, "hello", SIG_EMPTY_SECRET_HELLO, true],
    ["empty secret, signature made with another secret", "", TS, BODY, SIG, false],
    ["wrong secret", "other", TS, BODY, SIG, false],
    ["wrong timestamp", SECRET, "1700000001", BODY, SIG, false],
    ["wrong body", SECRET, TS, '{"a":2}', SIG, false],
    ["well-shaped but different digest", SECRET, TS, BODY, OTHER_HEX, false],
    [
      "uppercase hex is not the v0 shape",
      SECRET,
      TS,
      BODY,
      `v0=${SIG.slice(3).toUpperCase()}`,
      false,
    ],
    ["uppercase prefix", SECRET, TS, BODY, `V0=${SIG.slice(3)}`, false],
    ["other version prefix", SECRET, TS, BODY, `v1=${SIG.slice(3)}`, false],
    ["63 hex digits", SECRET, TS, BODY, SIG.slice(0, -1), false],
    ["65 hex digits", SECRET, TS, BODY, `${SIG}0`, false],
    ["trailing newline", SECRET, TS, BODY, `${SIG}\n`, false],
    ["leading space", SECRET, TS, BODY, ` ${SIG}`, false],
    ["empty header", SECRET, TS, BODY, "", false],
    ["bare prefix", SECRET, TS, BODY, "v0=", false],
    ["64 non-hex digits", SECRET, TS, BODY, `v0=${"g".repeat(64)}`, false],
    // 67 UTF-16 units but 68 UTF-8 bytes: refused by shape, never reaches the compare.
    ["multi-byte character in a 67-unit header", SECRET, TS, BODY, `${SIG.slice(0, -1)}é`, false],
    ["astral character in place of two digits", SECRET, TS, BODY, `${SIG.slice(0, -2)}😀`, false],
  ];
  for (const [label, secret, ts, body, provided, want] of rows) {
    test(label, () => {
      expect(slackSignatureMatches(secret, ts, body, provided)).toBe(want);
    });
  }
});

interface Spied {
  input: SlackVerifyInput;
  calls: { now: number; readBody: number };
}

function spied(
  overrides: Partial<Omit<SlackVerifyInput, "now" | "readBody">>,
  nowMs: number,
): Spied {
  const calls = { now: 0, readBody: 0 };
  const input: SlackVerifyInput = {
    signingSecret: SECRET,
    signature: SIG,
    timestamp: TS,
    ...overrides,
    now: () => {
      calls.now += 1;
      return nowMs;
    },
    readBody: async () => {
      calls.readBody += 1;
      return BODY;
    },
  };
  return { input, calls };
}

const AT_TS = 1_700_000_000_000;
const WINDOW = { timestampWindowSeconds: 300 };

describe("verifySlackRequest: frozen order, call counts per branch", () => {
  type Row = [
    label: string,
    overrides: Partial<Omit<SlackVerifyInput, "now" | "readBody">>,
    nowMs: number,
    want: unknown,
    calls: { now: number; readBody: number },
  ];
  const rows: Row[] = [
    [
      "undefined secret",
      { signingSecret: undefined },
      AT_TS,
      { ok: false, reason: "unconfigured" },
      { now: 0, readBody: 0 },
    ],
    [
      "empty secret",
      { signingSecret: "" },
      AT_TS,
      { ok: false, reason: "unconfigured" },
      { now: 0, readBody: 0 },
    ],
    [
      "unconfigured wins over missing headers",
      { signingSecret: undefined, signature: null, timestamp: null },
      AT_TS,
      { ok: false, reason: "unconfigured" },
      { now: 0, readBody: 0 },
    ],
    [
      "missing signature",
      { signature: null },
      AT_TS,
      { ok: false, reason: "bad_signature" },
      { now: 0, readBody: 0 },
    ],
    [
      "missing timestamp",
      { timestamp: null },
      AT_TS,
      { ok: false, reason: "bad_signature" },
      { now: 0, readBody: 0 },
    ],
    [
      "missing signature wins over a stale timestamp",
      { signature: null, timestamp: "abc" },
      AT_TS,
      { ok: false, reason: "bad_signature" },
      { now: 0, readBody: 0 },
    ],
    [
      "stale timestamp wins over a bad signature",
      { signature: "nope", timestamp: "1" },
      AT_TS,
      { ok: false, reason: "stale_timestamp", skewSeconds: 1_699_999_999 },
      { now: 1, readBody: 0 },
    ],
    ["valid request", {}, AT_TS, { ok: true, body: BODY }, { now: 1, readBody: 1 }],
    [
      "bad signature after a fresh timestamp",
      { signature: OTHER_HEX },
      AT_TS,
      { ok: false, reason: "bad_signature" },
      { now: 1, readBody: 1 },
    ],
    [
      "uppercase signature after a fresh timestamp",
      { signature: `v0=${SIG.slice(3).toUpperCase()}` },
      AT_TS,
      { ok: false, reason: "bad_signature" },
      { now: 1, readBody: 1 },
    ],
    [
      // 11 digits with a leading zero pass the shape and the window, but the signed
      // string is the header text, so the signature over "1700000000" no longer matches.
      "11-digit zero-padded timestamp is signed as written",
      { timestamp: "01700000000" },
      AT_TS,
      { ok: false, reason: "bad_signature" },
      { now: 1, readBody: 1 },
    ],
  ];
  for (const [label, overrides, nowMs, want, wantCalls] of rows) {
    test(label, async () => {
      const { input, calls } = spied(overrides, nowMs);
      expect(await verifySlackRequest(input, WINDOW)).toEqual(want as never);
      expect(calls).toEqual(wantCalls);
    });
  }
});

describe("verifySlackRequest: timestamp window (300 s)", () => {
  const rows: [label: string, nowMs: number, want: unknown][] = [
    ["skew 0", AT_TS, { ok: true, body: BODY }],
    ["skew +300 is inside", AT_TS + 300_000, { ok: true, body: BODY }],
    ["skew -300 is inside", AT_TS - 300_000, { ok: true, body: BODY }],
    [
      "skew +301 is stale",
      AT_TS + 301_000,
      { ok: false, reason: "stale_timestamp", skewSeconds: 301 },
    ],
    [
      "skew -301 is stale",
      AT_TS - 301_000,
      { ok: false, reason: "stale_timestamp", skewSeconds: -301 },
    ],
    // Math.round rounds half toward +infinity: -300.5 → -300 (inside), +300.5 → 301 (stale).
    ["raw -300.5 rounds to -300 and passes", AT_TS - 300_500, { ok: true, body: BODY }],
    [
      "raw +300.5 rounds to 301 and is stale",
      AT_TS + 300_500,
      { ok: false, reason: "stale_timestamp", skewSeconds: 301 },
    ],
    ["raw +300.4 rounds to 300 and passes", AT_TS + 300_400, { ok: true, body: BODY }],
    [
      "raw -300.6 rounds to -301 and is stale",
      AT_TS - 300_600,
      { ok: false, reason: "stale_timestamp", skewSeconds: -301 },
    ],
  ];
  for (const [label, nowMs, want] of rows) {
    test(label, async () => {
      const { input } = spied({}, nowMs);
      expect(await verifySlackRequest(input, WINDOW)).toEqual(want as never);
    });
  }
});

describe("verifySlackRequest: malformed timestamps are stale", () => {
  const rows: [label: string, timestamp: string, want: unknown][] = [
    [
      "empty string (Number is 0)",
      "",
      { ok: false, reason: "stale_timestamp", skewSeconds: 1_700_000_000 },
    ],
    ["leading space", " 12", { ok: false, reason: "stale_timestamp", skewSeconds: 1_699_999_988 }],
    ["exponent form", "1e3", { ok: false, reason: "stale_timestamp", skewSeconds: 1_699_999_000 }],
    [
      "12 digits",
      "100000000000",
      { ok: false, reason: "stale_timestamp", skewSeconds: -98_300_000_000 },
    ],
    ["negative", "-1", { ok: false, reason: "stale_timestamp", skewSeconds: 1_700_000_001 }],
    [
      "fresh value with a fraction",
      "1700000000.0",
      { ok: false, reason: "stale_timestamp", skewSeconds: 0 },
    ],
    ["not a number has no skewSeconds", "abc", { ok: false, reason: "stale_timestamp" }],
    ["Infinity has no skewSeconds", "Infinity", { ok: false, reason: "stale_timestamp" }],
  ];
  for (const [label, timestamp, want] of rows) {
    test(label, async () => {
      const { input, calls } = spied({ timestamp }, AT_TS);
      const result = await verifySlackRequest(input, WINDOW);
      expect(result).toEqual(want as never);
      expect("skewSeconds" in result).toBe("skewSeconds" in (want as object));
      expect(calls).toEqual({ now: 1, readBody: 0 });
    });
  }
});

describe("verifySlackRequest: the window is the caller's", () => {
  const rows: [label: string, window: number, nowMs: number, want: unknown][] = [
    ["window 10, skew 10", 10, AT_TS + 10_000, { ok: true, body: BODY }],
    [
      "window 10, skew -11",
      10,
      AT_TS - 11_000,
      { ok: false, reason: "stale_timestamp", skewSeconds: -11 },
    ],
    ["window 0, skew 0", 0, AT_TS + 400, { ok: true, body: BODY }],
    ["window 0, skew 1", 0, AT_TS + 500, { ok: false, reason: "stale_timestamp", skewSeconds: 1 }],
    ["window 3600, skew 3600", 3600, AT_TS + 3_600_000, { ok: true, body: BODY }],
  ];
  for (const [label, window, nowMs, want] of rows) {
    test(label, async () => {
      const { input } = spied({}, nowMs);
      expect(await verifySlackRequest(input, { timestampWindowSeconds: window })).toEqual(
        want as never,
      );
    });
  }
});

// A NaN clock makes the skew NaN, and `Math.abs(NaN) > window` is false, so the window
// check does not refuse: the request goes on to the signature check. Pinned as the frozen
// behavior; callers must supply a real clock.
test("verifySlackRequest: a NaN clock does not trip the window", async () => {
  const { input, calls } = spied({}, Number.NaN);
  expect(await verifySlackRequest(input, WINDOW)).toEqual({ ok: true, body: BODY });
  expect(calls).toEqual({ now: 1, readBody: 1 });
});

// Frozen behavior, not a goal: a NaN window compares false against every skew, so the
// replay check is disabled (fail-open). A correctly signed request 25 years stale is
// accepted. Callers must pass a finite window (see the verifySlackRequest JSDoc).
test("verifySlackRequest: a NaN window disables the replay check (fail-open)", async () => {
  const twentyFiveYearsMs = 25 * 365 * 86_400 * 1000;
  const { input, calls } = spied({}, AT_TS + twentyFiveYearsMs);
  expect(await verifySlackRequest(input, { timestampWindowSeconds: Number.NaN })).toEqual({
    ok: true,
    body: BODY,
  });
  expect(calls).toEqual({ now: 1, readBody: 1 });
});
