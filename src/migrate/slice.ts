import { checkIdentifier, q } from "./db-surface.ts";

export interface MigrateSliceInput {
  /** Identifier rule of `db`'s `quoteIdentifier`. Default "rootstock". */
  schema?: string;
  /** What to do when the database has applied rootstock migrations this package does not ship. Required. */
  ahead: "refuse" | "allow";
}

declare const migrateSliceBrand: unique symbol;
export interface MigrateSlice {
  readonly [migrateSliceBrand]: true;
  readonly schema: string;
  readonly ahead: "refuse" | "allow";
}

const KNOWN_KEYS = new Set(["schema", "ahead"]);
const BUILT = new WeakSet<object>();

/** Parses the migrate slice into a frozen, branded object. */
export function migrateSlice(input: MigrateSliceInput): MigrateSlice {
  for (const [key, value] of Object.entries(input)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`migrateSlice: ${key} must be a known key — got ${q(value)}`);
    }
  }
  const schema =
    input.schema === undefined
      ? "rootstock"
      : checkIdentifier("migrateSlice: schema", input.schema);
  if (input.ahead === undefined) throw new Error("migrateSlice: ahead is required");
  if (input.ahead !== "refuse" && input.ahead !== "allow") {
    throw new Error(`migrateSlice: ahead must be "refuse" or "allow" — got ${q(input.ahead)}`);
  }
  const slice = Object.freeze({ schema, ahead: input.ahead }) as MigrateSlice;
  BUILT.add(slice);
  return slice;
}

/** Refuses any slice `migrateSlice` did not return, naming the caller. */
export function assertMigrateSlice(fn: string, slice: unknown): asserts slice is MigrateSlice {
  if (typeof slice === "object" && slice !== null && BUILT.has(slice)) return;
  throw new Error(
    `${fn}: expected a MigrateSlice built by migrateSlice() — got an object that parser did not return`,
  );
}
