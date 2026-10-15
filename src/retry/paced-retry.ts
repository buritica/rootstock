import type { Pacer } from "./token-bucket-pacer.ts";

/** How much of each kind of failure ONE request may absorb before halting. */
export interface RetryBudgets {
  /** Attempts for TRANSIENT failures: 5xx and network blips. Rate-limit waits are free. */
  readonly maxAttempts: number;
  /** How many times ONE request may be told to wait before the envelope stops. */
  readonly maxRateLimitWaits: number;
}

export type AttemptOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "rate_limited"; waitMs: number }
  | { kind: "transient"; error: unknown; status?: number | null }
  | { kind: "fatal"; error: unknown };

/** What a THROWN error turned out to be. An `ok` is not one of the options. */
export type ErrorOutcome = Exclude<AttemptOutcome<never>, { kind: "ok" }>;

export interface PacedRetryOptions<T> {
  /** Names the request in both halting messages, fully qualified. */
  readonly what: string;
  /** The bucket every attempt, including every retry, spends a token from. */
  readonly limiter: Pacer;
  readonly budgets: RetryBudgets;
  /** The sleeper for waits and backoffs. */
  readonly sleep: (ms: number) => Promise<void>;
  /** The transient backoff curve, in milliseconds for the given 1-based attempt. */
  readonly backoffMs: (attempt: number) => number;
  /** ONE attempt. It may report its own outcome or throw, in which case `classifyError` decides. */
  readonly perform: () => Promise<AttemptOutcome<T>>;
  /**
   * Classifies every error `perform` throws, including the caller's OWN
   * classified failures, which is why "fatal" exists. It does not have to be
   * total: if it throws, the ORIGINAL error is rethrown with the classifier's
   * failure attached as `cause` (only when that slot is free).
   */
  readonly classifyError: (err: unknown) => ErrorOutcome;
  /** Runs before the token is spent, and may THROW to abandon the request. */
  readonly beforeAttempt?: (() => void) | undefined;
  /** Called once, on a full success. */
  readonly onSuccess?: (() => void) | undefined;
  /** Called before each rate-limit wait. */
  readonly onRateLimit?: ((info: { waitMs: number; waits: number }) => void) | undefined;
  /** Called when a request exhausts its rate-limit budget, just before the envelope throws. */
  readonly onRateLimitExhausted?: ((info: { waits: number }) => void) | undefined;
  /** Called before each backoff, never on the attempt that gives up. */
  readonly onTransient?:
    | ((info: {
        error: unknown;
        status: number | null;
        attempt: number;
        backoffMs: number;
      }) => void)
    | undefined;
}

/**
 * Run one request through the envelope: paced, rate-limit-aware,
 * transient-retrying, everything else rethrown untouched.
 *
 * THE TWO BUDGETS ARE SEPARATE, and that is the whole design:
 *
 *   - A rate-limited outcome is the API working as documented. It spends from
 *     `maxRateLimitWaits`, waits as long as the server asked, and does NOT
 *     consume an attempt.
 *   - A transient outcome spends an attempt and backs off along `backoffMs`.
 *   - Anything else is the caller's business: `classifyError` says "fatal" and
 *     the error is rethrown untouched, on the first try, with no wait.
 *
 * Running out of either budget throws a sentence naming which one went, never
 * a silent partial result.
 */
export async function pacedRetry<T>(options: PacedRetryOptions<T>): Promise<T> {
  const { what, limiter, budgets, perform, classifyError, sleep, backoffMs } = options;
  const { maxAttempts, maxRateLimitWaits } = budgets;
  let rateLimitWaits = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.beforeAttempt?.();
    await limiter.take();

    let outcome: AttemptOutcome<T>;
    try {
      outcome = await perform();
    } catch (err) {
      try {
        outcome = classifyError(err);
      } catch (classifierError) {
        // THE ORIGINAL ERROR WINS, always. A classifier is caller code and is
        // not total; if its throw escaped, the failure an operator has to read
        // would be replaced by the bug that happened while reading it. The
        // classifier's error rides along as `cause`, only when the slot is
        // free: an error that already explains itself keeps its own chain.
        if (err instanceof Error && err.cause === undefined) {
          err.cause = classifierError;
        }
        throw err;
      }
    }

    if (outcome.kind === "ok") {
      options.onSuccess?.();
      return outcome.value;
    }
    if (outcome.kind === "fatal") throw outcome.error;

    if (outcome.kind === "rate_limited") {
      rateLimitWaits++;
      if (rateLimitWaits > maxRateLimitWaits) {
        options.onRateLimitExhausted?.({ waits: rateLimitWaits });
        throw new Error(
          `${what} rate-limited ${rateLimitWaits} times — halting rather than hammering`,
        );
      }
      options.onRateLimit?.({ waitMs: outcome.waitMs, waits: rateLimitWaits });
      await sleep(outcome.waitMs);
      // Rate limiting does not consume the FAILURE budget: this decrement
      // against the loop's own increment is what keeps the two separate.
      attempt--;
      continue;
    }

    // Transient. The LAST attempt rethrows rather than sleeping on a wait
    // nobody uses.
    if (attempt === maxAttempts) throw outcome.error;
    const backoff = backoffMs(attempt);
    options.onTransient?.({
      error: outcome.error,
      status: outcome.status ?? null,
      attempt,
      backoffMs: backoff,
    });
    await sleep(backoff);
  }

  // Reachable only if `maxAttempts` is not a positive integer: a silent
  // `undefined` here would read as an empty result.
  throw new Error(
    `${what} still failing after ${maxAttempts} attempts — halting rather than hammering`,
  );
}
