import { type Brand, isRecord, own, sliceBrand, sliceRefusals } from "../internal/slice.ts";

export interface LockSliceInput {
  /** Where fencing rows live. Default: { schema: <default schema>, name: "run_locks" }. */
  table?: { schema?: string; name?: string };
  /** The client profile the lock session is opened with (config checks it). */
  profile: string;
  /** Every lock this repo takes: exact names, or "prefix*" families. Acquire refuses any other. */
  names: readonly string[];
  /** Ordered probe lists. Each entry is an exact name `names` admits. */
  groups?: Readonly<Record<string, readonly string[]>>;
  heartbeatSeconds: number;
  probeStallSeconds: number;
  maxRecoveries: number;
  endTimeoutSeconds: number;
  wait: { maxMs: number; pollIntervalMs: number };
}

declare const lockSliceBrand: unique symbol;
export interface LockSlice {
  readonly [lockSliceBrand]: true;
  readonly table: { readonly schema: string; readonly name: string };
  readonly profile: string;
  readonly names: readonly string[];
  /** {} when omitted. */
  readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly heartbeatSeconds: number;
  readonly probeStallSeconds: number;
  readonly maxRecoveries: number;
  readonly endTimeoutSeconds: number;
  readonly wait: { readonly maxMs: number; readonly pollIntervalMs: number };
}

const PARSER = "lockSlice";
const KEYS: ReadonlySet<string> = new Set([
  "table",
  "profile",
  "names",
  "groups",
  "heartbeatSeconds",
  "probeStallSeconds",
  "maxRecoveries",
  "endTimeoutSeconds",
  "wait",
]);
const REQUIRED = [
  "profile",
  "names",
  "heartbeatSeconds",
  "probeStallSeconds",
  "maxRecoveries",
  "endTimeoutSeconds",
  "wait",
] as const;
const TABLE_KEYS: ReadonlySet<string> = new Set(["schema", "name"]);
const WAIT_KEYS: ReadonlySet<string> = new Set(["maxMs", "pollIntervalMs"]);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const PROFILE = /^[a-z][a-z0-9-]*$/;
const GROUP = PROFILE;
const ENTRY = /^[a-z0-9][a-z0-9:._-]*\*?$/;
const NAME = /^[a-z0-9][a-z0-9:._-]*$/;
// The rules are ASCII-only, so characters are bytes.
const MAX_NAME_BYTES = 200;
const MAX_IDENTIFIER_BYTES = 63;

const E_IDENTIFIER = "an identifier matching [a-z_][a-z0-9_]* of at most 63 bytes";
const E_NAMES = "a non-empty array of lock names";
const E_ENTRY =
  "a lock name matching [a-z0-9][a-z0-9:._-]* (optionally ending in one *) of at most 200 bytes";
const E_UNIQUE = "a name no other entry already admits";
const E_GROUP_ENTRY = "an exact lock name the names admit, once";

const refuse = sliceRefusals(PARSER);
const brand: Brand<LockSlice> = sliceBrand("LockSlice", PARSER);

const intIn = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** True when the entry `entry` (exact, or `prefix*`) admits the name `name`. */
function entryAdmits(entry: string, name: string): boolean {
  if (!entry.endsWith("*")) return entry === name;
  const prefix = entry.slice(0, -1);
  return (
    name.length > prefix.length &&
    name.startsWith(prefix) &&
    NAME.test(name) &&
    name.length <= MAX_NAME_BYTES
  );
}

/** True when one of the slice's names admits `name`. */
export function admits(slice: LockSlice, name: unknown): boolean {
  return typeof name === "string" && slice.names.some((entry) => entryAdmits(entry, name));
}

/** True when entries `a` and `b` admit a name in common, or are the same entry. */
function overlaps(a: string, b: string): boolean {
  const aPrefix = a.endsWith("*");
  const bPrefix = b.endsWith("*");
  if (!aPrefix && !bPrefix) return a === b;
  if (aPrefix && !bPrefix) return entryAdmits(a, b);
  if (!aPrefix && bPrefix) return entryAdmits(b, a);
  const pa = a.slice(0, -1);
  const pb = b.slice(0, -1);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function identifier(path: string, value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.length > MAX_IDENTIFIER_BYTES) {
    throw refuse.invalid(path, E_IDENTIFIER, value);
  }
  return value;
}

function parseTable(raw: unknown, schema: string): { schema: string; name: string } {
  if (raw === undefined) return Object.freeze({ schema, name: "run_locks" });
  const table = refuse.record("table", raw);
  refuse.refuseUnknownKeys(table, TABLE_KEYS, "table.");
  const s = own(table, "schema");
  const n = own(table, "name");
  return Object.freeze({
    schema: s === undefined ? schema : identifier("table.schema", s),
    name: n === undefined ? "run_locks" : identifier("table.name", n),
  });
}

function parseNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw refuse.invalid("names", E_NAMES, raw);
  const out: string[] = [];
  raw.forEach((entry: unknown, i) => {
    const path = `names[${i}]`;
    if (typeof entry !== "string" || !ENTRY.test(entry) || entry.length > MAX_NAME_BYTES) {
      throw refuse.invalid(path, E_ENTRY, entry);
    }
    if (out.some((earlier) => overlaps(earlier, entry))) {
      throw refuse.invalid(path, E_UNIQUE, entry);
    }
    out.push(entry);
  });
  return Object.freeze(out);
}

function parseGroups(
  raw: unknown,
  names: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  if (raw === undefined) return Object.freeze({});
  const groups = refuse.record("groups", raw);
  const out: Record<string, readonly string[]> = {};
  for (const group of Object.keys(groups)) {
    const path = `groups.${group}`;
    if (!GROUP.test(group)) {
      throw refuse.invalid(path, "a group name matching [a-z][a-z0-9-]*", group);
    }
    const list = groups[group];
    if (!Array.isArray(list) || list.length === 0) throw refuse.invalid(path, E_NAMES, list);
    const seen: string[] = [];
    list.forEach((name: unknown, i) => {
      const ok =
        typeof name === "string" &&
        !name.includes("*") &&
        names.some((entry) => entryAdmits(entry, name)) &&
        !seen.includes(name);
      if (!ok) throw refuse.invalid(`${path}[${i}]`, E_GROUP_ENTRY, name);
      seen.push(name as string);
    });
    out[group] = Object.freeze(seen);
  }
  return Object.freeze(out);
}

function parseWait(raw: unknown): { maxMs: number; pollIntervalMs: number } {
  const wait = refuse.record("wait", raw);
  refuse.refuseUnknownKeys(wait, WAIT_KEYS, "wait.");
  const maxMs = own(wait, "maxMs");
  const pollIntervalMs = own(wait, "pollIntervalMs");
  if (maxMs === undefined) throw refuse.required("wait.maxMs");
  if (pollIntervalMs === undefined) throw refuse.required("wait.pollIntervalMs");
  if (!intIn(maxMs, 0, 3_600_000)) {
    throw refuse.invalid("wait.maxMs", "an integer from 0 to 3600000", maxMs);
  }
  if (!intIn(pollIntervalMs, 10, 60_000)) {
    throw refuse.invalid("wait.pollIntervalMs", "an integer from 10 to 60000", pollIntervalMs);
  }
  return Object.freeze({ maxMs, pollIntervalMs });
}

function bounded(path: string, value: unknown, min: number, max: number): number {
  if (!intIn(value, min, max)) {
    throw refuse.invalid(path, `an integer from ${min} to ${max}`, value);
  }
  return value;
}

/**
 * Parses the lock slice into a frozen, branded object. Every policy number is
 * required; only `table` has a default, `<defaults.schema>.run_locks`
 * (`rootstock.run_locks` when no default schema is given). Refuses in the
 * shared order: unknown keys, then required fields, then values, at every
 * level.
 */
export function lockSlice(input: LockSliceInput, defaults?: { schema?: string }): LockSlice {
  const fields: Record<string, unknown> = isRecord(input) ? input : {};
  refuse.refuseUnknownKeys(fields, KEYS, "");
  for (const key of REQUIRED) {
    if (own(fields, key) === undefined) throw refuse.required(key);
  }
  const table = parseTable(own(fields, "table"), defaults?.schema ?? "rootstock");
  const profile = own(fields, "profile");
  if (typeof profile !== "string" || !PROFILE.test(profile)) {
    throw refuse.invalid("profile", "a profile name matching [a-z][a-z0-9-]*", profile);
  }
  const names = parseNames(own(fields, "names"));
  const groups = parseGroups(own(fields, "groups"), names);
  const heartbeatSeconds = bounded("heartbeatSeconds", own(fields, "heartbeatSeconds"), 5, 300);
  const probeStallSeconds = own(fields, "probeStallSeconds");
  if (!intIn(probeStallSeconds, heartbeatSeconds + 1, 600)) {
    throw refuse.invalid(
      "probeStallSeconds",
      "an integer above heartbeatSeconds and at most 600",
      probeStallSeconds,
    );
  }
  const maxRecoveries = bounded("maxRecoveries", own(fields, "maxRecoveries"), 0, 20);
  const endTimeoutSeconds = bounded("endTimeoutSeconds", own(fields, "endTimeoutSeconds"), 1, 60);
  const wait = parseWait(own(fields, "wait"));
  return brand.mark(
    Object.freeze({
      table,
      profile,
      names,
      groups,
      heartbeatSeconds,
      probeStallSeconds,
      maxRecoveries,
      endTimeoutSeconds,
      wait,
    }) as unknown as LockSlice,
  );
}

/**
 * The slice with `extra` names appended, through the same parser: every rule
 * applies to the new names, and no number or bound is relaxed. For test
 * configs that need names the production slice does not declare.
 */
export function withNames(slice: LockSlice, extra: readonly string[]): LockSlice {
  brand.assert("withNames", slice);
  if (!Array.isArray(extra)) throw refuse.invalid("names", E_NAMES, extra);
  return lockSlice({
    table: { ...slice.table },
    profile: slice.profile,
    names: [...slice.names, ...extra],
    groups: slice.groups,
    heartbeatSeconds: slice.heartbeatSeconds,
    probeStallSeconds: slice.probeStallSeconds,
    maxRecoveries: slice.maxRecoveries,
    endTimeoutSeconds: slice.endTimeoutSeconds,
    wait: { ...slice.wait },
  });
}

/** Refuses any slice `lockSlice` or `withNames` did not return, naming the caller. */
export function assertLockSlice(fn: string, slice: unknown): asserts slice is LockSlice {
  brand.assert(fn, slice);
}
