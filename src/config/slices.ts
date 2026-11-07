import type { concurrencySlice } from "../concurrency/index.ts";
import type { clientSlice } from "../db/index.ts";
import type { lockSlice } from "../lock/index.ts";
import type { migrateSlice } from "../migrate/index.ts";
import type { queueSlice } from "../queue/index.ts";

/** The slice parsers config composes, in the order it calls them. */
export interface SliceParsers {
  clientSlice: typeof clientSlice;
  migrateSlice: typeof migrateSlice;
  concurrencySlice: typeof concurrencySlice;
  lockSlice: typeof lockSlice;
  queueSlice: typeof queueSlice;
}

type Slice<K extends keyof SliceParsers> = ReturnType<SliceParsers[K]>;
type Input<K extends keyof SliceParsers> = Parameters<SliceParsers[K]>[0];

export type ClientInput = Input<"clientSlice">;
export type MigrateInput = Input<"migrateSlice">;
export type ConcurrencyInput = Input<"concurrencySlice">;
export type LockInput = Input<"lockSlice">;
export type QueueInput = Input<"queueSlice">;

export type ClientSlice = Slice<"clientSlice">;
export type MigrateSlice = Slice<"migrateSlice">;
export type ConcurrencySlice = Slice<"concurrencySlice">;
export type LockSlice = Slice<"lockSlice">;
export type QueueSlice = Slice<"queueSlice">;
