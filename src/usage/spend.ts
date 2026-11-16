import { quoteIdentifier, type Sql } from "../db/index.ts";
import { q } from "../internal/slice.ts";
import { priceTokens, type RunsSlice } from "../runs/index.ts";
import type { Clock, LogEvent, SpendCharger, Usage } from "../serve/types.ts";
import { errorClassOf } from "./error-class.ts";
import { configError } from "./errors.ts";

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

/**
 * The spend store on Postgres. Each add is one upsert that returns the new
 * total, so a process sharing the row with others learns their spend too.
 */
export function postgresSpendStore(o: { sql: Sql; shape: SpendStoreShape }): SpendStore {
  const { sql, shape } = o;
  if (shape?.kind === "rootstock") {
    const t = `${quoteIdentifier(shape.schema)}.spend`;
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
    const t = `${quoteIdentifier(shape.schema)}.${quoteIdentifier(shape.table)}`;
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

export interface SpendCeilingOptions {
  store: SpendStore;
  unit: SpendUnit;
  /** Refuse once today's total reaches this. */
  ceiling: number;
  /** A runs slice whose prices turn tokens into dollars; required for "usd". */
  prices: RunsSlice | null;
  /** The refusal's text from the total and the ceiling. */
  refusal: (used: number, ceiling: number) => string;
  /** The error `assertWithin` throws, built from the refusal's text. */
  errorClass: new (
    m: string,
  ) => Error;
  clock: Clock;
  log: LogEvent;
}

const DAY_MS = 86_400_000;

const countable = (n: unknown): boolean =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

interface Entry {
  /** UTC day number of the clock. */
  day: number;
  /** The store's total as last read or returned; null before either. */
  base: number | null;
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
 * one. A failed write is logged (`usage.spend_write_failed`) and its amount
 * stays in this process's cache. Calls are charged whatever their outcome.
 * A failed read rejects `assertWithin` with the driver's error. In "usd" each
 * meter call is priced on its own (`priceTokens`, whole micro-dollars).
 *
 * Not fixed: two concurrent calls of one caller can both pass the check
 * before either records, so the ceiling can be overshot by what they spend.
 */
export function createSpendCeiling(o: SpendCeilingOptions): SpendCharger {
  const { store, unit, ceiling, prices, refusal, errorClass, clock, log } = o;
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
  const cache = new Map<string, Entry>();

  const entryFor = (caller: string): Entry => {
    const day = Math.floor(clock.now() / DAY_MS);
    let e = cache.get(caller);
    if (e === undefined || e.day !== day) {
      e = { day, base: null, pending: 0, kept: 0 };
      cache.set(caller, e);
    }
    return e;
  };
  // A total only grows within a day, so the larger of two answers is the
  // newer one, whatever order they arrive in. A read that already counts an
  // add still in flight overcounts it until that add's answer lands.
  const settle = (e: Entry, storeTotal: number): void => {
    e.base = Math.max(e.base ?? 0, storeTotal);
  };

  const amountOf = (u: Usage): number | string | null => {
    if (unit === "tokens") return u.input + u.output;
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
          if (e.base === null) settle(e, await store.load(caller, unit));
          const used = (e.base ?? 0) + e.pending + e.kept;
          if (used >= ceiling) throw new errorClass(refusal(used, ceiling));
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
          try {
            settle(e, await store.add(caller, unit, amount));
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
