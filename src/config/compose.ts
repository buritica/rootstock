import { concurrencySlice } from "../concurrency/index.ts";
import { clientSlice } from "../db/index.ts";
import { lockSlice } from "../lock/index.ts";
import { migrateSlice } from "../migrate/index.ts";
import { queueSlice } from "../queue/index.ts";
import { runsSlice } from "../runs/index.ts";
// The slice file, not serve's index: config loads without the MCP SDK peer.
import { serveSlice } from "../serve/slice.ts";
import { usageSlice } from "../usage/index.ts";
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
  runsSlice,
  usageSlice,
  serveSlice,
};

/** Composes the client, migrate, concurrency, lock, queue, runs, usage and serve slices and checks the invariants. */
export function defineRootstockConfig(input: RootstockConfigInput): RootstockConfig {
  return composeRootstockConfig(PARSERS, input);
}
