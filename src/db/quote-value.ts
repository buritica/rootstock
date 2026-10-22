/**
 * `JSON.stringify(value)`, the `got …` part of every refusal, except that a
 * value it cannot serialize (a BigInt, a cycle) still yields text, so a bad
 * value reaches the caller as the refusal that names its path.
 */
export function q(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "bigint" ? `${value}n` : "an unserializable value";
  }
}
