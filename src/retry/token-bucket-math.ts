// The token-bucket arithmetic every bucket in rootstock shares: the outbound
// pacer (`createTokenBucketPacer`) and the inbound limiters of `serve`. Pure,
// and no package export: `serve` imports this file directly.

/**
 * The tokens a bucket holds `elapsedMs` after it held `tokens`, refilling at
 * `ratePerSecond` up to `capacity`. A negative `elapsedMs` (the clock stepped
 * back) refills nothing: the clamp keeps the tokens the bucket already has.
 * Without the clamp a backwards step could only remove tokens, never add any,
 * so for a clock that never steps back the result is the unclamped one.
 */
export function refillTokens(
  tokens: number,
  elapsedMs: number,
  ratePerSecond: number,
  capacity: number,
): number {
  return Math.min(capacity, tokens + Math.max(0, (elapsedMs / 1000) * ratePerSecond));
}

/** Whole milliseconds until a bucket holding `tokens` (< 1) refills to one token. */
export function msUntilToken(tokens: number, ratePerSecond: number): number {
  return Math.ceil(((1 - tokens) / ratePerSecond) * 1000);
}
