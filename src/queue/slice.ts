import {
  type Brand,
  isRecord,
  own,
  type SliceRefusals,
  sliceBrand,
  sliceRefusals,
  tableRef,
} from "../internal/slice.ts";

export interface CursorTableInput {
  /** Default { schema: <default schema>, name: "cursors" }. */
  table?: { schema?: string; name?: string };
  value: "text" | "jsonb";
  maxNameChars: number;
  maxValueChars: number;
}

export interface QueueSliceInput {
  /** Default { schema: <default schema>, name: "work_queue" }. */
  table?: { schema?: string; name?: string };
  sources: readonly string[];
  kinds: readonly string[];
  stickyKind?: string;
  expiredClaimClass: string;
  backoffMinutes: readonly number[];
  maxAttempts: number;
  claimTimeoutMinutes: number;
  maxDebounceSeconds: number;
  maxDebounceSlideMinutes: number;
  maxKeyChars: number;
  maxNameChars: number;
  maxPayloadBytes: number;
  maxClaimLimit: number;
  enqueueLockTimeoutMs: number;
  cursors?: CursorTableInput;
}

declare const cursorTableBrand: unique symbol;
export interface CursorTable {
  readonly [cursorTableBrand]: true;
  readonly table: { readonly schema: string; readonly name: string };
  readonly value: "text" | "jsonb";
  readonly maxNameChars: number;
  readonly maxValueChars: number;
}

declare const queueSliceBrand: unique symbol;
export interface QueueSlice {
  readonly [queueSliceBrand]: true;
  readonly table: { readonly schema: string; readonly name: string };
  readonly sources: readonly string[];
  readonly kinds: readonly string[];
  readonly stickyKind: string | null;
  readonly expiredClaimClass: string;
  readonly backoffMinutes: readonly number[];
  readonly maxAttempts: number;
  readonly claimTimeoutMinutes: number;
  readonly maxDebounceSeconds: number;
  readonly maxDebounceSlideMinutes: number;
  readonly maxKeyChars: number;
  readonly maxNameChars: number;
  readonly maxPayloadBytes: number;
  readonly maxClaimLimit: number;
  readonly enqueueLockTimeoutMs: number;
  readonly cursors: CursorTable | null;
}

const QUEUE_KEYS: ReadonlySet<string> = new Set([
  "table",
  "sources",
  "kinds",
  "stickyKind",
  "expiredClaimClass",
  "backoffMinutes",
  "maxAttempts",
  "claimTimeoutMinutes",
  "maxDebounceSeconds",
  "maxDebounceSlideMinutes",
  "maxKeyChars",
  "maxNameChars",
  "maxPayloadBytes",
  "maxClaimLimit",
  "enqueueLockTimeoutMs",
  "cursors",
]);
const QUEUE_REQUIRED = [
  "sources",
  "kinds",
  "expiredClaimClass",
  "backoffMinutes",
  "maxAttempts",
  "claimTimeoutMinutes",
  "maxDebounceSeconds",
  "maxDebounceSlideMinutes",
  "maxKeyChars",
  "maxNameChars",
  "maxPayloadBytes",
  "maxClaimLimit",
  "enqueueLockTimeoutMs",
] as const;
const CURSOR_KEYS: ReadonlySet<string> = new Set([
  "table",
  "value",
  "maxNameChars",
  "maxValueChars",
]);
const CURSOR_REQUIRED = ["value", "maxNameChars", "maxValueChars"] as const;

const NAME = /^[a-z][a-z0-9-]*$/;
const MAX_LIST = 64;
const MAX_NAME = 32;
const E_LIST = "an array of 1 to 64 names";
const E_NAME = "a unique name matching [a-z][a-z0-9-]* of at most 32 characters";

const queueRefuse = sliceRefusals("queueSlice");
const cursorRefuse = sliceRefusals("cursorTable");
const queueBrand: Brand<QueueSlice> = sliceBrand("QueueSlice", "queueSlice");
const cursorBrand: Brand<CursorTable> = sliceBrand("CursorTable", "cursorTable");

const intIn = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function bounded(refuse: SliceRefusals, path: string, value: unknown, min: number, max: number) {
  if (!intIn(value, min, max))
    throw refuse.invalid(path, `an integer from ${min} to ${max}`, value);
  return value;
}

function names(path: string, raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LIST) {
    throw queueRefuse.invalid(path, E_LIST, raw);
  }
  const out: string[] = [];
  raw.forEach((entry: unknown, i) => {
    const ok =
      typeof entry === "string" &&
      NAME.test(entry) &&
      entry.length <= MAX_NAME &&
      !out.includes(entry);
    if (!ok) throw queueRefuse.invalid(`${path}[${i}]`, E_NAME, entry);
    out.push(entry);
  });
  return Object.freeze(out);
}

function backoff(raw: unknown): readonly number[] {
  const ok =
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= 20 &&
    raw.every((v: unknown, i) => intIn(v, i === 0 ? 1 : (raw[i - 1] as number), 1440));
  if (!ok) {
    throw queueRefuse.invalid(
      "backoffMinutes",
      "1 to 20 non-decreasing integers from 1 to 1440",
      raw,
    );
  }
  return Object.freeze([...(raw as number[])]);
}

/** The cursor table's fields, refused under `refuse` at path prefix `at`. */
function parseCursor(
  refuse: SliceRefusals,
  input: unknown,
  at: string,
  schema: string,
): CursorTable {
  const fields = at === "" ? (isRecord(input) ? input : {}) : refuse.record(at.slice(0, -1), input);
  refuse.refuseUnknownKeys(fields, CURSOR_KEYS, at);
  for (const key of CURSOR_REQUIRED) {
    if (own(fields, key) === undefined) throw refuse.required(`${at}${key}`);
  }
  const table = tableRef(refuse, own(fields, "table"), at, schema, "cursors");
  const value = own(fields, "value");
  if (value !== "text" && value !== "jsonb") {
    throw refuse.invalid(`${at}value`, '"text" or "jsonb"', value);
  }
  const maxNameChars = bounded(refuse, `${at}maxNameChars`, own(fields, "maxNameChars"), 1, 512);
  const maxValueChars = bounded(
    refuse,
    `${at}maxValueChars`,
    own(fields, "maxValueChars"),
    1,
    1_048_576,
  );
  return cursorBrand.mark(
    Object.freeze({ table, value, maxNameChars, maxValueChars }) as unknown as CursorTable,
  );
}

/**
 * Parses a cursor table into a frozen, branded object: where a consumer's
 * named resume points live, and whether its `value` column is text or jsonb.
 */
export function cursorTable(input: CursorTableInput, defaults?: { schema?: string }): CursorTable {
  return parseCursor(cursorRefuse, input, "", defaults?.schema ?? "rootstock");
}

/**
 * Parses the queue slice into a deep-frozen, branded object. Every policy
 * number is required; `table` defaults to `<defaults.schema>.work_queue`.
 * Refuses in the shared order: unknown keys, then required fields, then
 * values, with `expiredClaimClass` checked after `maxNameChars`.
 */
export function queueSlice(input: QueueSliceInput, defaults?: { schema?: string }): QueueSlice {
  const r = queueRefuse;
  const fields: Record<string, unknown> = isRecord(input) ? input : {};
  r.refuseUnknownKeys(fields, QUEUE_KEYS, "");
  for (const key of QUEUE_REQUIRED) {
    if (own(fields, key) === undefined) throw r.required(key);
  }
  const schema = defaults?.schema ?? "rootstock";
  const table = tableRef(r, own(fields, "table"), "", schema, "work_queue");
  const sources = names("sources", own(fields, "sources"));
  const kinds = names("kinds", own(fields, "kinds"));
  const sticky = own(fields, "stickyKind");
  if (sticky !== undefined && (typeof sticky !== "string" || !kinds.includes(sticky))) {
    throw r.invalid("stickyKind", "one of kinds", sticky);
  }
  const backoffMinutes = backoff(own(fields, "backoffMinutes"));
  const maxAttempts = bounded(r, "maxAttempts", own(fields, "maxAttempts"), 1, 20);
  const claimTimeoutMinutes = bounded(
    r,
    "claimTimeoutMinutes",
    own(fields, "claimTimeoutMinutes"),
    1,
    1440,
  );
  const maxDebounceSeconds = bounded(
    r,
    "maxDebounceSeconds",
    own(fields, "maxDebounceSeconds"),
    0,
    86_400,
  );
  const maxDebounceSlideMinutes = bounded(
    r,
    "maxDebounceSlideMinutes",
    own(fields, "maxDebounceSlideMinutes"),
    1,
    1440,
  );
  const maxKeyChars = bounded(r, "maxKeyChars", own(fields, "maxKeyChars"), 1, 512);
  const maxNameChars = bounded(r, "maxNameChars", own(fields, "maxNameChars"), 1, 512);
  const expiredClaimClass = own(fields, "expiredClaimClass");
  if (
    typeof expiredClaimClass !== "string" ||
    expiredClaimClass.length < 1 ||
    expiredClaimClass.length > maxNameChars ||
    expiredClaimClass.includes("\0")
  ) {
    throw r.invalid(
      "expiredClaimClass",
      "a non-empty string of at most maxNameChars characters with no NUL",
      expiredClaimClass,
    );
  }
  const maxPayloadBytes = bounded(
    r,
    "maxPayloadBytes",
    own(fields, "maxPayloadBytes"),
    1,
    1_048_576,
  );
  const maxClaimLimit = bounded(r, "maxClaimLimit", own(fields, "maxClaimLimit"), 1, 10_000);
  const enqueueLockTimeoutMs = bounded(
    r,
    "enqueueLockTimeoutMs",
    own(fields, "enqueueLockTimeoutMs"),
    1,
    60_000,
  );
  const rawCursors = own(fields, "cursors");
  const cursors = rawCursors === undefined ? null : parseCursor(r, rawCursors, "cursors.", schema);
  return queueBrand.mark(
    Object.freeze({
      table,
      sources,
      kinds,
      stickyKind: sticky === undefined ? null : sticky,
      expiredClaimClass,
      backoffMinutes,
      maxAttempts,
      claimTimeoutMinutes,
      maxDebounceSeconds,
      maxDebounceSlideMinutes,
      maxKeyChars,
      maxNameChars,
      maxPayloadBytes,
      maxClaimLimit,
      enqueueLockTimeoutMs,
      cursors,
    }) as unknown as QueueSlice,
  );
}

export function assertQueueSlice(fn: string, value: unknown): asserts value is QueueSlice {
  queueBrand.assert(fn, value);
}

export function assertCursorTable(fn: string, value: unknown): asserts value is CursorTable {
  cursorBrand.assert(fn, value);
}
