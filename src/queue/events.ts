import { safeHook } from "../internal/slice.ts";
import type { QueueRefusalReason } from "./errors.ts";

/** What the queue reports. No event carries a payload. */
export type QueueEvent =
  | {
      type: "queue.refused";
      key: string | null;
      source: string | null;
      reason: QueueRefusalReason;
      size?: number;
    }
  | { type: "queue.contended"; key: string; source: string; kind: string }
  | {
      type: "queue.enqueued";
      key: string;
      source: string;
      kind: string;
      debounceSeconds: number;
      result: "inserted" | "coalesced" | "on_dead";
    }
  | {
      type: "queue.claimed";
      key: string;
      source: string;
      kind: string;
      attempts: number;
      worker: string;
    }
  | {
      type: "queue.reclaimed";
      key: string;
      source: string;
      kind: string;
      attempts: number;
      worker: string;
      from: string;
    }
  | {
      type: "queue.dead";
      key: string;
      source: string;
      kind: string;
      attempts: number;
      worker: string;
      error: string;
    }
  | {
      type: "queue.drained";
      source: string;
      worker: string;
      limit: number;
      claimed: number;
      deadLettered: number;
    }
  | {
      type: "queue.acked";
      key: string;
      source: string;
      kind: string;
      worker: string;
      result: "deleted" | "released";
      enqueuedAt: string | null;
      queuedMs: number | null;
    }
  | {
      type: "queue.failed";
      key: string;
      source: string;
      kind: string;
      worker: string;
      attempts: number;
      error: string;
    }
  | {
      type: "queue.lost";
      key: string;
      worker: string;
      operation: "ack" | "fail" | "extend";
      error?: string;
    }
  | {
      type: "queue.ack_contended";
      key: string;
      worker: string;
      operation: "ack" | "fail" | "extend";
    }
  | { type: "queue.claim_extended"; key: string; worker: string }
  | { type: "queue.retried"; key: string; source: string; kind: string }
  | { type: "queue.retry_noop"; key: string }
  | { type: "queue.cursor_read"; name: string; value: unknown }
  | { type: "queue.cursor_written"; name: string; from: unknown; to: unknown };

export interface QueueHooks {
  onEvent?: (e: QueueEvent) => void;
}

export type Emit = (e: QueueEvent) => void;

/** The hook, made safe: one that throws or rejects is ignored, so it can never change what the queue does. */
export function emitter(hooks: QueueHooks | undefined): Emit {
  const onEvent = hooks?.onEvent;
  return (e) => safeHook(onEvent, e);
}
