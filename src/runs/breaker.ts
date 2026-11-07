import { declared } from "./brakes.ts";
import { refusals } from "./errors.ts";
import { emitter, type RunsDeps } from "./events.ts";
import { assertRunsSlice, type RunsSlice } from "./slice.ts";

export interface Breaker {
  /** Counts one consecutive quota failure; at `limit` the breaker trips and stays tripped. */
  hit(): void;
  /** Resets the count after a success, unless the breaker already tripped. */
  clear(): void;
  readonly count: number;
  readonly tripped: boolean;
  /** Refuses BREAKER once tripped. */
  check(): void;
}

/**
 * The quota breaker `name` of the slice (contract §7): in memory, per
 * process. What counts as a hit is the caller's unit.
 */
export function consecutiveBreaker(
  name: string,
  slice: RunsSlice,
  deps?: Pick<RunsDeps, "onEvent">,
): Breaker {
  assertRunsSlice("consecutiveBreaker", slice);
  const { limit } = declared("consecutiveBreaker", "breaker", slice.breakers, name);
  const emit = emitter(deps?.onEvent);
  let count = 0;
  let tripped = false;
  return {
    hit() {
      count += 1;
      if (!tripped && count >= limit) {
        tripped = true;
        emit({ type: "runs.breaker_tripped", breaker: name, count });
      }
    },
    clear() {
      if (!tripped) count = 0;
    },
    get count() {
      return count;
    },
    get tripped() {
      return tripped;
    },
    check() {
      if (tripped) throw refusals.breaker(name, count);
    },
  };
}
