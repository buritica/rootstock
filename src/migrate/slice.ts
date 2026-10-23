import { type Brand, isRecord, own, sliceBrand, sliceRefusals } from "../internal/slice.ts";
import { checkIdentifier } from "./identifier.ts";

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

const KNOWN_KEYS: ReadonlySet<string> = new Set(["schema", "ahead"]);
const refuse = sliceRefusals("migrateSlice");
const brand: Brand<MigrateSlice> = sliceBrand("MigrateSlice", "migrateSlice");

/** Parses the migrate slice into a frozen, branded object. */
export function migrateSlice(input: MigrateSliceInput): MigrateSlice {
  const fields: Record<string, unknown> = isRecord(input) ? input : {};
  refuse.refuseUnknownKeys(fields, KNOWN_KEYS, "");
  const rawSchema = own(fields, "schema");
  const schema =
    rawSchema === undefined ? "rootstock" : checkIdentifier("migrateSlice: schema", rawSchema);
  const ahead = own(fields, "ahead");
  if (ahead === undefined) throw refuse.required("ahead");
  if (ahead !== "refuse" && ahead !== "allow") {
    throw refuse.invalid("ahead", '"refuse" or "allow"', ahead);
  }
  return brand.mark(Object.freeze({ schema, ahead }) as MigrateSlice);
}

/** Refuses any slice `migrateSlice` did not return, naming the caller. */
export function assertMigrateSlice(fn: string, slice: unknown): asserts slice is MigrateSlice {
  brand.assert(fn, slice);
}
