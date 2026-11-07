import { q } from "../internal/slice.ts";
import { type QueueRefusalReason, RootstockQueueError } from "./errors.ts";
import type { Emit } from "./events.ts";
import type { QueueSlice } from "./slice.ts";

interface Fields {
  key?: string | null;
  source?: string | null;
  size?: number;
}

/** Emits `queue.refused`, then returns the INPUT error to throw. */
export function refuse(
  emit: Emit,
  reason: QueueRefusalReason,
  detail: string,
  fields: Fields = {},
): RootstockQueueError {
  emit({
    type: "queue.refused",
    key: fields.key ?? null,
    source: fields.source ?? null,
    reason,
    ...(fields.size === undefined ? {} : { size: fields.size }),
  });
  return new RootstockQueueError("ERR_ROOTSTOCK_QUEUE_INPUT", detail, { reason });
}

/** The detail and size of a bad text, or undefined when it passes (§4.3's three checks, in order). */
export function textProblem(
  value: unknown,
  max: number,
  what: string,
): { detail: string; size?: number } | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return { detail: `${what} must be a non-empty string` };
  }
  if (value.length > max) {
    return {
      detail: `${what} is ${value.length} characters, over the ${max} cap`,
      size: value.length,
    };
  }
  if (value.includes("\0")) return { detail: `${what} contains a NUL byte` };
  // A lone surrogate reaches a text column as U+FFFD, so the stored key would
  // not be the one given (and ack would never find it).
  if (!value.isWellFormed()) return { detail: `${what} contains a lone UTF-16 surrogate` };
  return undefined;
}

/** `text(value, max, what, reason)`: the string, or the refusal (with `fields`). */
export function text(
  emit: Emit,
  value: unknown,
  max: number,
  what: string,
  reason: QueueRefusalReason,
  fields: Fields = {},
): string {
  const problem = textProblem(value, max, what);
  if (problem !== undefined) {
    throw refuse(emit, reason, problem.detail, { ...fields, size: problem.size });
  }
  return value as string;
}

// Pure: an encoder reads no clock and does no I/O.
const UTF8 = new TextEncoder();

/** What the JSON walk found wrong, and how deep. */
export type JsonProblem =
  | "non_finite"
  | "invalid_date"
  | "cyclic"
  | "non_plain"
  | "nul_key"
  | "surrogate_key"
  | "surrogate_string"
  | "nul_string"
  | "undefined"
  | "bad_type";

/**
 * §4.3.1's walk: `root` as a value `JSON.stringify` carries faithfully, or a
 * call to `bad` (which throws). It tracks ancestors, so a shared sub-object is
 * fine and a cycle is not. A Date becomes its ISO string. A string or key
 * holding a lone UTF-16 surrogate is refused: JSON.stringify would escape it
 * and the server rejects that escape (22P02), and a text column would store
 * U+FFFD in its place. `strict` (a cursor value) refuses a NUL in a string and
 * a nested `undefined`; otherwise (a payload) NUL is stripped and a nested
 * `undefined` becomes null.
 */
export function jsonValue(
  root: unknown,
  strict: boolean,
  bad: (problem: JsonProblem, depth: number, node: unknown) => never,
): unknown {
  const ancestors = new Set<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null) return null;
    if (node === undefined) return strict ? bad("undefined", depth, node) : null;
    if (typeof node === "string") {
      if (!node.isWellFormed()) return bad("surrogate_string", depth, node);
      if (!node.includes("\0")) return node;
      return strict ? bad("nul_string", depth, node) : node.replaceAll("\0", "");
    }
    if (typeof node === "boolean") return node;
    if (typeof node === "number") {
      return Number.isFinite(node) ? node : bad("non_finite", depth, node);
    }
    if (typeof node === "object") {
      if (ancestors.has(node)) return bad("cyclic", depth, node);
      if (node instanceof Date) {
        return Number.isNaN(node.getTime()) ? bad("invalid_date", depth, node) : node.toISOString();
      }
      ancestors.add(node);
      try {
        // Array.from visits holes too, as undefined: JSON would write null.
        if (Array.isArray(node)) return Array.from(node, (v) => walk(v, depth + 1));
        const proto = Object.getPrototypeOf(node);
        if (proto !== Object.prototype && proto !== null) return bad("non_plain", depth, node);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          if (k.includes("\0")) return bad("nul_key", depth, node);
          if (!k.isWellFormed()) return bad("surrogate_key", depth, node);
          out[k] = walk(v, depth + 1);
        }
        return out;
      } finally {
        ancestors.delete(node);
      }
    }
    return bad("bad_type", depth, node);
  };
  return walk(root, 0);
}

/** §4.3.1's reason and detail per problem; any other is `payload_bad_type`, naming its typeof. */
const PAYLOAD_PROBLEMS: Partial<Record<JsonProblem, [QueueRefusalReason, string]>> = {
  non_finite: ["payload_non_finite", "holds a non-finite number"],
  invalid_date: ["payload_non_finite", "holds an invalid Date"],
  cyclic: ["payload_cyclic", "is cyclic"],
  non_plain: ["payload_non_plain", "holds a non-plain object"],
  nul_key: ["payload_nul_key", "has a NUL byte in a key"],
  surrogate_key: ["payload_bad_type", "has a lone surrogate in a key"],
  surrogate_string: ["payload_bad_type", "holds a string with a lone surrogate"],
};

/**
 * §4.3.1: the payload as the JSON text the queue stores. NUL is stripped from
 * strings, a Date becomes its ISO string, a nested null or undefined becomes
 * null; everything else that JSON cannot carry faithfully refuses.
 */
function serializePayload(
  emit: Emit,
  s: QueueSlice,
  key: string,
  source: string,
  payload: unknown,
): string {
  const fields = { key, source };
  if (payload === null || payload === undefined) return "{}";
  if (typeof payload !== "object" || Array.isArray(payload) || payload instanceof Date) {
    const what = Array.isArray(payload)
      ? "array"
      : payload instanceof Date
        ? "Date"
        : typeof payload;
    throw refuse(
      emit,
      "payload_not_an_object",
      `payload for ${key} must be an object, not a ${what}`,
      fields,
    );
  }
  const bad = (problem: JsonProblem, depth: number, node: unknown): never => {
    const [reason, what] = PAYLOAD_PROBLEMS[problem] ?? [
      "payload_bad_type",
      `holds a ${typeof node}`,
    ];
    throw refuse(emit, reason, `payload for ${key} ${what} at depth ${depth}`, fields);
  };
  const json = JSON.stringify(jsonValue(payload, false, bad));
  const bytes = UTF8.encode(json).length;
  if (bytes > s.maxPayloadBytes) {
    throw refuse(
      emit,
      "payload_too_large",
      `payload for ${key} is ${bytes} bytes, over the ${s.maxPayloadBytes} cap — a queue row points at work, it does not carry the source`,
      { ...fields, size: bytes },
    );
  }
  return json;
}

export interface EnqueueArgs {
  key: string;
  source: string;
  kind: string;
  payload: unknown;
  debounceSeconds: number;
  /** Default maxDebounceSlideMinutes * 60. */
  maxSlideSeconds?: number;
}

export interface CheckedEnqueue {
  key: string;
  source: string;
  kind: string;
  json: string;
  debounce: number;
  slide: number;
}

/** §4.3's enqueue checks and clamps, in exactly the frozen order. */
export function checkEnqueue(emit: Emit, s: QueueSlice, a: EnqueueArgs): CheckedEnqueue {
  const key = text(emit, a.key, s.maxKeyChars, "key", "key_invalid");
  const { source, kind } = a;
  if (typeof source !== "string" || !s.sources.includes(source)) {
    throw refuse(emit, "source_unknown", `${q(source)} is not a queue source`, { key });
  }
  if (typeof kind !== "string" || !s.kinds.includes(kind)) {
    throw refuse(emit, "kind_unknown", `${q(kind)} is not a queue kind`, { key, source });
  }
  const fields = { key, source };
  if (!key.startsWith(`${source}:`)) {
    throw refuse(
      emit,
      "key_source_mismatch",
      `key ${q(key)} does not start with its source (${source}:)`,
      fields,
    );
  }
  if (typeof a.debounceSeconds !== "number" || !Number.isFinite(a.debounceSeconds)) {
    throw refuse(
      emit,
      "debounce_not_finite",
      `debounceSeconds for ${key} is not a finite number`,
      fields,
    );
  }
  const debounce = Math.min(Math.max(Math.trunc(a.debounceSeconds), 0), s.maxDebounceSeconds);
  const json = serializePayload(emit, s, key, source, a.payload);
  const ceiling = s.maxDebounceSlideMinutes * 60;
  const given = a.maxSlideSeconds;
  if (given !== undefined && (typeof given !== "number" || !Number.isFinite(given))) {
    throw refuse(
      emit,
      "max_slide_not_finite",
      `maxSlideSeconds for ${key} is not a finite number`,
      fields,
    );
  }
  const slide = Math.min(Math.max(Math.trunc(given ?? ceiling), 0), ceiling);
  return { key, source, kind, json, debounce, slide };
}

/** A limit clamped to 1..maxClaimLimit; a non-finite one reads as `fallback`. */
export function clampLimit(limit: unknown, max: number, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|-?[1-9][0-9]*)$/;
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

export interface Claim {
  token: string;
  version: string;
}

const isBigintText = (v: unknown): v is string =>
  typeof v === "string" && DECIMAL.test(v) && BigInt(v) >= BIGINT_MIN && BigInt(v) <= BIGINT_MAX;

/**
 * §9.2: the claim a row was taken with, as `claim` returned it: a uuid token
 * and a bigint version as decimal text. Anything else refuses `claim_invalid`
 * before a statement is sent.
 */
export function checkClaim(emit: Emit, key: unknown, claim: unknown): Claim {
  const c = typeof claim === "object" && claim !== null ? (claim as Record<string, unknown>) : {};
  const { token, version } = c;
  if (typeof token !== "string" || !UUID.test(token) || !isBigintText(version)) {
    throw refuse(
      emit,
      "claim_invalid",
      "claim must be { token: a uuid, version: a decimal integer as text }, as claim returned it",
      { key: typeof key === "string" ? key : null },
    );
  }
  return { token, version };
}
