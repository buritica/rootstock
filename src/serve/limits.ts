// Inbound limits (contract §5): token buckets keyed by source or caller,
// per-caller concurrency groups, and the per-turn call budget. In memory and
// per process, so a count is per instance, never shared across them.

import { isRecord } from "../internal/slice.ts";
import { refillTokens } from "../retry/token-bucket-math.ts";
import { configError, isPositiveInteger, isPositiveNumber } from "./errors.ts";
import type { Clock, LogEvent } from "./types.ts";

export interface RateLimiter {
  /** Spends one token for `key`; false means refuse. */
  allow(key: string): boolean;
  /** True when `key` holds a whole token, spending nothing. */
  peek(key: string): boolean;
}

export interface BucketLimits {
  capacity: number;
  refillPerSecond: number;
  maxKeys: number;
}

export interface ConcurrencyGroup {
  tools: readonly string[];
  max: number;
  /**
   * The labeled refusal text for `tool` (contract §11: "text from the
   * profile"). Rev 3.1 lists no field for it; a consumer's wording never
   * ships in rootstock.
   */
  busy: (tool: string) => string;
}

export interface TurnBudgetLimits {
  cap: number;
  /** The countdown rides on a result once `remaining < warnAt`. */
  warnAt: number;
  maxTurns: number;
  /**
   * The `message` of the result a call past the cap gets, given the calls the
   * turn already spent. Rev 3.1 lists no field for it; the wording is the
   * consumer's, so it is a parameter here.
   */
  exhausted: (spent: number) => string;
}

export interface Limits {
  refusal: BucketLimits | null;
  serving: BucketLimits | null;
  perTool: Readonly<Record<string, BucketLimits>>;
  /** Named group, shared by its tools, per caller. */
  concurrency: Readonly<Record<string, ConcurrencyGroup>>;
  turnBudget: TurnBudgetLimits | null;
  /** Floor between two `serve.rate_limited` lines of one bucket. */
  logIntervalMs: number;
}

/**
 * Token bucket per key. Refill comes from `clock.now()` elapsed, through the
 * shared bucket math, which clamps a backwards clock step at no refill; a
 * key's last-refill time is set to `now` on every refill, forward or back.
 * The map is kept in last-touch order; past `maxKeys` keys, buckets idle long
 * enough to be full again are pruned from the least recently touched end,
 * stopping at the first that is not (a prune trigger, not a hard cap: a spray
 * of fresh keys still inserts).
 */
export function createRateLimiter(o: BucketLimits & { clock: Clock }): RateLimiter {
  const { allow, peek } = createBucketLimiter(o);
  return Object.freeze({ allow, peek });
}

/** serve's own limiter: a RateLimiter plus the batch charge (not public, §5). */
export interface BucketLimiter extends RateLimiter {
  /** Keys held now (tests read it to see the prune bound). */
  readonly size: number;
  /**
   * Spends `n` tokens for `key` in one charge; false means refuse. A refusal
   * spends the whole tokens the bucket held, as `n` single charges would.
   * `n` must be an integer >= 0.
   */
  allowN(key: string, n: number): boolean;
}

export function createBucketLimiter(o: BucketLimits & { clock: Clock }): BucketLimiter {
  for (const field of ["capacity", "refillPerSecond", "maxKeys"] as const) {
    if (!isPositiveNumber(o?.[field])) {
      throw configError("createRateLimiter", `${field} must be a finite number > 0`, o?.[field]);
    }
  }
  const { capacity, refillPerSecond, maxKeys, clock } = o;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const fullAfterMs = (capacity / refillPerSecond) * 1000;
  const refilled = (b: { tokens: number; at: number }, t: number) =>
    refillTokens(b.tokens, t - b.at, refillPerSecond, capacity);
  /** Prunes, then refills `key`'s bucket to now and moves it to the touched end. */
  const touch = (key: string): { tokens: number; at: number } => {
    const t = clock.now();
    if (buckets.size >= maxKeys) {
      for (const [k, b] of buckets) {
        if (t - b.at < fullAfterMs) break;
        buckets.delete(k);
      }
    }
    const b = buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = refilled(b, t);
    b.at = t;
    buckets.delete(key);
    buckets.set(key, b);
    return b;
  };
  const spend = (key: string, n: number): boolean => {
    if (!Number.isInteger(n) || n < 0) {
      throw configError("allowN", "n must be an integer >= 0", n);
    }
    const b = touch(key);
    if (b.tokens < n) {
      b.tokens -= Math.floor(b.tokens);
      return false;
    }
    b.tokens -= n;
    return true;
  };

  return Object.freeze({
    allow: (key: string): boolean => spend(key, 1),
    allowN: spend,
    get size() {
      return buckets.size;
    },
    peek(key: string): boolean {
      const b = buckets.get(key);
      return b === undefined ? capacity >= 1 : refilled(b, clock.now()) >= 1;
    },
  });
}

/**
 * At most `max` calls in flight per key; over it, `tryAcquire` refuses at once
 * instead of queueing. The release it returns is idempotent.
 */
export function createConcurrencyLimiter(max: number): {
  tryAcquire(key: string): (() => void) | undefined;
} {
  if (!isPositiveInteger(max)) {
    throw configError("createConcurrencyLimiter", "max must be an integer > 0", max);
  }
  const inFlight = new Map<string, number>();
  return Object.freeze({
    tryAcquire(key: string): (() => void) | undefined {
      const n = inFlight.get(key) ?? 0;
      if (n >= max) return undefined;
      inFlight.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (inFlight.get(key) ?? 1) - 1;
        if (left <= 0) inFlight.delete(key);
        else inFlight.set(key, left);
      };
    },
  });
}

/** What one call learned about its turn. */
export interface TurnCharge {
  /** Calls this turn has made, this one included. */
  used: number;
  /** Calls left after this one; 0 when this one is the last that runs. */
  remaining: number;
  /** True when this call is past the cap and does not run. */
  exhausted: boolean;
}

export interface TurnBudget {
  /** Each call of the returned function charges one tool call to `turnId`. */
  forTurn(turnId: string): () => TurnCharge;
}

/**
 * A per-turn ceiling on tool calls. Tracks at most `maxTurns` turns, the
 * least recently charged forgotten first.
 */
export function createTurnBudget(o: { cap: number; maxTurns: number }): TurnBudget {
  if (!isPositiveInteger(o?.cap)) {
    throw configError("createTurnBudget", "cap must be an integer > 0", o?.cap);
  }
  if (!isPositiveInteger(o.maxTurns)) {
    throw configError("createTurnBudget", "maxTurns must be an integer > 0", o.maxTurns);
  }
  const { cap, maxTurns } = o;
  const used = new Map<string, number>();
  return Object.freeze({
    forTurn(turnId: string) {
      return (): TurnCharge => {
        const n = (used.get(turnId) ?? 0) + 1;
        used.delete(turnId);
        used.set(turnId, n);
        if (used.size > maxTurns) {
          const oldest = used.keys().next().value;
          if (oldest !== undefined) used.delete(oldest);
        }
        return { used: n, remaining: Math.max(cap - n, 0), exhausted: n > cap };
      };
    },
  });
}

/** The result a call past the cap gets instead of running (not `isError`, which invites a retry). */
export function exhaustedResult(
  charge: TurnCharge,
  message: (spent: number) => string,
): { turnBudget: { remaining: 0; exhausted: true }; message: string } {
  return { turnBudget: { remaining: 0, exhausted: true }, message: message(charge.used - 1) };
}

/**
 * A result that ran, with `turnBudget: { remaining }` beside its own fields
 * once `remaining < warnAt`. Only a plain-object result carries it. Consumers
 * apply it to their own tool results; the seams never do.
 */
export function withCountdown(result: unknown, charge: TurnCharge, warnAt: number): unknown {
  if (charge.remaining >= warnAt) return result;
  if (!isRecord(result)) return result;
  return { ...result, turnBudget: { remaining: charge.remaining } };
}

/**
 * `serve.rate_limited`, at most one line per bucket per `intervalMs`; each
 * line carries `suppressed`, the refusals since the previous line, so the
 * lines still add up to the refusal count.
 */
export function rateLimitedLog(
  log: LogEvent,
  clock: Clock,
  intervalMs: number,
): (bucket: string, fields: Readonly<Record<string, unknown>>) => void {
  const state = new Map<string, { at: number; suppressed: number }>();
  return (bucket, fields) => {
    const s = state.get(bucket) ?? { at: Number.NEGATIVE_INFINITY, suppressed: 0 };
    state.set(bucket, s);
    const t = clock.monotonic();
    if (t - s.at < intervalMs) {
      s.suppressed += 1;
      return;
    }
    s.at = t;
    log("serve.rate_limited", { ...fields, bucket, suppressed: s.suppressed });
    s.suppressed = 0;
  };
}
