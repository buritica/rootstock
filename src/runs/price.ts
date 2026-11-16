import { cut } from "../internal/slice.ts";
import { priceMicros, type RunsSlice } from "./slice.ts";

const NOTE_MODELS_MAX = 200;
const MICRO = 1_000_000n;

/** A cost as the run record and the call record store it. */
export interface TokenCost {
  /** Dollars with exactly 6 fractional digits, or null when not priced. */
  costUsd: string | null;
  /** null, "estimated", "unmetered" or "unpriced:<models>". */
  costNote: string | null;
}

/** `micro` micro-dollars as a decimal string with exactly 6 fractional digits. */
function dollars(micro: bigint): string {
  return `${micro / MICRO}.${(micro % MICRO).toString().padStart(6, "0")}`;
}

/** "unpriced:<models>", the models sorted and the list cut at 200 characters. */
export function unpricedNote(models: readonly string[]): string {
  return `unpriced:${cut([...models].sort().join(","), NOTE_MODELS_MAX)}`;
}

/**
 * The cost of `tokens` (model → counts) under the slice's prices, summed in
 * integer micro-dollars and rounded half up once. Not `metered`: "unmetered".
 * Any model without a price: no cost and "unpriced:<models>", sorted and cut
 * at 200 characters. Otherwise the cost, noted "estimated" when `estimated`.
 */
export function priceTokens(
  slice: RunsSlice,
  tokens: ReadonlyMap<string, { readonly input: number; readonly output: number }>,
  o: { metered: boolean; estimated: boolean },
): TokenCost {
  if (!o.metered) return { costUsd: null, costNote: "unmetered" };
  const prices = priceMicros(slice);
  const unpriced = [...tokens.keys()].filter((m) => !prices.has(m));
  if (unpriced.length > 0) return { costUsd: null, costNote: unpricedNote(unpriced) };
  let sum = 0n;
  for (const [model, t] of tokens) {
    const p = prices.get(model) as { input: bigint; output: bigint };
    sum += BigInt(t.input) * p.input + BigInt(t.output) * p.output;
  }
  return {
    costUsd: dollars((sum + 500_000n) / MICRO),
    costNote: o.estimated ? "estimated" : null,
  };
}
