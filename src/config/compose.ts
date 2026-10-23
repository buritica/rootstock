import { concurrencySlice } from "../concurrency/index.ts";
import { clientSlice } from "../db/index.ts";
import { migrateSlice } from "../migrate/index.ts";
import {
  composeRootstockConfig,
  type RootstockConfig,
  type RootstockConfigInput,
} from "./define.ts";
import type { SliceParsers } from "./slices.ts";

const PARSERS: SliceParsers = { clientSlice, migrateSlice, concurrencySlice };

/** Composes the client, migrate and concurrency slices and checks the invariants. */
export function defineRootstockConfig(input: RootstockConfigInput): RootstockConfig {
  return composeRootstockConfig(PARSERS, input);
}
