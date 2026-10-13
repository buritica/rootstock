import { createHash } from "node:crypto";

/** Marks a slug derived from a digest rather than from the name's own letters. */
const FALLBACK_SLUG_PREFIX = "x-";
const FALLBACK_HASH_CHARS = 12;
/**
 * Fewer surviving characters than this make a weak key, but only when the ASCII
 * strip dropped characters; a one-letter Latin name keeps its readable slug.
 */
const MIN_SLUG_CHARS = 2;

function fallbackSlug(normalized: string): string {
  const digest = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, FALLBACK_HASH_CHARS);
  return `${FALLBACK_SLUG_PREFIX}${digest}`;
}

/**
 * Lowercase ASCII slug of the folded name: `[a-z0-9]` runs joined by single
 * hyphens. When the strip leaves nothing, or leaves one character after dropping
 * others, the slug is `x-` plus the first 12 hex digits of the SHA-256 of the
 * folded name's UTF-8 bytes (a lone surrogate encodes as U+FFFD).
 */
function slugify(name: string): string {
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  const ascii = normalized
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const droppedCharacters = ascii.length < normalized.replace(/\s+/g, "").length;
  if (ascii === "" || (ascii.length < MIN_SLUG_CHARS && droppedCharacters)) {
    return fallbackSlug(normalized);
  }
  return ascii;
}

/** Profile `slugify/mycel-v1`. Immutable; a behavior change ships as a new profile. */
export const mycelV1: {
  readonly id: "mycel-v1";
  readonly slugify: (name: string) => string;
} = Object.freeze({ id: "mycel-v1", slugify });
