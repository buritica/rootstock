import type {
  ClientSlice,
  ClientSliceInput,
  ConcurrencySlice,
  ConcurrencySliceInput,
  MigrateSlice,
  MigrateSliceInput,
  SliceParsers,
} from "./slices.ts";

export interface Invariant {
  /** Matches [a-z0-9][a-z0-9.-]* and is unique within one config. */
  readonly id: string;
  /** null = holds; a string = the failure message. */
  check(config: RootstockConfig): string | null;
}

export interface RootstockConfigInput {
  client: ClientSliceInput;
  migrate: MigrateSliceInput;
  concurrency: ConcurrencySliceInput;
  invariants?: readonly Invariant[];
}

declare const rootstockConfigBrand: unique symbol;
export interface RootstockConfig {
  readonly [rootstockConfigBrand]: true;
  readonly client: ClientSlice;
  readonly migrate: MigrateSlice;
  readonly concurrency: ConcurrencySlice;
  /** The ids that were checked and held, in input order. */
  readonly invariants: readonly string[];
}

const built = new WeakSet<object>();
const INVARIANT_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** True when `config` came from this module, and is safe to read as one. */
export function isRootstockConfig(config: unknown): config is RootstockConfig {
  return typeof config === "object" && config !== null && built.has(config);
}

/**
 * Parses each slice, then runs every invariant against the assembled config
 * and reports all failures at once, so fixing one does not reveal the next.
 * The parsers are a parameter so the composition can be tested on its own.
 */
export function composeRootstockConfig(
  parsers: SliceParsers,
  input: RootstockConfigInput,
): RootstockConfig {
  const client = parsers.clientSlice(input.client);
  const migrate = parsers.migrateSlice(input.migrate);
  const concurrency = parsers.concurrencySlice(input.concurrency);

  const invariants = input.invariants ?? [];
  const seen = new Set<string>();
  for (const { id } of invariants) {
    if (typeof id !== "string" || !INVARIANT_ID.test(id) || seen.has(id)) {
      throw new Error(
        `defineRootstockConfig: invariant id ${JSON.stringify(id)} must match [a-z0-9][a-z0-9.-]* and be unique`,
      );
    }
    seen.add(id);
  }

  const ids = invariants.map((inv) => inv.id);
  const config = deepFreeze({ client, migrate, concurrency, invariants: ids });
  built.add(config);
  const branded = config as unknown as RootstockConfig;

  const failures: { id: string; message: string }[] = [];
  for (const inv of invariants) {
    let message: string | null;
    try {
      message = inv.check(branded);
    } catch (err) {
      // A check that cannot run is a check that did not hold.
      message = err instanceof Error ? err.message : String(err);
    }
    if (message !== null) failures.push({ id: inv.id, message });
  }
  if (failures.length > 0) {
    built.delete(config);
    throw new Error(
      `defineRootstockConfig: ${failures.length} invariant(s) failed — ${failures.map((f) => `${f.id}: ${f.message}`).join("; ")}`,
    );
  }
  return branded;
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
