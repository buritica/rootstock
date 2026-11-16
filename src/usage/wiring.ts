import { priceTokens, type RunsSlice, type TokenCost, unpricedNote } from "../runs/index.ts";
import type { CallSink, SpendCharger, UsageWiring } from "../serve/types.ts";
import { errorClassOf } from "./error-class.ts";
import { configError } from "./errors.ts";

/** A call's metered tokens, model → counts, as the call record carries them. */
export type CallTokens = Readonly<
  Record<string, { readonly input: number; readonly output: number }>
>;

/** Prices one call's tokens: `costUsd` and `costNote` for its record. */
export type CallPricer = (tokens: CallTokens, estimated: boolean) => TokenCost;

/** A token count as priced: an estimate may be fractional or odd, so it is rounded and floored at 0. */
const wholeTokens = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/**
 * The pricer for a runs slice's price table (`priceTokens`, so a call costs
 * what a run with the same tokens costs), or, with no slice, one that prices
 * nothing: `costUsd` null, `costNote` "unpriced:<models>", the models sorted
 * and the list cut at 200 characters. No tokens: no cost and no note (nothing
 * was metered). Counts are rounded to whole tokens first.
 */
export function callPricer(prices: RunsSlice | null): CallPricer {
  return (tokens, estimated) => {
    const models = Object.keys(tokens);
    if (models.length === 0) return { costUsd: null, costNote: null };
    if (prices === null) return { costUsd: null, costNote: unpricedNote(models) };
    const whole = Object.entries(tokens).map(
      ([model, t]) =>
        [model, { input: wholeTokens(t.input), output: wholeTokens(t.output) }] as const,
    );
    return priceTokens(prices, new Map(whole), { metered: true, estimated });
  };
}

export interface UsageWiringOptions {
  sinks: readonly CallSink[];
  keepArgs: boolean;
  keepOutput: boolean;
  /** A runs slice whose price table prices each call; null prices nothing. */
  prices: RunsSlice | null;
  spend: SpendCharger | null;
  serverSha: string | null;
}

/** Builds the `UsageWiring` for `createMcpService`/`installSeams`: pricing and classification bound here. */
export function usageWiring(o: UsageWiringOptions): UsageWiring {
  if (!Array.isArray(o.sinks)) throw configError("usageWiring: sinks must be an array");
  for (const key of ["keepArgs", "keepOutput"] as const) {
    if (typeof o[key] !== "boolean") throw configError(`usageWiring: ${key} must be a boolean`);
  }
  return Object.freeze({
    sinks: Object.freeze([...o.sinks]),
    keepArgs: o.keepArgs,
    keepOutput: o.keepOutput,
    price: callPricer(o.prices),
    errorClassOf,
    spend: o.spend,
    serverSha: o.serverSha,
  });
}
