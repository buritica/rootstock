import * as concurrency from "../concurrency/index.ts";
import * as db from "../db/index.ts";
import * as migrate from "../migrate/index.ts";
import {
  composeRootstockConfig,
  type RootstockConfig,
  type RootstockConfigInput,
} from "./define.ts";
import type { SliceParsers } from "./slices.ts";

const NAMES = ["clientSlice", "migrateSlice", "concurrencySlice"] as const;

/**
 * The real slice parsers, read off their subpaths' namespaces at call time
 * rather than imported by name, so config loads while a subpath still
 * exports nothing. Calling it before then refuses by name.
 */
function siblingParsers(): SliceParsers {
  const found: Partial<SliceParsers> = { ...db, ...migrate, ...concurrency };
  for (const name of NAMES) {
    if (typeof found[name] !== "function") {
      throw new Error(`defineRootstockConfig: ${name} is not exported by its subpath`);
    }
  }
  return found as SliceParsers;
}

/** Composes the client, migrate and concurrency slices and checks the invariants. */
export function defineRootstockConfig(input: RootstockConfigInput): RootstockConfig {
  return composeRootstockConfig(siblingParsers(), input);
}
