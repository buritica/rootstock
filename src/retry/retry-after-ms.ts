/**
 * Milliseconds to wait from a `Retry-After` header: the server's seconds,
 * capped at `bounds.capMs`; `bounds.defaultMs` when the header is absent,
 * unparsable (the HTTP-date form is legal and is treated as unparsable),
 * zero or negative. Retrying instantly into a limiter that just said no is
 * how a bounded retry burns its budget in one event-loop tick.
 *
 * Both bounds are policy and belong to the caller: they differ per API.
 */
export function retryAfterMs(
  header: string | null,
  bounds: { readonly defaultMs: number; readonly capMs: number },
): number {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds <= 0) {
    return bounds.defaultMs;
  }
  return Math.min(seconds * 1000, bounds.capMs);
}
