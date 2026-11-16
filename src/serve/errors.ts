import { q } from "../internal/slice.ts";

const NO_VALUE: unique symbol = Symbol("no value");

/** A refusal at build time: `ERR_ROOTSTOCK_SERVE_CONFIG`, naming the function and the value. */
export function configError(fn: string, detail: string, value: unknown = NO_VALUE): Error {
  const got = value === NO_VALUE ? "" : ` — got ${q(value)}`;
  return Object.assign(new Error(`rootstock serve: ${fn}(): ${detail}${got}`), {
    code: "ERR_ROOTSTOCK_SERVE_CONFIG",
  });
}

export function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Never throws: an error's class for a log line, never its message. */
export function className(err: unknown): string {
  try {
    if (err instanceof Error) return err.name;
    return "non-Error throw";
  } catch {
    return "unreadable error";
  }
}
