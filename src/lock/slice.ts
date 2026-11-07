import {
  type Brand,
  bounded,
  intIn,
  isRecord,
  own,
  sliceBrand,
  sliceRefusals,
  tableRef,
} from "../internal/slice.ts";

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
  /** `block`: block-mode waiting; absent, a block-mode wait refuses WAIT. */
  wait: { maxMs: number; pollIntervalMs: number; block?: { checkIntervalMs: number } };
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
  readonly wait: {
    readonly maxMs: number;
    readonly pollIntervalMs: number;
    /** Absent when the input had none (the key is then missing, not undefined). */
    readonly block?: { readonly checkIntervalMs: number };
  };
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
const WAIT_KEYS: ReadonlySet<string> = new Set(["maxMs", "pollIntervalMs", "block"]);
const BLOCK_KEYS: ReadonlySet<string> = new Set(["checkIntervalMs"]);

// A profile name and a group name follow the same rule.
const DASHED_NAME = /^[a-z][a-z0-9-]*$/;
const ENTRY = /^[a-z0-9][a-z0-9:._-]*\*?$/;
const NAME = /^[a-z0-9][a-z0-9:._-]*$/;
// The rules are ASCII-only, so characters are bytes.
const MAX_NAME_BYTES = 200;

const E_NAMES = "a non-empty array of lock names";
const E_ENTRY =
  "a lock name matching [a-z0-9][a-z0-9:._-]* (optionally ending in one *) of at most 200 bytes";
const E_UNIQUE = "a name no other entry already admits";
const E_GROUP_ENTRY = "an exact lock name the names admit, once";

const refuse = sliceRefusals(PARSER);
const brand: Brand<LockSlice> = sliceBrand("LockSlice", PARSER);

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
    if (!DASHED_NAME.test(group)) {
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

function parseBlock(raw: unknown): { checkIntervalMs: number } {
  const block = refuse.record("wait.block", raw);
  refuse.refuseUnknownKeys(block, BLOCK_KEYS, "wait.block.");
  const checkIntervalMs = own(block, "checkIntervalMs");
  if (checkIntervalMs === undefined) throw refuse.required("wait.block.checkIntervalMs");
  return Object.freeze({
    checkIntervalMs: bounded(refuse, "wait.block.checkIntervalMs", checkIntervalMs, 100, 10_000),
  });
}

function parseWait(raw: unknown): LockSlice["wait"] {
  const wait = refuse.record("wait", raw);
  refuse.refuseUnknownKeys(wait, WAIT_KEYS, "wait.");
  const maxMs = own(wait, "maxMs");
  const pollIntervalMs = own(wait, "pollIntervalMs");
  if (maxMs === undefined) throw refuse.required("wait.maxMs");
  if (pollIntervalMs === undefined) throw refuse.required("wait.pollIntervalMs");
  const parsed = {
    maxMs: bounded(refuse, "wait.maxMs", maxMs, 0, 3_600_000),
    pollIntervalMs: bounded(refuse, "wait.pollIntervalMs", pollIntervalMs, 10, 60_000),
  };
  const block = own(wait, "block");
  return Object.freeze(block === undefined ? parsed : { ...parsed, block: parseBlock(block) });
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
  const table = tableRef(
    refuse,
    own(fields, "table"),
    "",
    defaults?.schema ?? "rootstock",
    "run_locks",
  );
  const profile = own(fields, "profile");
  if (typeof profile !== "string" || !DASHED_NAME.test(profile)) {
    throw refuse.invalid("profile", "a profile name matching [a-z][a-z0-9-]*", profile);
  }
  const names = parseNames(own(fields, "names"));
  const groups = parseGroups(own(fields, "groups"), names);
  const heartbeatSeconds = bounded(
    refuse,
    "heartbeatSeconds",
    own(fields, "heartbeatSeconds"),
    5,
    300,
  );
  const probeStallSeconds = own(fields, "probeStallSeconds");
  if (!intIn(probeStallSeconds, heartbeatSeconds + 1, 600)) {
    throw refuse.invalid(
      "probeStallSeconds",
      "an integer above heartbeatSeconds and at most 600",
      probeStallSeconds,
    );
  }
  const maxRecoveries = bounded(refuse, "maxRecoveries", own(fields, "maxRecoveries"), 0, 20);
  const endTimeoutSeconds = bounded(
    refuse,
    "endTimeoutSeconds",
    own(fields, "endTimeoutSeconds"),
    1,
    60,
  );
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
  // The brand is membership, not a key, so the spread carries only fields.
  return lockSlice({
    ...slice,
    table: { ...slice.table },
    names: [...slice.names, ...extra],
    wait: { ...slice.wait },
  });
}

/** Refuses any slice `lockSlice` or `withNames` did not return, naming the caller. */
export function assertLockSlice(fn: string, slice: unknown): asserts slice is LockSlice {
  brand.assert(fn, slice);
}
