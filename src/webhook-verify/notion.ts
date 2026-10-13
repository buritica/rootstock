import { createHmac, timingSafeEqual } from "node:crypto";

export type NotionEventAge =
  | { kind: "unusable" }
  | { kind: "plausible"; ageSeconds: number }
  | { kind: "implausible"; ageSeconds: number };

/** `sha256=` followed by exactly 64 hex digits, either case, and nothing else. */
const SIGNATURE_SHAPE = /^sha256=[0-9a-fA-F]{64}$/;

/** Length of the `sha256=` prefix. */
const PREFIX_LENGTH = 7;

/**
 * True only when `header` is `sha256=<64 hex digits>` and those digits decode to the
 * HMAC-SHA256 of `rawBody` under `token`, compared in constant time.
 *
 * Strict: trailing data after the digest, a digest of any other length, a missing or
 * empty header, and an empty token all return false. Nothing here throws on a string
 * input. Uppercase hex digits are accepted.
 */
export function notionSignatureMatches(
  rawBody: string,
  header: string | null,
  token: string,
): boolean {
  if (!header || !SIGNATURE_SHAPE.test(header)) return false;
  if (!token) return false;
  const expected = createHmac("sha256", token).update(rawBody).digest();
  const given = Buffer.from(header.slice(PREFIX_LENGTH), "hex");
  // Always 32 bytes after the shape check; kept so the compare below can never throw.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * Classifies an event timestamp by its age against `now()` (epoch milliseconds).
 *
 * - A non-string, or a string `Date.parse` cannot read, is `unusable`, and `now` is not
 *   called.
 * - Otherwise `ageSeconds = now() / 1000 - parsed / 1000`, unrounded. An age above
 *   `maxEventAgeSeconds`, or below `-maxFutureSkewSeconds`, is `implausible`; both bounds
 *   are inclusive on the plausible side. A `now()` of NaN gives a NaN age, which fails
 *   neither bound and so reads as plausible.
 */
export function notionEventAge(
  timestamp: unknown,
  now: () => number,
  opts: { maxEventAgeSeconds: number; maxFutureSkewSeconds: number },
): NotionEventAge {
  if (typeof timestamp !== "string") return { kind: "unusable" };
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return { kind: "unusable" };
  const eventSeconds = ms / 1000;
  const ageSeconds = now() / 1000 - eventSeconds;
  const tooOld = ageSeconds > opts.maxEventAgeSeconds;
  const tooFuture = ageSeconds < -opts.maxFutureSkewSeconds;
  if (tooOld || tooFuture) return { kind: "implausible", ageSeconds };
  return { kind: "plausible", ageSeconds };
}
