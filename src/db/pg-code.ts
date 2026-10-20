const CAUSE_DEPTH = 5;
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/**
 * First SQLSTATE-shaped `code` or `errno` on err's cause chain (depth 5); never
 * throws. A walk, not `err.code`, because a query builder wraps the driver's
 * error and leaves the SQLSTATE on its cause. `errno` is checked at each hop
 * because `Bun.SQL` puts the SQLSTATE there and sets `code` to
 * `"ERR_POSTGRES_SERVER_ERROR"`. A `code` and an `errno` on one hop: `code` wins.
 */
export function pgCode(err: unknown): string | undefined {
  // try/catch because .code/.cause can be throwing accessors on hostile or
  // proxied error objects; inspection must never throw, or the inspector
  // becomes a second failure.
  try {
    let current: unknown = err;
    for (let hop = 0; hop < CAUSE_DEPTH; hop += 1) {
      if (typeof current !== "object" || current === null) return undefined;
      const { code, errno, cause } = current as {
        code?: unknown;
        errno?: unknown;
        cause?: unknown;
      };
      if (typeof code === "string" && SQLSTATE_SHAPE.test(code)) return code;
      if (typeof errno === "string" && SQLSTATE_SHAPE.test(errno)) return errno;
      if (cause === undefined || cause === current) return undefined;
      current = cause;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
