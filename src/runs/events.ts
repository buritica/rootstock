import { pgCode } from "../db/index.ts";
import { safeHook } from "../internal/slice.ts";
import type { RunsErrorCode } from "./errors.ts";

/** The injected dependencies of the run record. `runs` reads no clock of its own. */
export interface RunsDeps {
  /** ms since the epoch. */
  now: () => number;
  /** Lowercased by rootstock. */
  randomUUID: () => string;
  onEvent?: (e: RunsEvent) => void;
}

export type RunStatus = "running" | "ok" | "failed" | "refused" | "interrupted";

/** A proportional brake's answer (contract §6.1). */
export interface BrakeJudgement {
  planned: number;
  held: number;
  armed: boolean;
  cap: number | null;
  wouldRefuse: boolean;
  allowed: boolean;
  overridden: boolean;
}

/** The scope guard's answer (contract §6.3). */
export interface ScopeJudgement {
  baseline: "none" | "compared";
  lost: readonly string[];
  newlyExcluded: readonly string[];
  wouldRefuse: boolean;
  allowed: boolean;
}

type Err = { error: unknown; code: string | undefined };

/**
 * What `runs` reports (contract §0.6). No event carries a quarantine payload,
 * a scope value or a price. Two stated exceptions carry the thrown error
 * itself: `runs.record_failed` (the record names only its job) and
 * `runs.after_run_failed` (the hook is the consumer's own code).
 */
export type RunsEvent =
  | { type: "runs.refused"; job: string; code: RunsErrorCode }
  | { type: "runs.settled_interrupted"; id: string; job: string; by: string }
  | {
      type: "runs.started";
      id: string;
      job: string;
      mode: string;
      lockName: string;
      settled: number;
    }
  | ({ type: "runs.record_failed"; id: string; job: string; operation: "finish" | "discard" } & Err)
  | ({
      type: "runs.record_failed";
      job: string;
      externalId: string;
      operation: "quarantine";
    } & Err)
  | { type: "runs.settled_elsewhere"; id: string; job: string }
  | {
      type: "runs.finished";
      id: string;
      job: string;
      status: Exclude<RunStatus, "running">;
      reconciled: boolean | null;
      costUsd: string | null;
      costNote: string | null;
    }
  | {
      type: "runs.identity_failed";
      id: string;
      job: string;
      listed: number | null;
      accounted: number | null;
    }
  | { type: "runs.discarded"; id: string; job: string }
  | { type: "runs.after_run_failed"; id: string; job: string; error: unknown }
  | { type: "runs.pruned"; deleted: number }
  /** `truncated`: quarantineSafe's fallback landed instead of the real payload (§20 A4). */
  | {
      type: "runs.quarantined";
      job: string;
      externalId: string;
      runId: string | null;
      truncated: boolean;
    }
  | { type: "runs.resolved"; job: string; count: number }
  | { type: "runs.brake_refused"; brake: string; planned: number; held: number; cap: number | null }
  | {
      type: "runs.brake_overridden";
      brake: string;
      planned: number;
      held: number;
      cap: number | null;
    }
  | { type: "runs.budget_refused"; budget: string; planned: number; remaining: number }
  | { type: "runs.scope_refused"; job: string; kind: "baseline" | "shrink" | "exclusion" }
  | {
      type: "runs.scope_checked";
      job: string;
      baseline: "none" | "compared";
      lost: number;
      newlyExcluded: number;
    }
  | { type: "runs.breaker_tripped"; breaker: string; count: number };

export type Emit = (e: RunsEvent) => void;

/** The hook, made safe: one that throws or rejects is ignored, so it can never change what runs does. */
export function emitter(onEvent: ((e: RunsEvent) => void) | undefined): Emit {
  return (e) => safeHook(onEvent, e);
}

/** `{ error, code }` for a failure event: the driver's error and its SQLSTATE, if any. */
export function failure(error: unknown): Err {
  return { error, code: pgCode(error) };
}
