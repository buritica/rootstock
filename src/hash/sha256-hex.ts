/**
 * SHA-256 of `data` as 64 lowercase hex characters.
 *
 * A string is hashed as its UTF-8 bytes, with no Unicode normalization: NFC and
 * NFD spellings of the same text produce different digests. A lone surrogate
 * encodes as U+FFFD, so `"\uD800"` and `"\uFFFD"` hash the same. A `Uint8Array`
 * is hashed as exactly the bytes it views, so a `subarray` hashes only its
 * window. Inputs other than `string | Uint8Array` are unspecified.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}
