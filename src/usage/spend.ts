import { quoteIdentifier, type Sql } from "../db/index.ts";
import { q, quoteTable } from "../internal/slice.ts";
import { priceTokens, type RunsSlice } from "../runs/index.ts";
import type { Clock, LogEvent, SpendCharger, Usage } from "../serve/types.ts";
import { errorClassOf } from "./error-class.ts";
import { configError } from "./errors.ts";
import { guardedLog } from "./log.ts";

export type SpendUnit = "tokens" | "usd";

/** Where per-caller daily totals live. Both calls work on the server's current UTC day. */
export interface SpendStore {
  /** The units this store can hold. */
  readonly units: readonly SpendUnit[];
  /** The caller's total for today, 0 when there is no row. */
  load(caller: string, unit: SpendUnit): Promise<number>;
  /** Adds `amount` to today's total and returns the new total. */
  add(caller: string, unit: SpendUnit, amount: number | string): Promise<number>;
}

export type SpendStoreShape =
  /** rootstock's own `spend` table (window_start, caller, unit). */
  | { kind: "rootstock"; schema: string }
  /** A consumer's table keyed (day, user), counting tokens. */
  | {
      kind: "day-user-tokens";
      schema: string;
      table: string;
      day: string;
      user: string;
      used: string;
    };

const TODAY = "(now() at time zone 'utc')::date";

/** A numeric or bigint comes back as a string from both drivers. */
function total(rows: readonly Record<string, unknown>[]): number {
  const v = rows[0]?.used;
  return v === undefined || v === null ? 0 : Number(v);
}

export interface PostgresSpendStoreOptions {
  /** The tagged-template subset postgres.js and `Bun.SQL` share. */
  readonly sql: Sql;
  readonly shape: SpendStoreShape;
}

/**
 * The spend store on Postgres. Each add is one upsert that returns the new
 * total, so a process sharing the row with others learns their spend too.
 * "Today" is the server's UTC date (`now()`), not the app's clock.
 */
export function postgresSpendStore(o: PostgresSpendStoreOptions): SpendStore {
  const { sql, shape } = o;
  if (shape?.kind === "rootstock") {
    const t = quoteTable({ schema: shape.schema, name: "spend" });
    const load = `select used from ${t} where window_start = ${TODAY} and caller = $1 and unit = $2`;
    const add = `insert into ${t} (window_start, caller, unit, used) values (${TODAY}, $1, $2, $3) on conflict (window_start, caller, unit) do update set used = ${t}.used + excluded.used returning used`;
    return Object.freeze({
      units: Object.freeze(["tokens", "usd"] as const),
      load: async (caller: string, unit: SpendUnit) =>
        total(await sql.unsafe(load, [caller, unit])),
      add: async (caller: string, unit: SpendUnit, amount: number | string) =>
        total(await sql.unsafe(add, [caller, unit, amount])),
    });
  }
  if (shape?.kind === "day-user-tokens") {
    const t = quoteTable({ schema: shape.schema, name: shape.table });
    const day = quoteIdentifier(shape.day);
    const user = quoteIdentifier(shape.user);
    const used = quoteIdentifier(shape.used);
    const load = `select ${used} as used from ${t} where ${day} = ${TODAY} and ${user} = $1`;
    const add = `insert into ${t} (${day}, ${user}, ${used}) values (${TODAY}, $1, $2) on conflict (${day}, ${user}) do update set ${used} = ${t}.${used} + excluded.${used} returning ${used} as used`;
    return Object.freeze({
      units: Object.freeze(["tokens"] as const),
      load: async (caller: string) => total(await sql.unsafe(load, [caller])),
      add: async (caller: string, _unit: SpendUnit, amount: number | string) =>
        total(await sql.unsafe(add, [caller, amount])),
    });
  }
  throw configError(
    `postgresSpendStore: shape.kind must be "rootstock" or "day-user-tokens" — got ${q((shape as { kind?: unknown } | undefined)?.kind)}`,
  );
}

/** A class whose instances are the refusal, built from its text. */
export type ErrorConstructorOf = new (message: string) => Error;

export interface SpendCeilingOptions {
  readonly store: SpendStore;
  readonly unit: SpendUnit;
  /** Refuse once today's total reaches this. */
  readonly ceiling: number;
  /** A runs slice whose prices turn tokens into dollars; required for "usd". */
  readonly prices: RunsSlice | null;
  /** The refusal's text from the total and the ceiling. */
  readonly refusal: (used: number, ceiling: number) => string;
  /** The error `assertWithin` throws, built from the refusal's text. */
  readonly errorClass: ErrorConstructorOf;
  readonly clock: Clock;
  readonly log: LogEvent;
}

const DAY_MS = 86_400_000;

const countable = (n: unknown): boolean =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

interface Entry {
  /** The store's total from the newest-issued request answered so far; null before any, or to reload. */
  base: number | null;
  /** The issue number of the request `base` came from; 0 before any. */
  seq: number;
  /** Adds sent and not yet answered. */
  pending: number;
  /** Adds whose write failed: still counted here, never in the store. */
  kept: number;
}

/**
 * A daily per-caller ceiling. `assertWithin()` reads the caller's total once
 * per UTC day and then works from a cache: it throws `errorClass(refusal(…))`
 * when the total has reached the ceiling. `record(u)` adds to the cache before
 * it yields, so a check later in the same call sees it, then upserts; the
 * returned total (the store's, all processes included) replaces the cached
 * one. Calls are charged whatever their outcome.
 *
 * Two clocks: the cache's day is the app's (`clock`, UTC), the store's row is
 * the server's (`now()` in the SQL). Around midnight they can disagree, so
 * every store request is numbered as it is issued and only an answer newer
 * than the one applied replaces the cached total (set, not max: today's add
 * may answer less than yesterday's load). A refusal drops the cached total,
 * so a refused caller's next check reads the store again and is let through
 * once the server's day has turned.
 *
 * Failures: a failed or non-finite read rejects `assertWithin` (fail closed)
 * and the next check reads again. A failed write is logged
 * (`usage.spend_write_failed`) and its amount stays in this process's cache;
 * a write that committed but whose answer was lost is then counted twice,
 * which errs toward refusing.
 *
 * "usd": each meter call is priced on its own with `priceTokens`, rounded to
 * whole micro-dollars, so a call worth under half a micro-dollar is free. A
 * model the price table lacks is not charged (fail open, decided) and logs
 * `usage.spend_unpriced` on every such call.
 *
 * Not fixed: two concurrent calls of one caller can both pass the check
 * before either records, so the ceiling can be overshot by what they spend.
 */
export function createSpendCeiling(o: SpendCeilingOptions): SpendCharger {
  const { store, unit, ceiling, prices, refusal, errorClass, clock } = o;
  const log = guardedLog(o.log);
  if (unit !== "tokens" && unit !== "usd") {
    throw configError(`createSpendCeiling: unit must be "tokens" or "usd" — got ${q(unit)}`);
  }
  if (!store?.units?.includes(unit)) {
    throw configError(`createSpendCeiling: the store does not hold unit ${q(unit)}`);
  }
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) {
    throw configError(
      `createSpendCeiling: ceiling must be a positive finite number — got ${q(ceiling)}`,
    );
  }
  if (unit === "usd" && prices === null) {
    throw configError('createSpendCeiling: unit "usd" needs the runs slice\'s prices');
  }
  if (prices !== null) {
    try {
      priceTokens(prices, new Map(), { metered: true, estimated: false });
    } catch {
      throw configError("createSpendCeiling: prices must be a runs slice built by runsSlice()");
    }
  }
  // Today's entries only: the first call of a new UTC day clears the map, so
  // a caller who stops calling is not kept.
  const cache = new Map<string, Entry>();
  let currentDay: number | null = null;

  const entryFor = (caller: string): Entry => {
    const day = Math.floor(clock.now() / DAY_MS);
    if (day !== currentDay) {
      cache.clear();
      currentDay = day;
    }
    let e = cache.get(caller);
    if (e === undefined) {
      e = { base: null, seq: 0, pending: 0, kept: 0 };
      cache.set(caller, e);
    }
    return e;
  };
  // Every store request gets the next number when it is issued.
  let issued = 0;
  // A store answer, applied only when its request was issued after the one
  // `base` came from; an older answer arriving late is ignored. A load that
  // already counts an add still in flight overcounts it until that add's
  // answer lands; a load issued after an add but read before it committed
  // undercounts it until the next add answers.
  const settle = (e: Entry, seq: number, storeTotal: number): void => {
    if (!Number.isFinite(storeTotal)) {
      throw new Error(
        "rootstock usage: the spend store answered a total that is not a finite number",
      );
    }
    if (seq > e.seq) {
      e.base = storeTotal;
      e.seq = seq;
    }
  };

  const amountOf = (u: Usage): number | string | null => {
    if (unit === "tokens") return u.input + u.output;
    // A ceiling charges what was spent: "estimated" changes only a note.
    const cost = priceTokens(prices as RunsSlice, new Map([[u.model, u]]), {
      metered: true,
      estimated: false,
    });
    return cost.costUsd;
  };

  return {
    forCaller(caller) {
      return {
        async assertWithin() {
          const e = entryFor(caller);
          if (e.base === null) {
            const seq = ++issued;
            settle(e, seq, await store.load(caller, unit));
          }
          const used = (e.base ?? 0) + e.pending + e.kept;
          if (used >= ceiling) {
            e.base = null;
            throw new errorClass(refusal(used, ceiling));
          }
        },
        async record(u) {
          if (!countable(u.input) || !countable(u.output)) {
            log("usage.spend_bad_usage", { model: u.model });
            return;
          }
          const amount = amountOf(u);
          if (amount === null) {
            log("usage.spend_unpriced", { model: u.model });
            return;
          }
          const n = Number(amount);
          if (!(n > 0)) return;
          const e = entryFor(caller);
          e.pending += n;
          const seq = ++issued;
          try {
            settle(e, seq, await store.add(caller, unit, amount));
          } catch (err) {
            e.kept += n;
            log("usage.spend_write_failed", { unit, errorClass: errorClassOf(err) });
          } finally {
            e.pending -= n;
          }
        },
      };
    },
  };
}
