// Deterministic clock, timers and log for the serve tests.

import type { Clock, LogEvent, Timers } from "./types.ts";

export interface FakeTime extends Clock, Timers {
  advance(ms: number): void;
  setNow(ms: number): void;
  pending(): number;
}

/** A clock whose timers fire only when `advance` passes their due time. */
export function fakeTime(start = 1_700_000_000_000): FakeTime {
  let t = start;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    monotonic: () => t,
    set(ms, fn) {
      const id = ++seq;
      due.set(id, { at: t + ms, fn });
      return () => {
        due.delete(id);
      };
    },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const next = [...due.entries()]
          .filter(([, d]) => d.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = until;
    },
    setNow(ms) {
      t = ms;
    },
    pending: () => due.size,
  };
}

/** Real timers for tests that need the event loop to turn. */
export const realTimers: Timers = {
  set(ms, fn) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export function captureLog(): LogEvent & {
  lines: [string, Record<string, unknown>][];
  names(): string[];
} {
  const lines: [string, Record<string, unknown>][] = [];
  const log = ((event: string, fields: Readonly<Record<string, unknown>>) => {
    lines.push([event, { ...fields }]);
  }) as LogEvent & { lines: typeof lines; names(): string[] };
  log.lines = lines;
  log.names = () => lines.map(([e]) => e);
  return log;
}

/** Lets pending promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * Turns the event loop (one macrotask per round, no wall-clock wait) until
 * `cond` holds; throws after `rounds` so a broken test fails instead of hanging.
 */
export async function until(cond: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  if (!cond()) throw new Error(`until: condition still false after ${rounds} rounds`);
}

/** A promise and the function that resolves it. */
export function signal<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
