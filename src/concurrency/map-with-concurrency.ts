/**
 * Runs `fn` over `items` with at most `limit` calls in flight, and resolves to
 * the results in item order. A new call starts as soon as one finishes, and
 * `fn` gets each item's index.
 *
 * It does not validate `limit`. With `limit` 0, negative or `NaN` (indeed any
 * limit below 1) it starts no workers and resolves to a sparse array, `new Array(items.length)` with every
 * slot a hole, so a caller that `.map`s the result skips the holes silently.
 * A fractional limit such as 1.5 starts one worker. Callers that need a
 * refusal check the limit themselves before calling.
 *
 * `fn` rejecting rejects the whole call, plain `Promise.all` semantics, and
 * the other workers keep running detached rather than being cancelled. A
 * caller that must survive one bad item catches inside `fn` and returns a
 * failure value.
 */
// biome-ignore format: the body is carried verbatim, so its line breaks are part of it
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
