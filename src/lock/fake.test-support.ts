import type { Row, Sql } from "../db/index.ts";
import type { LockEvent } from "./events.ts";
import type { LockDeps } from "./run-lock.ts";
import type { LockSession } from "./session.ts";
import { L1, L3, L6, L7, L8, L9, tableStatements } from "./statements.ts";

/**
 * A scripted lock session for the unit suites: `unsafe` answers per
 * statement id (L1-L8, matched by text) from a queue, and records the ids it
 * saw. An answer is rows, an Error to reject with, or a function of the
 * params. An id with an empty queue answers its default.
 */
export type StatementId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" | "L8" | "L9";
export type Answer = Row[] | Error | ((params: readonly unknown[]) => Row[] | Promise<Row[]>);

export interface FakeSession extends LockSession {
  readonly seen: StatementId[];
  /** Each statement's id with the params it was sent, in order. */
  readonly calls: { id: StatementId; params: readonly unknown[] }[];
  readonly closes: number;
  answer(id: StatementId, ...answers: Answer[]): void;
  failClose(err: Error): void;
}

export const PID = 4242;
/** The first uuid each fakeDeps hands out; later ones count up from it. */
export const HOLDER = "00000000-0000-4000-8000-000000000001";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export function fakeSession(table = { schema: "rootstock", name: "run_locks" }): FakeSession {
  const t = tableStatements(table);
  const ids = new Map<string, StatementId>([
    [L1, "L1"],
    [t.fence, "L2"],
    [L3, "L3"],
    [t.claim, "L4"],
    [t.heartbeat, "L5"],
    [L6, "L6"],
    [L7, "L7"],
    [L8, "L8"],
    [L9, "L9"],
  ]);
  const defaults: Record<StatementId, Answer> = {
    L1: [{ locked: true, pid: PID }],
    L2: [{ pid: PID }],
    L3: [{ pid: PID, held: 1 }],
    L4: [{ locked: true, pid: PID + 1, holder: HOLDER }],
    L5: [],
    L6: [{ pg_advisory_unlock: true }],
    L7: [],
    L8: [],
    L9: [{ terminated: true }],
  };
  const queues = new Map<StatementId, Answer[]>();
  const seen: StatementId[] = [];
  const calls: { id: StatementId; params: readonly unknown[] }[] = [];
  let closes = 0;
  let closeError: Error | undefined;
  const unsafe = async (query: string, params?: readonly unknown[]): Promise<Row[]> => {
    const id = ids.get(query);
    if (id === undefined) throw new Error(`fake session: unknown statement ${query}`);
    seen.push(id);
    calls.push({ id, params: [...(params ?? [])] });
    const answer = queues.get(id)?.shift() ?? defaults[id];
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(params ?? []) : answer;
  };
  const sql = Object.assign(
    async () => {
      throw new Error("fake session: the lock sends no tagged query");
    },
    { unsafe },
  ) as unknown as Sql;
  return {
    sql,
    seen,
    calls,
    get closes() {
      return closes;
    },
    answer(id, ...answers) {
      queues.set(id, [...(queues.get(id) ?? []), ...answers]);
    },
    failClose(err) {
      closeError = err;
    },
    async close() {
      closes += 1;
      if (closeError !== undefined) throw closeError;
    },
  };
}

export interface FakeDeps extends LockDeps {
  readonly events: LockEvent[];
  /** Runs every registered interval callback once. */
  fire(): void;
  readonly intervals: number;
  clock: number;
}

export function fakeDeps(over: Partial<LockDeps> = {}): FakeDeps {
  const events: LockEvent[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  let uuids = 0;
  const deps: FakeDeps = {
    clock: 1_000_000,
    events,
    now: () => deps.clock,
    setInterval: (fn) => {
      const id = next;
      next += 1;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (handle) => {
      timers.delete(handle as number);
    },
    randomUUID: () => {
      uuids += 1;
      return uuid(uuids);
    },
    // One macrotask, then the clock moves: a statement the fake answers wins
    // any race against a bound, and an abort ends the sleep early without
    // moving the clock (so a bound that lost costs no simulated time).
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          deps.clock += ms;
          resolve();
        }, 0);
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    onEvent: (e) => events.push(e),
    fire() {
      for (const fn of [...timers.values()]) fn();
    },
    get intervals() {
      return timers.size;
    },
    ...over,
  };
  return deps;
}

/** Lets every pending microtask and timer-free promise chain settle. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

export interface ManualDeps extends FakeDeps {
  /** Moves the clock by ms, waking each due sleeper in time order and settling after each. */
  advance(ms: number): Promise<void>;
  /** Sleepers not yet woken. */
  readonly sleepers: number;
}

/** fakeDeps whose sleep waits for `advance` (or its signal), for queued waiters. */
export function manualDeps(over: Partial<LockDeps> = {}): ManualDeps {
  const pending: { at: number; wake: () => void }[] = [];
  const base = fakeDeps(over);
  const deps = base as ManualDeps;
  deps.sleep = (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const entry = { at: deps.clock + ms, wake: resolve };
      pending.push(entry);
      signal?.addEventListener(
        "abort",
        () => {
          // A sleeper already woken is gone: splice(-1) would drop another's.
          const at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
          resolve();
        },
        { once: true },
      );
    });
  deps.advance = async (ms) => {
    const target = deps.clock + ms;
    await flush();
    for (;;) {
      pending.sort((x, y) => x.at - y.at);
      const next = pending[0];
      if (next === undefined || next.at > target) break;
      pending.shift();
      deps.clock = Math.max(deps.clock, next.at);
      next.wake();
      await flush();
    }
    deps.clock = target;
    await flush();
  };
  Object.defineProperty(deps, "sleepers", { get: () => pending.length });
  return deps;
}
