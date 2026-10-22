import * as concurrency from "../concurrency/index.ts";
import * as db from "../db/index.ts";
import * as migrate from "../migrate/index.ts";
import {
  composeRootstockConfig,
  type RootstockConfig,
  type RootstockConfigInput,
} from "./define.ts";
import type { SliceParsers } from "./slices.ts";

/**
 * The real slice parsers, read off their subpaths' namespaces at call time
 * rather than imported by name, so config loads while a subpath still
 * exports nothing (db exports its parser; migrate and concurrency may not
 * yet). Calling it before then refuses by name.
 */
function siblingParsers(): SliceParsers {
  const parsers: Partial<SliceParsers> = {
    clientSlice: (db as Partial<SliceParsers>).clientSlice,
    migrateSlice: (migrate as Partial<SliceParsers>).migrateSlice,
    concurrencySlice: (concurrency as Partial<SliceParsers>).concurrencySlice,
  };
  for (const [name, parser] of Object.entries(parsers)) {
    if (typeof parser !== "function") {
      throw new Error(`defineRootstockConfig: ${name} is not exported by its subpath`);
    }
  }
  return parsers as SliceParsers;
}

/** Composes the client, migrate and concurrency slices and checks the invariants. */
export function defineRootstockConfig(input: RootstockConfigInput): RootstockConfig {
  return composeRootstockConfig(siblingParsers(), input);
}
