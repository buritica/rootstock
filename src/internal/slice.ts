// The pieces the subpaths share: refusal texts, own-property reads, the brand
// registry, integer bounds, the identifier rule and the safe hook call.
// Internal: no package.json subpath exports this file.

/**
 * The `got …` part of a refusal: `JSON.stringify(value)`, except that NaN and
 * ±Infinity print as themselves (JSON would print `null`, which misleads
 * anyone reading a number parsed from an env var), and a value JSON cannot
 * serialize (a BigInt, a cycle) still yields text, so the refusal naming its
 * path reaches the caller. Only a top-level number is spelled out; inside an
 * object or array the JSON rendering stands.
 */
export function q(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "bigint" ? `${value}n` : "an unserializable value";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Own properties only, so an inherited key can neither satisfy a required
// field nor slip past the unknown-key check.
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The refusals of one parser. Every parser checks in the same order, at
 * every level: unknown keys first, then required fields, then values. An
 * entry that must be an object and is not is refused before its fields.
 */
export interface SliceRefusals {
  required(path: string): Error;
  invalid(path: string, expected: string, value: unknown): Error;
  /** Refuses the first key of `record` that `known` lacks. `at` prefixes its path. */
  refuseUnknownKeys(record: Record<string, unknown>, known: ReadonlySet<string>, at: string): void;
  /** `value` itself when it is an object, else the "must be an object" refusal. */
  record(path: string, value: unknown): Record<string, unknown>;
}

export function sliceRefusals(parser: string): SliceRefusals {
  const invalid = (path: string, expected: string, value: unknown): Error =>
    new Error(`${parser}: ${path} must be ${expected} — got ${q(value)}`);
  return {
    required: (path) => new Error(`${parser}: ${path} is required`),
    invalid,
    refuseUnknownKeys(record, known, at) {
      for (const key of Object.keys(record)) {
        // Never echoes the value: a mistyped key is where a URL or a password lands.
        if (!known.has(key)) throw new Error(`${parser}: ${at}${key} is not a known key`);
      }
    },
    record(path, value) {
      if (isRecord(value)) return value;
      throw invalid(path, "an object", value);
    },
  };
}

/**
 * Membership is the brand: only an object `mark` was handed is accepted, so a
 * hand-built object of the right shape is still refused.
 */
export interface Brand<T extends object> {
  mark(slice: T): T;
  has(value: unknown): value is T;
  /** Refuses anything `mark` was not handed, naming the calling function. */
  assert(fn: string, value: unknown): asserts value is T;
}

export function sliceBrand<T extends object>(type: string, parser: string): Brand<T> {
  const built = new WeakSet<object>();
  const has = (value: unknown): value is T =>
    typeof value === "object" && value !== null && built.has(value);
  return {
    mark(slice) {
      built.add(slice);
      return slice;
    },
    has,
    assert(fn, value) {
      if (has(value)) return;
      throw new Error(
        `${fn}: expected a ${type} built by ${parser}() — got an object that parser did not return`,
      );
    },
  };
}

/** True when `v` is an integer from `min` to `max`. */
export function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** `value` when it is an integer from `min` to `max`, else the refusal naming both. */
export function bounded(
  refuse: SliceRefusals,
  path: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (!intIn(value, min, max)) {
    throw refuse.invalid(path, `an integer from ${min} to ${max}`, value);
  }
  return value;
}

/**
 * Calls `hook` with `arg`, if there is one. What it throws is dropped, and so
 * is the rejection of a thenable it returns, so a hook can never change what
 * its caller does, nor become an unhandled rejection.
 */
export function safeHook<A>(hook: ((arg: A) => unknown) | undefined, arg: A): void {
  try {
    const out: unknown = hook?.(arg);
    if (typeof (out as PromiseLike<unknown> | undefined)?.then === "function") {
      (out as PromiseLike<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // Dropped, as above.
  }
}

/**
 * `err.code` when it is one of `codes`, else undefined. By `code`, so it
 * survives two module copies; a `code` getter that throws reads as none.
 */
export function codeIn<C extends string>(codes: ReadonlySet<C>, err: unknown): C | undefined {
  try {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === "string" && codes.has(code as C) ? (code as C) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `build(slice)` once per slice object, after `assert(fn, slice)`: the brand
 * check runs on every call, the build on the first.
 */
export function perSlice<S extends object, T>(
  assert: (fn: string, value: unknown) => asserts value is S,
  build: (slice: S) => T,
): (fn: string, slice: S) => T {
  const built = new WeakMap<S, T>();
  return (fn, slice) => {
    assert(fn, slice);
    let out = built.get(slice);
    if (out === undefined) {
      out = build(slice);
      built.set(slice, out);
    }
    return out;
  };
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// Postgres truncates a longer identifier with only a NOTICE. The rule is
// ASCII-only, so characters are bytes.
const MAX_IDENTIFIER_BYTES = 63;

/** True when `value` matches `[a-z_][a-z0-9_]*` and is at most 63 bytes. */
export function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && IDENTIFIER.test(value) && value.length <= MAX_IDENTIFIER_BYTES
  );
}

/**
 * Returns the identifier double-quoted, for splicing into `unsafe` text. Throws
 * unless it matches `[a-z_][a-z0-9_]*` and is at most 63 bytes, so no quote,
 * case fold or truncation can change what it names. `db` exports it.
 */
export function quoteIdentifier(name: string): string {
  if (!isIdentifier(name)) {
    throw new Error(
      `rootstock: identifier must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${q(name)}`,
    );
  }
  return `"${name}"`;
}

/** `<schema>.<name>`, each part through quoteIdentifier. */
export function quoteTable(table: { readonly schema: string; readonly name: string }): string {
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
}

const E_IDENTIFIER = "an identifier matching [a-z_][a-z0-9_]* of at most 63 bytes";
const TABLE_KEYS: ReadonlySet<string> = new Set(["schema", "name"]);

/** A Postgres identifier a slice splices through quoteIdentifier, or the refusal. */
export function identifier(refuse: SliceRefusals, path: string, value: unknown): string {
  if (!isIdentifier(value)) throw refuse.invalid(path, E_IDENTIFIER, value);
  return value;
}

/**
 * A slice's `table: { schema?, name? }` at path `${at}table`, frozen, each
 * part defaulting to `schema` and `name`.
 */
export function tableRef(
  refuse: SliceRefusals,
  raw: unknown,
  at: string,
  schema: string,
  name: string,
): { readonly schema: string; readonly name: string } {
  if (raw === undefined) return Object.freeze({ schema, name });
  const table = refuse.record(`${at}table`, raw);
  refuse.refuseUnknownKeys(table, TABLE_KEYS, `${at}table.`);
  const s = own(table, "schema");
  const n = own(table, "name");
  return Object.freeze({
    schema: s === undefined ? schema : identifier(refuse, `${at}table.schema`, s),
    name: n === undefined ? name : identifier(refuse, `${at}table.name`, n),
  });
}
