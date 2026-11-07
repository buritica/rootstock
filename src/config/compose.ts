import { concurrencySlice } from "../concurrency/index.ts";
import { clientSlice } from "../db/index.ts";
import { lockSlice } from "../lock/index.ts";
import { migrateSlice } from "../migrate/index.ts";
import { queueSlice } from "../queue/index.ts";
import {
  composeRootstockConfig,
  type RootstockConfig,
  type RootstockConfigInput,
} from "./define.ts";
import type { SliceParsers } from "./slices.ts";

const PARSERS: SliceParsers = {
  clientSlice,
  migrateSlice,
  concurrencySlice,
  lockSlice,
  queueSlice,
};

/** Composes the client, migrate, concurrency, lock and queue slices and checks the invariants. */
export function defineRootstockConfig(input: RootstockConfigInput): RootstockConfig {
  return composeRootstockConfig(PARSERS, input);
}
