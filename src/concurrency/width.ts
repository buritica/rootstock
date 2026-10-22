export interface WidthInput {
  default: number;
  max: number;
}
export interface ConcurrencySliceInput {
  widths: Readonly<Record<string, WidthInput>>;
}

declare const concurrencySliceBrand: unique symbol;
export interface ConcurrencySlice {
  readonly [concurrencySliceBrand]: true;
  readonly widths: Readonly<Record<string, Readonly<WidthInput>>>;
}

const PARSER = "concurrencySlice";
const NAME = /^[a-z][a-zA-Z0-9]*$/;
// A sanity bound, not a policy value: every width a consumer declares today is far below it.
const MAX_WIDTH = 256;
const WIDTH_KEYS: ReadonlySet<string> = new Set(["default", "max"]);

// Every slice this module returned. Membership is the brand: a hand-built
// object of the right shape is still refused.
const registry = new WeakSet<object>();

// `JSON.stringify`, except that a value it cannot serialize (a BigInt, a
// cycle) still yields text, so the refusal that names the path still reaches
// the caller. The same rule as db's slice parser.
function q(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "bigint" ? `${value}n` : "an unserializable value";
  }
}

function required(path: string): Error {
  return new Error(`${PARSER}: ${path} is required`);
}

// An unknown key's value is never echoed: a mistyped key could hold anything,
// and this text is printed at boot.
function unknownKey(path: string): Error {
  return new Error(`${PARSER}: ${path} is not a known key`);
}

function invalid(path: string, expected: string, value: unknown): Error {
  return new Error(`${PARSER}: ${path} must be ${expected} — got ${q(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

// Reads own properties only, so an inherited key can neither satisfy a required
// field nor slip past the unknown-key check.
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseWidth(name: string, entry: unknown): Readonly<WidthInput> {
  const path = `widths.${name}`;
  const fields = isRecord(entry) ? entry : {};
  for (const key of Object.keys(fields)) {
    if (!WIDTH_KEYS.has(key)) throw unknownKey(`${path}.${key}`);
  }
  const def = own(fields, "default");
  const max = own(fields, "max");
  if (def === undefined) throw required(`${path}.default`);
  if (max === undefined) throw required(`${path}.max`);
  if (!isIntegerIn(max, 1, MAX_WIDTH)) {
    throw invalid(`${path}.max`, `an integer from 1 to ${MAX_WIDTH}`, max);
  }
  if (!isIntegerIn(def, 1, max)) {
    throw invalid(`${path}.default`, "an integer >= 1 and <= max", def);
  }
  return Object.freeze({ default: def, max });
}

/**
 * Parses a repo's named concurrency widths into a frozen, branded slice.
 * Every width needs both `default` and `max`, integers with
 * `1 <= default <= max <= 256`. Width names match `[a-z][a-zA-Z0-9]*`, so a
 * name can mirror the camelCase constant it replaces.
 */
export function concurrencySlice(input: ConcurrencySliceInput): ConcurrencySlice {
  const fields: Record<string, unknown> = isRecord(input) ? input : {};
  for (const key of Object.keys(fields)) {
    if (key !== "widths") throw unknownKey(key);
  }
  const widths = own(fields, "widths");
  if (widths === undefined) throw required("widths");
  if (!isRecord(widths) || Object.keys(widths).length === 0) {
    throw invalid("widths", "an object with at least one width", widths);
  }
  // No prototype, so a name like "constructor" is never found on a slice that
  // did not declare it, by `width()` or by any other reader.
  const parsed: Record<string, Readonly<WidthInput>> = Object.create(null);
  for (const name of Object.keys(widths)) {
    if (!NAME.test(name)) {
      throw invalid(`widths.${name}`, "a name matching [a-z][a-zA-Z0-9]*", name);
    }
    parsed[name] = parseWidth(name, widths[name]);
  }
  const slice = Object.freeze({ widths: Object.freeze(parsed) }) as unknown as ConcurrencySlice;
  registry.add(slice);
  return slice;
}

/**
 * The width to run at. `requested` undefined gives the width's default;
 * otherwise `requested` itself, refused unless it is an integer from 1 to the
 * width's max. A caller's override can narrow or widen within the declared
 * bound, never past it.
 */
export function width(slice: ConcurrencySlice, name: string, requested?: number): number {
  if (!registry.has(slice)) {
    throw new Error(
      `width: expected a ConcurrencySlice built by ${PARSER}() — got an object that parser did not return`,
    );
  }
  const declared = slice.widths[name];
  if (!Object.hasOwn(slice.widths, name) || declared === undefined) {
    throw new Error(
      `width: no width ${q(name)} — declared: ${Object.keys(slice.widths).join(", ")}`,
    );
  }
  if (requested === undefined) return declared.default;
  if (!isIntegerIn(requested, 1, declared.max)) {
    throw new Error(
      `width: ${q(name)} requested ${q(requested)} — must be an integer from 1 to ${declared.max}`,
    );
  }
  return requested;
}
