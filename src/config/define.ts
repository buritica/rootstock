import type {
  ClientInput,
  ClientSlice,
  ConcurrencyInput,
  ConcurrencySlice,
  MigrateInput,
  MigrateSlice,
  SliceParsers,
} from "./slices.ts";

export interface Invariant {
  /** Matches [a-z0-9][a-z0-9.-]* and is unique within one config. */
  readonly id: string;
  /** null = holds; a string = the failure message. */
  check(config: RootstockConfig): string | null;
}

export interface RootstockConfigInput {
  client: ClientInput;
  migrate: MigrateInput;
  concurrency: ConcurrencyInput;
  invariants?: readonly Invariant[];
}

declare const rootstockConfigBrand: unique symbol;
export interface RootstockConfig {
  readonly [rootstockConfigBrand]: true;
  readonly client: ClientSlice;
  readonly migrate: MigrateSlice;
  readonly concurrency: ConcurrencySlice;
  /** Every invariant id, in input order; all of them held, or define threw. */
  readonly invariants: readonly string[];
}

const built = new WeakSet<object>();
const INVARIANT_ID = /^[a-z0-9][a-z0-9.-]*$/;

/**
 * True for a config composeRootstockConfig returned, and also while its
 * invariants are being checked; a build that fails takes it back. Nothing
 * should start I/O on a config a check was handed.
 */
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

  // Copied once: the id pass and the check pass must see the same entries.
  const invariants = [...(input.invariants ?? [])];
  const ids: string[] = [];
  for (const { id } of invariants) {
    if (typeof id !== "string" || !INVARIANT_ID.test(id) || ids.includes(id)) {
      throw new Error(
        `defineRootstockConfig: invariant id ${JSON.stringify(id)} must match [a-z0-9][a-z0-9.-]* and be unique`,
      );
    }
    ids.push(id);
  }

  // Branded before the checks run, so a check may print the config it is
  // judging; any way out of the checks other than success takes it back.
  const config = deepFreeze({
    client,
    migrate,
    concurrency,
    invariants: ids,
  } satisfies Omit<RootstockConfig, typeof rootstockConfigBrand>);
  built.add(config);
  const branded = config as unknown as RootstockConfig;

  let held = false;
  try {
    const failures: string[] = [];
    const thrown: unknown[] = [];
    for (const [i, inv] of invariants.entries()) {
      let message: unknown;
      let threw = false;
      try {
        message = inv.check(branded);
      } catch (err) {
        // A check that cannot run is a check that did not hold, whatever it threw.
        thrown.push(err);
        message = err;
        threw = true;
      }
      if (threw || message !== null) failures.push(`${ids[i]}: ${describe(message)}`);
    }
    if (failures.length > 0) {
      throw new Error(
        `defineRootstockConfig: ${failures.length} invariant(s) failed — ${failures.join("; ")}`,
        thrown.length > 0 ? { cause: thrown } : undefined,
      );
    }
    held = true;
    return branded;
  } finally {
    if (!held) built.delete(config);
  }
}

/** A failure as text, whatever a check returned or threw; never throws. */
function describe(message: unknown): string {
  try {
    if (typeof message === "string") return message;
    if (message instanceof Error) return String(message.message);
    if (typeof (message as { then?: unknown } | null)?.then === "function") {
      // Swallow a rejection so it does not surface again as an unhandled one.
      (message as PromiseLike<unknown>).then(undefined, () => {});
      return "check returned a Promise; checks must be synchronous";
    }
    return String(message);
  } catch {
    return "a value that cannot be printed";
  }
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
}
