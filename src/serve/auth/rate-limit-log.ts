import type { Clock, LogEvent } from "../types.ts";

// The 429 line is written at most once per client and path per window, with
// the count it held back. The key set is bounded because the path is the
// caller's choice: past the bound, keys whose window has passed are dropped
// (their held-back counts emit nothing), and only if every key is still live
// is the set cleared.
export const RATE_LIMIT_LOG_WINDOW_MS = 60_000;
export const RATE_LIMIT_LOG_MAX_KEYS = 1_000;

export type RateLimitLog = (path: string, client: string | null, retryAfter: string | null) => void;

export function createRateLimitLog(clock: Clock, emit: LogEvent): RateLimitLog {
  const seen = new Map<string, { at: number; suppressed: number }>();
  const live = (at: number, t: number) => t - at >= 0 && t - at < RATE_LIMIT_LOG_WINDOW_MS;
  return (path, client, retryAfter) => {
    const t = clock.monotonic();
    const key = `${client ?? ""}|${path}`;
    const last = seen.get(key);
    if (last !== undefined && live(last.at, t)) {
      last.suppressed += 1;
      return;
    }
    if (last === undefined && seen.size >= RATE_LIMIT_LOG_MAX_KEYS) {
      for (const [k, v] of seen) if (!live(v.at, t)) seen.delete(k);
      if (seen.size >= RATE_LIMIT_LOG_MAX_KEYS) seen.clear();
    }
    seen.set(key, { at: t, suppressed: 0 });
    emit("auth.rate_limited", { path, client, retryAfter, suppressed: last?.suppressed ?? 0 });
  };
}
