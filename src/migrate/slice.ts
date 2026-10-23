import { type Brand, isRecord, own, sliceBrand, sliceRefusals } from "../internal/slice.ts";
import { checkIdentifier } from "./identifier.ts";
import { NAME_RULE } from "./marker.ts";

/** D41: an applied file whose hash differs from today's file, accepted after the census. */
export interface AcceptedHash {
  readonly source: string;
  readonly id: string;
  /** The hash the tracker row holds. */
  readonly recorded: string;
  /** The hash the file has today. A file edited again is tampered. */
  readonly current: string;
  readonly reason: string;
}

export interface MigrateSliceInput {
  /** Identifier rule of `db`'s `quoteIdentifier`. Default "rootstock". */
  schema?: string;
  /** What to do when the database has applied rootstock migrations this package does not ship. Required. */
  ahead: "refuse" | "allow";
  /** Applied files whose hash differs from today's file, each accepted for exactly one pair. */
  accepted?: readonly AcceptedHash[];
}

declare const migrateSliceBrand: unique symbol;
export interface MigrateSlice {
  readonly [migrateSliceBrand]: true;
  readonly schema: string;
  readonly ahead: "refuse" | "allow";
  readonly accepted: readonly AcceptedHash[];
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(["schema", "ahead", "accepted"]);
const ACCEPTED_KEYS: ReadonlySet<string> = new Set([
  "source",
  "id",
  "recorded",
  "current",
  "reason",
]);
const HEX64 = /^[0-9a-f]{64}$/;
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
  const accepted = parseAccepted(own(fields, "accepted"));
  return brand.mark(Object.freeze({ schema, ahead, accepted }) as MigrateSlice);
}

function parseAccepted(raw: unknown): readonly AcceptedHash[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) throw refuse.invalid("accepted", "an array", raw);
  const seen = new Set<string>();
  return Object.freeze(
    raw.map((item, i) => {
      const at = `accepted[${i}]`;
      const entry = refuse.record(at, item);
      refuse.refuseUnknownKeys(entry, ACCEPTED_KEYS, `${at}.`);
      const field = (key: string): unknown => {
        const value = own(entry, key);
        if (value === undefined) throw refuse.required(`${at}.${key}`);
        return value;
      };
      const source = field("source");
      if (typeof source !== "string" || !NAME_RULE.test(source)) {
        throw refuse.invalid(`${at}.source`, "a source name matching [a-z][a-z0-9-]*", source);
      }
      const id = field("id");
      if (typeof id !== "string" || id === "")
        throw refuse.invalid(`${at}.id`, "a non-empty string", id);
      const recorded = field("recorded");
      const current = field("current");
      for (const [key, value] of [
        ["recorded", recorded],
        ["current", current],
      ] as const) {
        if (typeof value !== "string" || !HEX64.test(value)) {
          throw refuse.invalid(`${at}.${key}`, "64 lowercase hex characters", value);
        }
      }
      if (recorded === current) {
        throw refuse.invalid(`${at}.current`, "different from recorded", current);
      }
      const reason = field("reason");
      if (typeof reason !== "string" || reason.trim() === "") {
        throw refuse.invalid(`${at}.reason`, "a non-empty string", reason);
      }
      const pair = JSON.stringify([source, id]);
      if (seen.has(pair))
        throw refuse.invalid(at, "a (source, id) pair not listed earlier", [source, id]);
      seen.add(pair);
      return Object.freeze({ source, id, recorded, current, reason } as AcceptedHash);
    }),
  );
}

/** Refuses any slice `migrateSlice` did not return, naming the caller. */
export function assertMigrateSlice(fn: string, slice: unknown): asserts slice is MigrateSlice {
  brand.assert(fn, slice);
}
