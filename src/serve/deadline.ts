// One bounded wait for the whole of serve: the probe timeout, the request
// deadline and the shutdown bounds.

import type { Timers } from "./types.ts";

/**
 * Races `work` against `ms` on `timers`: its value, or "timeout" when the
 * timer fires first. A rejection of `work` before that rethrows it. The timer
 * is cancelled once the race settles, whichever side won, so a won race
 * leaves nothing scheduled. `onTimeout` runs inside the timer callback, before
 * anything awaiting the race resumes; a throw from it is dropped.
 */
export async function raceDeadline<T>(
  timers: Timers,
  ms: number,
  work: Promise<T>,
  onTimeout?: () => void,
): Promise<{ value: T } | "timeout"> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ value })),
      new Promise<"timeout">((resolve) => {
        cancel = timers.set(ms, () => {
          try {
            onTimeout?.();
          } catch {
            // The timeout stands.
          }
          resolve("timeout");
        });
      }),
    ]);
  } finally {
    cancel?.();
  }
}
