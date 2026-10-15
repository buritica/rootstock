/** Just enough of a pacer to spend a token: what lets a test hand in a counting stub. */
export interface Pacer {
  take(): Promise<void>;
}

export interface TokenBucketPacer extends Pacer {
  readonly ratePerSecond: number;
  readonly burst: number;
}

export interface TokenBucketPacerOptions {
  readonly ratePerSecond: number;
  /** No default here: a caller that wants "one second's worth" passes `Math.max(1, Math.ceil(rate))`. */
  readonly burst: number;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Token bucket: `ratePerSecond` tokens refill per second up to `burst`, and
 * every `take()` spends one. A ceiling on the AVERAGE rate rather than a fixed
 * floor between calls: a handful of calls after an idle stretch go straight
 * through, and sustained traffic settles on the rate. Takes are serialized
 * through a promise chain so two concurrent callers sharing a bucket cannot
 * both read the same token.
 *
 * A `burst` below 1 can never accumulate a whole token, so its `take()` never
 * resolves. `burst` is not validated here.
 *
 * The returned object is frozen and `take` is a closure, so it works
 * detached. A caller that needs a subclassable limiter wraps this in its own
 * class and declares `take()` as a prototype method.
 */
export function createTokenBucketPacer(options: TokenBucketPacerOptions): TokenBucketPacer {
  const { ratePerSecond, burst, now, sleep } = options;
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
    throw new Error(
      `createTokenBucketPacer: ratePerSecond must be a positive number — got ${ratePerSecond}`,
    );
  }
  let lastRefillMs = now();
  let tokens = burst;
  let queue: Promise<unknown> = Promise.resolve();

  async function acquire(): Promise<void> {
    for (;;) {
      const t = now();
      const refill = ((t - lastRefillMs) / 1000) * ratePerSecond;
      tokens = Math.min(burst, tokens + Math.max(0, refill));
      lastRefillMs = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - tokens) / ratePerSecond) * 1000));
    }
  }

  function take(): Promise<void> {
    const run = queue.then(() => acquire());
    // The chain must never reject, or one failed take wedges every later one.
    queue = run.catch(() => undefined);
    return run;
  }

  return Object.freeze({ ratePerSecond, burst, take });
}
