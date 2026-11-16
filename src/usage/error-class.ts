import { pgCode } from "../db/index.ts";

/**
 * The classes rootstock itself writes into a call record's `errorClass`.
 * Everything else comes from `errorClassOf` on what a tool threw.
 */
export const CALL_ERROR_CLASSES = Object.freeze([
  "UnknownTool",
  "InvalidParams",
  "RejectedBeforeHandler",
  "TurnBudgetExhausted",
  "DeadlineExceeded",
  "RateLimited",
  "Busy",
  "ScopeDenied",
] as const);
export type CallErrorClass = (typeof CALL_ERROR_CLASSES)[number];

/** A driver's own error code: postgres.js says `CONNECTION_ENDED`, node says `ECONNRESET`. */
const DRIVER_CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,40}$/;
const CAUSE_DEPTH = 5;

/**
 * A class name, SQLSTATE or driver code for a thrown value, never its
 * message (a message can carry query parameters or third-party text).
 * `classify` answers first, for an error the consumer names itself (a class
 * that sets no `name`, say); then the SQLSTATE anywhere in the cause chain;
 * then, walking `cause` at most 5 deep, the first driver code or class name
 * other than plain "Error" (a query wrapper often sets no name and hangs the
 * driver's error on `cause`); then "Error" or "non-Error throw". Never
 * throws: a throwing accessor or `classify` reads "unreadable error".
 */
export function errorClassOf(
  err: unknown,
  classify?: (err: unknown) => string | undefined,
): string {
  try {
    const named = classify?.(err);
    if (typeof named === "string" && named !== "") return named;
    const sqlstate = pgCode(err);
    if (sqlstate) return sqlstate;
    let current: unknown = err;
    for (let hop = 0; hop < CAUSE_DEPTH; hop += 1) {
      if (!(current instanceof Error)) break;
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && DRIVER_CODE_SHAPE.test(code)) return code;
      if (current.name !== "Error") return current.name;
      current = current.cause;
    }
    return err instanceof Error ? "Error" : "non-Error throw";
  } catch {
    return "unreadable error";
  }
}
