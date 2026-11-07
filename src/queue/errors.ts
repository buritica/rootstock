export type QueueErrorCode = "ERR_ROOTSTOCK_QUEUE_INPUT" | "ERR_ROOTSTOCK_QUEUE_NOTABLE";

export type QueueRefusalReason =
  | "key_invalid"
  | "source_unknown"
  | "kind_unknown"
  | "key_source_mismatch"
  | "worker_invalid"
  | "debounce_not_finite"
  | "max_slide_not_finite"
  | "payload_not_an_object"
  | "payload_non_finite"
  | "payload_cyclic"
  | "payload_non_plain"
  | "payload_nul_key"
  | "payload_bad_type"
  | "payload_too_large"
  | "cursor_name_invalid"
  | "cursor_value_invalid"
  | "error_class_invalid";

const CODES: ReadonlySet<string> = new Set([
  "ERR_ROOTSTOCK_QUEUE_INPUT",
  "ERR_ROOTSTOCK_QUEUE_NOTABLE",
]);

export class RootstockQueueError extends Error {
  readonly code: QueueErrorCode;
  /** INPUT only. */
  readonly reason?: QueueRefusalReason;
  /** The text after "rootstock queue: ". */
  readonly detail: string;
  /** NOTABLE: "<schema>.<name>". */
  readonly table?: string;

  constructor(
    code: QueueErrorCode,
    detail: string,
    extras: { reason?: QueueRefusalReason; table?: string; cause?: unknown } = {},
  ) {
    super(
      `rootstock queue: ${detail}`,
      extras.cause === undefined ? undefined : { cause: extras.cause },
    );
    this.name = "RootstockQueueError";
    this.code = code;
    this.detail = detail;
    if (extras.reason !== undefined) this.reason = extras.reason;
    if (extras.table !== undefined) this.table = extras.table;
  }
}

/** The code of a queue refusal, by `code` (survives two module copies), or undefined. */
export function queueErrorCode(err: unknown): QueueErrorCode | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && CODES.has(code) ? (code as QueueErrorCode) : undefined;
}

/** The NOTABLE refusal for a missing table, with the server's error as cause. */
export function notable(
  table: { schema: string; name: string },
  cause: unknown,
): RootstockQueueError {
  const t = `${table.schema}.${table.name}`;
  return new RootstockQueueError(
    "ERR_ROOTSTOCK_QUEUE_NOTABLE",
    `${t} does not exist — run the migrations (the table ships with rootstock 0.6.0, or is your own)`,
    { table: t, cause },
  );
}
