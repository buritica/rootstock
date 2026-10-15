/**
 * Whether a message carries the paced-retry envelope's give-up on a sustained
 * throttle, anywhere in it, so it still matches once wrapped in a run's
 * aggregate error. Matches the throttle sentence exactly, never the transient
 * budget's, which ends the same way but is one request's trouble.
 */
export function mentionsRateLimitExhausted(text: string): boolean {
  return / rate-limited \d+ times — halting rather than hammering/.test(text);
}

/** Whether an error is the envelope giving up on a sustained throttle: a condition of the whole API, not of one request. */
export function isRateLimitExhausted(err: unknown): boolean {
  return err instanceof Error && mentionsRateLimitExhausted(err.message);
}
