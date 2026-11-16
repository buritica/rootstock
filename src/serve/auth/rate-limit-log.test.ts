import { expect, test } from "bun:test";
import {
  createRateLimitLog,
  RATE_LIMIT_LOG_MAX_KEYS,
  RATE_LIMIT_LOG_WINDOW_MS,
} from "./rate-limit-log.ts";

test("at the key bound, expired keys go first and a live key keeps its held-back count", () => {
  let t = 0;
  const lines: Record<string, unknown>[] = [];
  const log = createRateLimitLog({ now: () => -1, monotonic: () => t }, (_e, f) => lines.push(f));
  for (let i = 0; i < RATE_LIMIT_LOG_MAX_KEYS - 1; i++) log(`/old/${i}`, "192.0.2.1", null);
  t = RATE_LIMIT_LOG_WINDOW_MS + 1;
  log("/live", "192.0.2.1", null);
  log("/live", "192.0.2.1", null); // held back: suppressed 1
  log("/new", "192.0.2.1", null); // the bound: expired /old/* pruned, /live kept
  t += RATE_LIMIT_LOG_WINDOW_MS;
  log("/live", "192.0.2.1", null);
  expect(lines.at(-1)).toMatchObject({ path: "/live", suppressed: 1 });
});

test("when every key is live the set is cleared", () => {
  const lines: Record<string, unknown>[] = [];
  const log = createRateLimitLog({ now: () => 0, monotonic: () => 0 }, (_e, f) => lines.push(f));
  for (let i = 0; i < RATE_LIMIT_LOG_MAX_KEYS; i++) log(`/p/${i}`, null, null);
  log("/p/0", null, null); // still live: held back
  log("/overflow", null, null); // clears
  log("/p/0", null, null); // forgotten, so logged again
  expect(lines.map((l) => l.path).slice(-2)).toEqual(["/overflow", "/p/0"]);
});
