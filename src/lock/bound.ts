import type { LockDeps } from "./run-lock.ts";

/**
 * `deps.sleep`, made safe: true when it resolved, false when it threw or
 * rejected (a sleep built on timers/promises rejects on abort). A broken
 * sleep must not leak a session or a turn, so nothing here ever throws.
 */
export async function pause(deps: LockDeps, ms: number, signal?: AbortSignal): Promise<boolean> {
  try {
    await deps.sleep(ms, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Races `work` against `ms` (through `deps.sleep`) and, when given, the
 * caller's signal: the value, or which of the two ended the wait first.
 * A rejection of `work` before either rethrows it. The sleep is cancelled once
 * the race is decided. A sleep that rejects loses the bound and the signal,
 * so a broken clock waits on `work` alone (as `release()` always has).
 */
export function within<T>(
  deps: LockDeps,
  work: Promise<T>,
  ms: number,
): Promise<{ value: T } | "timeout">;
export function within<T>(
  deps: LockDeps,
  work: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<{ value: T } | "timeout" | "aborted">;
export async function within<T>(
  deps: LockDeps,
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<{ value: T } | "timeout" | "aborted"> {
  const cancel = new AbortController();
  const onAbort = () => cancel.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) cancel.abort();
  const never = new Promise<never>(() => {});
  try {
    return await Promise.race([
      work.then((value) => ({ value })),
      pause(deps, ms, cancel.signal).then((slept) => {
        if (signal?.aborted) return "aborted" as const;
        return slept ? ("timeout" as const) : never;
      }),
    ]);
  } finally {
    cancel.abort();
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The cause a bounded statement carries when it did not answer in time. */
export function stalled(what: string, ms: number): Error {
  return new Error(`rootstock lock: ${what} did not settle within ${ms} ms`);
}
