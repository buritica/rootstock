import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no
 * `undefined` in arrays, finite numbers only. Hand-serialized because
 * `JSON.stringify` follows insertion order, and JS objects always put
 * integer-like keys ("1", "10") first — so sorting an object before
 * stringifying it is not enough.
 *
 * Accepted: null, boolean, finite number, string, Date (as its ISO string),
 * arrays, and plain objects. Anything else throws with the path to it, so a
 * golden never silently records `{}` for a Map or `null` for a NaN.
 */
export function canonicalJson(value: unknown, indent = 0): string {
  return serialize(value, "$", indent, 0);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function serialize(value: unknown, path: string, indent: number, depth: number): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`canonicalJson: invalid Date at ${path}`);
    }
    return JSON.stringify(value.toISOString());
  }

  const pad = indent > 0 ? `\n${" ".repeat(indent * (depth + 1))}` : "";
  const close = indent > 0 ? `\n${" ".repeat(indent * depth)}` : "";
  const colon = indent > 0 ? ": " : ":";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item, i) => {
      if (item === undefined) {
        throw new TypeError(`canonicalJson: undefined at ${path}[${i}]`);
      }
      return serialize(item, `${path}[${i}]`, indent, depth + 1);
    });
    return `[${pad}${items.join(`,${pad}`)}${close}]`;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as object).constructor?.name ?? "unknown";
    throw new TypeError(`canonicalJson: unsupported ${name} at ${path}`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  if (keys.length === 0) return "{}";
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}${colon}${serialize(record[k], `${path}.${k}`, indent, depth + 1)}`,
  );
  return `{${pad}${entries.join(`,${pad}`)}${close}}`;
}
