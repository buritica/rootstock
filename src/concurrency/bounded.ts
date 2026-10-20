// biome-ignore format: the body is carried verbatim, so its line breaks are part of it
export interface BoundedOptions<T> {
  /** Maximum items in flight. Must be a positive integer. */
  width: number;
  /**
   * Awaited in item order BEFORE the item is dispatched: an exclusivity gate,
   * for a caller that has one. A throw aborts the pass without dispatching
   * the item.
   */
  before?: (item: T) => Promise<void>;
}

/**
 * Run `run` over `items`, at most `options.width` at a time.
 *
 * - At most `width` items are in flight, ever. A new item starts the moment
 *   one finishes, so one slow item cannot idle the others.
 * - `before` is awaited in item order, before its item is dispatched. Gating
 *   inside the worker would let up to `width` items start against a gate
 *   nobody had re-checked yet, and gating once for the whole pass would miss
 *   a gate that stops holding partway through.
 * - The first throw, from `before` or `run`, aborts the pass: nothing new is
 *   pulled, gated or dispatched after it. In-flight items are allowed to
 *   finish, because killing them mid-write leaves half-done work, and then the
 *   first error is rethrown. Callers absorb per-item failures inside `run`;
 *   what reaches here is fatal to the pass.
 * - The iterable is pulled lazily, one item per dispatch, and not at all once
 *   the pass has aborted. Its `return()` runs on the way out, before the
 *   in-flight items drain, so a generator's `finally` still gets its cleanup.
 * - A throw from the iterable itself (its `next()`) is not caught: the call
 *   rejects with it at once, without calling `return()` and without waiting
 *   for in-flight items, which keep running unobserved.
 * - Each slot wait races every in-flight item, so while one item hangs, every
 *   later wait leaves a reaction on it until it settles.
 * - Items are gated and dispatched in iteration order. They complete in
 *   whatever order they complete.
 */
// biome-ignore format: the body is carried verbatim, so its line breaks are part of it
export async function forEachBounded<T>(
  items: Iterable<T>,
  options: BoundedOptions<T>,
  run: (item: T) => Promise<void>,
): Promise<void> {
  const { width, before } = options;
  if (!Number.isInteger(width) || width < 1) {
    // A zero or fractional width would dispatch everything at once (the
    // in-flight check never trips): silently unbounded, which is the failure
    // this function exists to prevent.
    throw new Error(
      `forEachBounded: width must be a positive integer, got ${JSON.stringify(width)}`,
    );
  }

  const inFlight = new Set<Promise<void>>();
  let firstError: unknown;
  let aborted = false;

  // MANUAL ITERATION, not `for...of`, for one reason: `for...of` pulls the
  // next item BEFORE the loop body can look at `aborted`, so an aborted pass
  // would still pay for one more pull, and a pull is not free. A generator may
  // do real work, or emit side effects, on the way to its next yield. Here the
  // check comes first and the pull second.
  const iterator = items[Symbol.iterator]();
  let exhausted = false;
  while (!aborted) {
    const next = iterator.next();
    if (next.done === true) {
      exhausted = true;
      break;
    }
    const item = next.value;
    if (before !== undefined) {
      try {
        await before(item);
      } catch (gateErr) {
        // The gate refused: this item is NOT dispatched, and neither is
        // anything after it. In-flight work still finishes below.
        firstError ??= gateErr;
        aborted = true;
        break;
      }
      // The gate is awaited, and an in-flight item can reject meanwhile. This
      // item cleared its own gate, but the pass is already doomed, so
      // dispatching it now would be one more item started after the pass
      // knew better.
      if (aborted) break;
    }
    // Wrapped exactly ONCE, here at insertion. The wrapper never rejects (it
    // records the first failure and marks the pass aborted instead), and its
    // `finally` closes over `task` to evict ITSELF from `inFlight` the moment
    // it settles. That self-reference is what lets the slot-wait below race
    // the set directly: nothing has to re-wrap every entry to find out which
    // one finished, because each entry has already removed itself by the time
    // anything downstream observes it.
    //
    // `Promise.resolve().then(...)` rather than a bare `run(item)`: a `run`
    // that throws SYNCHRONOUSLY (before its first await, or one that is not
    // an async function at all) would otherwise escape this frame past the
    // drain below, abandoning every in-flight item instead of letting it
    // finish. Through the microtask it is just another rejection.
    const task: Promise<void> = Promise.resolve()
      .then(() => run(item))
      .catch((runErr: unknown) => {
        firstError ??= runErr;
        aborted = true;
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
    // Wait for a SLOT, not for the batch: this returns as soon as any ONE
    // item finishes, so the next starts immediately rather than idling behind
    // the slowest of a fixed slice. Racing `inFlight` itself is safe: by the
    // time `Promise.race` can settle on an entry, that entry's own `finally`
    // has already run (it is earlier in the same promise chain), so the entry
    // is already gone from the set and there is nothing left to identify or
    // evict here.
    if (inFlight.size >= width) {
      await Promise.race(inFlight);
    }
  }
  if (!exhausted) {
    // What `for...of`'s `break` did for free: tell the generator its consumer
    // is gone, so its `finally` runs. A cleanup that itself throws is
    // recorded, never allowed to mask the error that aborted the pass (unless
    // that error was itself nullish, which `??=` lets it replace).
    try {
      iterator.return?.();
    } catch (returnErr) {
      firstError ??= returnErr;
    }
  }

  // In-flight items finish even on an aborted pass, see the doc comment.
  await Promise.all(inFlight);
  // Checked on `aborted`, not `firstError !== undefined`: a `throw undefined`
  // (or any falsy throw) from a gate or a `run` sets `firstError` to that same
  // falsy value via `??=`, and a bare `if (firstError !== undefined)` would
  // then find `undefined !== undefined` false and return normally, a pass
  // that aborted reporting itself green. `aborted` is the fact that matters;
  // the fallback error names what went missing.
  if (aborted) {
    throw firstError ?? new Error("forEachBounded: aborted with a falsy error");
  }
}
