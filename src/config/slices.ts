import type { concurrencySlice } from "../concurrency/index.ts";
import type { clientSlice } from "../db/index.ts";
import type { migrateSlice } from "../migrate/index.ts";

/** The three slice parsers config composes, in the order it calls them. */
export interface SliceParsers {
  clientSlice: typeof clientSlice;
  migrateSlice: typeof migrateSlice;
  concurrencySlice: typeof concurrencySlice;
}

type Slice<K extends keyof SliceParsers> = ReturnType<SliceParsers[K]>;
type Input<K extends keyof SliceParsers> = Parameters<SliceParsers[K]>[0];

export type ClientInput = Input<"clientSlice">;
export type MigrateInput = Input<"migrateSlice">;
export type ConcurrencyInput = Input<"concurrencySlice">;

export type ClientSlice = Slice<"clientSlice">;
export type MigrateSlice = Slice<"migrateSlice">;
export type ConcurrencySlice = Slice<"concurrencySlice">;
