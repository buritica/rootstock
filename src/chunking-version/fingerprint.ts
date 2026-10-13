/** Thrown by `chunkingParamFingerprint` when `params` cannot be trusted to fingerprint. */
export class InvalidChunkingParamsError extends Error {
  override readonly name = "InvalidChunkingParamsError";
}

/**
 * A deterministic fingerprint of a set of numeric chunking parameters: the
 * SHA-256 hex of `JSON.stringify` over `[key, value]` pairs, walked in the
 * order of `keys`. The order the caller listed properties on `params` does not
 * matter; the order of `keys` does, so a caller fixes one canonical key list
 * and keeps it.
 *
 * Refusals, checked in this order (each throws `InvalidChunkingParamsError`):
 *   1. a key listed more than once in `keys` (all duplicates, sorted);
 *   2. a property on `params` that `keys` does not list (all of them, sorted);
 *   3. walking `keys` in order, the first value that is not a finite number,
 *      which covers NaN, ±Infinity, a missing key (`got undefined`) and a
 *      numeric string (`got 3`). `JSON.stringify` would write NaN and Infinity
 *      as `null`, so two different bad values would otherwise collide.
 *
 * Values serialize the way `JSON.stringify` writes them: `1.0` and `1` agree,
 * `-0` and `0` agree, and `1e21` is written `1e+21`.
 *
 * Synchronous. `keys` is not type-checked to cover every property of
 * `params`; a property it misses is refused at runtime by step 2.
 */
export function chunkingParamFingerprint<const K extends string>(
  keys: readonly K[],
  params: { readonly [P in K]: number },
): string {
  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const key of keys) {
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);
  }
  if (duplicateKeys.size > 0) {
    throw new InvalidChunkingParamsError(
      `duplicate chunking param key(s): ${[...duplicateKeys].sort().join(", ")}`,
    );
  }
  const paramKeys = new Set(Object.keys(params));
  for (const key of keys) {
    paramKeys.delete(key);
  }
  if (paramKeys.size > 0) {
    throw new InvalidChunkingParamsError(
      `unknown chunking param key(s): ${[...paramKeys].sort().join(", ")}`,
    );
  }
  const sortedEntries = keys.map((key) => {
    const value = params[key];
    if (!Number.isFinite(value)) {
      throw new InvalidChunkingParamsError(
        `chunking param "${key}" must be a finite number, got ${value}`,
      );
    }
    return [key, value] as const;
  });
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(sortedEntries)).digest("hex");
}
