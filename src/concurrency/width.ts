import { type Brand, isRecord, own, q, sliceBrand, sliceRefusals } from "../internal/slice.ts";

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
const SLICE_KEYS: ReadonlySet<string> = new Set(["widths"]);
const WIDTH_KEYS: ReadonlySet<string> = new Set(["default", "max"]);

const refuse = sliceRefusals(PARSER);
const brand: Brand<ConcurrencySlice> = sliceBrand("ConcurrencySlice", PARSER);

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function parseWidth(name: string, entry: unknown): Readonly<WidthInput> {
  const path = `widths.${name}`;
  const fields = refuse.record(path, entry);
  refuse.refuseUnknownKeys(fields, WIDTH_KEYS, `${path}.`);
  const def = own(fields, "default");
  const max = own(fields, "max");
  if (def === undefined) throw refuse.required(`${path}.default`);
  if (max === undefined) throw refuse.required(`${path}.max`);
  if (!isIntegerIn(max, 1, MAX_WIDTH)) {
    throw refuse.invalid(`${path}.max`, `an integer from 1 to ${MAX_WIDTH}`, max);
  }
  if (!isIntegerIn(def, 1, max)) {
    throw refuse.invalid(`${path}.default`, "an integer >= 1 and <= max", def);
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
  refuse.refuseUnknownKeys(fields, SLICE_KEYS, "");
  const widths = own(fields, "widths");
  if (widths === undefined) throw refuse.required("widths");
  if (!isRecord(widths) || Object.keys(widths).length === 0) {
    throw refuse.invalid("widths", "an object with at least one width", widths);
  }
  // No prototype, so a name like "constructor" is never found on a slice that
  // did not declare it, by `width()` or by any other reader.
  const parsed: Record<string, Readonly<WidthInput>> = Object.create(null);
  for (const name of Object.keys(widths)) {
    if (!NAME.test(name)) {
      throw refuse.invalid(`widths.${name}`, "a name matching [a-z][a-zA-Z0-9]*", name);
    }
    parsed[name] = parseWidth(name, widths[name]);
  }
  return brand.mark(
    Object.freeze({ widths: Object.freeze(parsed) }) as unknown as ConcurrencySlice,
  );
}

/**
 * The width to run at. `requested` undefined gives the width's default;
 * otherwise `requested` itself, refused unless it is an integer from 1 to the
 * width's max. A caller's override can narrow or widen within the declared
 * bound, never past it.
 */
export function width(slice: ConcurrencySlice, name: string, requested?: number): number {
  brand.assert("width", slice);
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
