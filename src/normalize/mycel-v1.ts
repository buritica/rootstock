/**
 * Name folding for `normalize.name/mycel-v1`: canonical decomposition, combining
 * marks U+0300 to U+036F removed, lowercased, trimmed, whitespace runs collapsed to
 * one space. Output stays decomposed; other scripts and code units pass through.
 */
function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Profile `normalize.name/mycel-v1`. Immutable; a behavior change ships as a new profile. */
export const mycelV1: {
  readonly id: "mycel-v1";
  readonly normalizeName: (name: string) => string;
} = Object.freeze({ id: "mycel-v1", normalizeName });
