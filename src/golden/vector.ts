import { createHash } from "node:crypto";

/**
 * A deterministic pseudo-embedding for synthetic search fixtures: the same
 * `seed` gives the same unit vector on every machine. Built from a sha256
 * counter stream and integer arithmetic, so it does not depend on
 * `Math.random` or platform float quirks beyond IEEE `sqrt`.
 *
 * `near(seed, base, similarity)` mixes a seed's vector toward `base` so
 * fixtures can place documents at controlled cosine distances from a query.
 */
export function seededVector(seed: string, dims: number): number[] {
  if (!Number.isInteger(dims) || dims < 1) {
    throw new RangeError(`seededVector: dims must be a positive integer`);
  }
  const values: number[] = [];
  for (let block = 0; values.length < dims; block++) {
    const digest = createHash("sha256").update(`${seed}:${block}`).digest();
    for (let i = 0; i + 4 <= digest.length && values.length < dims; i += 4) {
      const u = digest.readUInt32BE(i);
      values.push(u / 0x80000000 - 1);
    }
  }
  return normalize(values);
}

export function nearVector(seed: string, base: number[], weight: number): number[] {
  if (!(weight >= 0 && weight <= 1)) {
    throw new RangeError(`nearVector: weight must be within [0, 1]`);
  }
  const noise = seededVector(seed, base.length);
  return normalize(base.map((b, i) => weight * b + (1 - weight) * (noise[i] ?? 0)));
}

function normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) throw new RangeError("normalize: zero vector");
  return values.map((v) => v / norm);
}
