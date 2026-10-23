/** The text of a thrown value, for a refusal that names its cause. */
export function reason(err: unknown): string {
  let text = err instanceof Error ? err.message : String(err);
  // A shell error (Bun.$) keeps git's own words in stderr, not in its message.
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const said = stderr instanceof Uint8Array ? new TextDecoder().decode(stderr) : stderr;
  if (typeof said === "string" && said.trim() !== "") text = `${text}: ${said.trim()}`;
  // Never print credentials a remote URL may carry.
  return text.replace(/\/\/[^/@\s]+@/g, "//***@");
}

/**
 * Throws a migrate refusal. Every one starts `rootstock migrate: ` and carries
 * a `code`, so a caller never branches on text: ERR_ROOTSTOCK_MIG_IO when a
 * file or folder could not be read (the cause is kept, and re-running may
 * help), ERR_ROOTSTOCK_MIG_SRC when what was read or passed is wrong (a commit
 * or a config change is the fix), or the refusal's own code.
 */
export function fail(message: string, code = "ERR_ROOTSTOCK_MIG_SRC", cause?: unknown): never {
  const err = new Error(`rootstock migrate: ${message}`, cause === undefined ? {} : { cause });
  throw Object.assign(err, { code });
}

export function failIo(message: string, cause: unknown): never {
  fail(`${message} — ${reason(cause)}`, "ERR_ROOTSTOCK_MIG_IO", cause);
}
