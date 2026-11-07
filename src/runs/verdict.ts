import { own, q } from "../internal/slice.ts";
import { refusals } from "./errors.ts";
import type { RunStatus } from "./events.ts";
import type { JobSnapshot, RunRow } from "./record.ts";
import type { JobDecl } from "./slice.ts";

export type Verdict =
  | { verdict: "never-ran" }
  | { verdict: "never-succeeded"; lastStatus: RunStatus; lastAt: Date }
  | { verdict: "stale"; ageHours: number; maxAgeHours: number }
  | { verdict: "interrupted"; at: Date; graceHours: number }
  | { verdict: "archival-spike"; archived: number; live: number; share: number }
  | { verdict: "ok"; ageHours: number | null };

export type PushVerdict =
  | { verdict: "off" }
  | { verdict: "never-ran" }
  | { verdict: "stale"; ageHours: number; maxAgeHours: number }
  | { verdict: "ok"; ageHours: number };

const HOUR_MS = 3_600_000;

function nowOf(fn: string, now: unknown): number {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw refusals.input(`${fn}: now must be a finite number of ms — got ${q(now)}`);
  }
  return now;
}

/** Hours from `at` to `now`, unrounded; null when there is no `at`. */
const ageHoursOf = (now: number, at: Date | null): number | null =>
  at === null ? null : (now - at.getTime()) / HOUR_MS;

/** A settled row as the verdict reads it: its status, start and settle time. */
interface Settled {
  status: RunStatus;
  startedAt: Date;
  /** When it was settled; for a stale running row, its fence's last beat. */
  at: Date | null;
}

/**
 * The newest settled row, where a running row whose fence has not beaten for
 * over `staleHeartbeatSeconds` counts as settled `interrupted` at its last
 * beat (§20 A9): a black-holed holder reads live until its socket dies.
 */
function newestSettledOf(snap: JobSnapshot, job: JobDecl, now: number): Settled | null {
  const settled: Settled | null =
    snap.newestSettled === null
      ? null
      : {
          status: snap.newestSettled.status,
          startedAt: snap.newestSettled.startedAt,
          at: snap.newestSettled.finishedAt,
        };
  const staleMs = job.staleHeartbeatSeconds * 1000;
  let out = settled;
  for (const r of snap.running) {
    const beat = r.heartbeatAt ?? null;
    if (beat === null || now - beat.getTime() <= staleMs) continue;
    if (out === null || r.startedAt.getTime() > out.startedAt.getTime()) {
      out = { status: "interrupted", startedAt: r.startedAt, at: beat };
    }
  }
  return out;
}

/**
 * A job's freshness (contract §5), first match wins: never-ran,
 * never-succeeded, stale, interrupted, archival-spike, ok. Pure: ages use the
 * injected `now`, never a clock.
 */
export function verdictFor(
  snap: JobSnapshot,
  job: JobDecl,
  input: { now: number; live?: number },
): Verdict {
  const now = nowOf("verdictFor()", input?.now);
  const settled = newestSettledOf(snap, job, now);
  if (settled === null) return { verdict: "never-ran" };
  const ok: RunRow | null = snap.newestOk;
  if (ok === null) {
    return {
      verdict: "never-succeeded",
      lastStatus: settled.status,
      lastAt: settled.at ?? settled.startedAt,
    };
  }
  const ageHours = ageHoursOf(now, ok.finishedAt);
  if (job.maxAgeHours !== null && ageHours !== null && ageHours > job.maxAgeHours) {
    return { verdict: "stale", ageHours, maxAgeHours: job.maxAgeHours };
  }
  if (settled.status === "interrupted" && settled.startedAt.getTime() > ok.startedAt.getTime()) {
    const graceHours = job.interruptedGraceHours ?? 0;
    // Without a settle time the grace cannot be measured, so it counts as past.
    const past =
      job.maxAgeHours === null ||
      settled.at === null ||
      now - settled.at.getTime() > graceHours * HOUR_MS;
    if (past) return { verdict: "interrupted", at: settled.at ?? settled.startedAt, graceHours };
  }
  const counter = job.counters.archived;
  if (counter !== undefined && job.spike !== null) {
    const live = input.live;
    if (live === undefined) {
      throw refusals.input(
        `verdictFor(${ok.job}): live is required when the job declares an archived counter`,
        ok.job,
      );
    }
    if (!Number.isInteger(live) || live < 0) {
      throw refusals.input(
        `verdictFor(${ok.job}): live must be a non-negative integer — got ${q(live)}`,
        ok.job,
      );
    }
    const archived = own(ok.counts, counter) ?? 0;
    const total = live + archived;
    const share = total === 0 ? 0 : archived / total;
    if (archived > job.spike.allowance && share > job.spike.share) {
      return { verdict: "archival-spike", archived, live, share };
    }
  }
  return { verdict: "ok", ageHours };
}

/**
 * A push line's freshness (contract §5): off, never-ran, stale or ok, from
 * the newest ok row only. Interrupted and failed rows never make it red.
 */
export function pushVerdictFor(
  snap: JobSnapshot,
  job: JobDecl,
  input: { now: number; enabled: boolean },
): PushVerdict {
  if (job.push === null) {
    throw refusals.input(`pushVerdictFor(${job.key}): the job declares no push`);
  }
  const now = nowOf("pushVerdictFor()", input?.now);
  if (input.enabled !== true) return { verdict: "off" };
  const ok = snap.newestOk;
  if (ok === null) return { verdict: "never-ran" };
  const ageHours = (now - (ok.finishedAt ?? ok.startedAt).getTime()) / HOUR_MS;
  if (ageHours > job.push.maxAgeHours) {
    return { verdict: "stale", ageHours, maxAgeHours: job.push.maxAgeHours };
  }
  return { verdict: "ok", ageHours };
}
