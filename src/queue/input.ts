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

/** The UTF-8 byte length of a string, counted without an encoder. */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * §4.3.1: the payload as the JSON text the queue stores. NUL is stripped from
 * strings, a Date becomes its ISO string, a nested null or undefined becomes
 * null; everything else that JSON cannot carry faithfully refuses.
 */
export function serializePayload(
  emit: Emit,
  s: QueueSlice,
  key: string,
  source: string,
  payload: unknown,
): string {
  const fields = { key, source };
  if (payload === null || payload === undefined) return "{}";
  if (typeof payload !== "object" || Array.isArray(payload)) {
    const what = Array.isArray(payload) ? "array" : typeof payload;
    throw refuse(
      emit,
      "payload_not_an_object",
      `payload for ${key} must be an object, not a ${what}`,
      fields,
    );
  }
  const ancestors = new Set<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return null;
    if (typeof node === "string") return node.replaceAll("\0", "");
    if (typeof node === "boolean") return node;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        throw refuse(
          emit,
          "payload_non_finite",
          `payload for ${key} holds a non-finite number at depth ${depth}`,
          fields,
        );
      }
      return node;
    }
    if (typeof node === "object") {
      if (ancestors.has(node)) {
        throw refuse(
          emit,
          "payload_cyclic",
          `payload for ${key} is cyclic at depth ${depth}`,
          fields,
        );
      }
      if (node instanceof Date) return node.toISOString();
      ancestors.add(node);
      try {
        if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1));
        const proto = Object.getPrototypeOf(node);
        if (proto !== Object.prototype && proto !== null) {
          throw refuse(
            emit,
            "payload_non_plain",
            `payload for ${key} holds a non-plain object at depth ${depth}`,
            fields,
          );
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
          if (k.includes("\0")) {
            throw refuse(
              emit,
              "payload_nul_key",
              `payload for ${key} has a NUL byte in a key at depth ${depth}`,
              fields,
            );
          }
          out[k] = walk(v, depth + 1);
        }
        return out;
      } finally {
        ancestors.delete(node);
      }
    }
    throw refuse(
      emit,
      "payload_bad_type",
      `payload for ${key} holds a ${typeof node} at depth ${depth}`,
      fields,
    );
  };
  const json = JSON.stringify(walk(payload, 0));
  const bytes = utf8Bytes(json);
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
