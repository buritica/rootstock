import { createHmac, timingSafeEqual } from "node:crypto";

/** What `verifySlackRequest` needs from one inbound request. */
export interface SlackVerifyInput {
  /** The workspace signing secret. Undefined or empty refuses every request. */
  signingSecret: string | undefined;
  /** The `X-Slack-Signature` header, or null when absent. */
  signature: string | null;
  /** The `X-Slack-Request-Timestamp` header, or null when absent. */
  timestamp: string | null;
  /** Reads the raw request body. Called at most once, and only after the timestamp passes. */
  readBody: () => Promise<string>;
  /** Current time in epoch milliseconds. Called at most once. */
  now: () => number;
}

export type SlackVerifyResult =
  | { ok: true; body: string }
  | { ok: false; reason: "unconfigured" }
  | { ok: false; reason: "bad_signature" }
  | { ok: false; reason: "stale_timestamp"; skewSeconds?: number };

/** The only shape a v0 signature can take: lowercase hex, exactly 64 digits. */
const SIGNATURE_SHAPE = /^v0=[0-9a-f]{64}$/;

/**
 * True when `provided` is `v0=` plus the HMAC-SHA256 of `v0:<timestamp>:<body>` under
 * `secret`, compared in constant time.
 *
 * The shape is checked before anything is hashed. It makes the byte length of `provided`
 * equal its string length, so the constant-time compare never sees unequal buffers and
 * never throws. An empty secret is still a valid HMAC key: the digest is computed and
 * compared as usual.
 */
export function slackSignatureMatches(
  secret: string,
  timestamp: string,
  body: string,
  provided: string,
): boolean {
  if (!SIGNATURE_SHAPE.test(provided)) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(provided, "ascii"), Buffer.from(expected, "ascii"));
}

/**
 * Verifies a Slack request in a fixed order, stopping at the first refusal:
 *
 * 1. a falsy signing secret → `unconfigured`;
 * 2. a missing signature or timestamp header → `bad_signature`;
 * 3. `now()` is read once. The timestamp must be 1–11 ASCII digits, and the rounded skew
 *    `Math.round(now / 1000 - timestamp)` must sit within `timestampWindowSeconds` either
 *    way, inclusive → otherwise `stale_timestamp`, with `skewSeconds` present only when
 *    it is finite;
 * 4. `readBody()` is called once, and the signature is checked over that body →
 *    `bad_signature` on mismatch;
 * 5. otherwise `ok`, carrying the body.
 *
 * The body is never read for a request refused at steps 1–3. A `now()` of NaN makes the
 * skew NaN, which the window comparison does not refuse; supply a real clock.
 */
export async function verifySlackRequest(
  input: SlackVerifyInput,
  opts: { timestampWindowSeconds: number },
): Promise<SlackVerifyResult> {
  if (!input.signingSecret) {
    return { ok: false, reason: "unconfigured" };
  }

  const signature = input.signature;
  const timestamp = input.timestamp;
  if (signature === null || timestamp === null) {
    return { ok: false, reason: "bad_signature" };
  }
  const seconds = Number(timestamp);
  const skewSeconds = Math.round(input.now() / 1000 - seconds);
  if (
    !/^\d{1,11}$/.test(timestamp) ||
    !Number.isFinite(seconds) ||
    Math.abs(skewSeconds) > opts.timestampWindowSeconds
  ) {
    return {
      ok: false,
      reason: "stale_timestamp",
      ...(Number.isFinite(skewSeconds) ? { skewSeconds } : {}),
    };
  }
  const body = await input.readBody();
  if (!slackSignatureMatches(input.signingSecret, timestamp, body, signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, body };
}
