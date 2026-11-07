import { describe, expect, test } from "bun:test";
import type { RootstockRunsError } from "./errors.ts";
import type { RunStatus } from "./events.ts";
import { runsInput } from "./fixtures.test-support.ts";
import type { JobSnapshot, RunningRow, RunRow } from "./record.ts";
import { jobDecl, runsSlice } from "./slice.ts";
import { pushVerdictFor, verdictFor } from "./verdict.ts";

// R-D5 (contract §5, §13.5): freshness verdicts, pure, against an injected now.

const SLICE = runsSlice(runsInput());
const ALPHA = jobDecl(SLICE, "alpha-sync"); // maxAge 24 h, grace 2 h, archived spike {0.1, 50}, stale beat 120 s
const BETA = jobDecl(SLICE, "beta-sync"); // manual
const GAMMA = jobDecl(SLICE, "gamma-push"); // push maxAge 6 h
const H = 3_600_000;
const NOW = 1_800_000_000_000;

let seq = 0;
/** A row that started `startedH` hours before NOW and settled `finishedH` hours before it. */
function row(
  status: RunStatus,
  startedH: number,
  finishedH: number | null,
  over: Partial<RunRow> = {},
): RunRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    job: "alpha-sync",
    mode: "incremental",
    status,
    phase: null,
    lockName: "alpha-sync",
    holder: "00000000-0000-4000-8000-0000000000aa",
    startedAt: new Date(NOW - startedH * H),
    finishedAt: finishedH === null ? null : new Date(NOW - finishedH * H),
    listed: null,
    written: null,
    unchanged: null,
    quarantined: null,
    excluded: null,
    reconciled: null,
    excludedReasons: {},
    counts: {},
    tokens: {},
    costUsd: null,
    costNote: null,
    scope: null,
    scopeExcluded: null,
    overrides: [],
    reason: null,
    ...over,
  };
}
/** A running row whose fence last beat `beatMsAgo` ms before NOW (null: the fence names another holder). */
const running = (startedH: number, beatMsAgo: number | null, live = true): RunningRow => ({
  ...row("running", startedH, null),
  live,
  heartbeatAt: beatMsAgo === null ? null : new Date(NOW - beatMsAgo),
  heartbeatAgeMs: beatMsAgo,
});
const snap = (
  newestSettled: RunRow | null,
  newestOk: RunRow | null,
  run: RunningRow[] = [],
): JobSnapshot => ({ total: 0, newestSettled, newestOk, running: run });

const thrown = (fn: () => unknown): RootstockRunsError => {
  try {
    fn();
  } catch (err) {
    return err as RootstockRunsError;
  }
  throw new Error("expected a refusal");
};

describe("verdictFor", () => {
  test("RV1: each verdict in precedence order, where the next rule would also match", () => {
    // Only running rows (fresh beat): never-ran, not anything later.
    expect(verdictFor(snap(null, null, [running(1, 1000)]), ALPHA, { now: NOW })).toEqual({
      verdict: "never-ran",
    });
    // never-succeeded, though a failure is also old enough to be "stale".
    const failed = row("failed", 100, 99);
    expect(verdictFor(snap(failed, null), ALPHA, { now: NOW, live: 0 })).toEqual({
      verdict: "never-succeeded",
      lastStatus: "failed",
      lastAt: failed.finishedAt as Date,
    });
    // stale wins over a newer interrupted row past its grace.
    const oldOk = row("ok", 31, 30);
    const late = row("interrupted", 20, 10);
    expect(verdictFor(snap(late, oldOk), ALPHA, { now: NOW, live: 0 })).toEqual({
      verdict: "stale",
      ageHours: 30,
      maxAgeHours: 24,
    });
    // interrupted wins over an archival spike.
    const spiky = row("ok", 6, 5, { counts: { archived: 1000 } });
    const killed = row("interrupted", 4, 3);
    expect(verdictFor(snap(killed, spiky), ALPHA, { now: NOW, live: 0 })).toEqual({
      verdict: "interrupted",
      at: killed.finishedAt as Date,
      graceHours: 2,
    });
    // archival-spike wins over ok.
    expect(verdictFor(snap(spiky, spiky), ALPHA, { now: NOW, live: 1000 })).toEqual({
      verdict: "archival-spike",
      archived: 1000,
      live: 1000,
      share: 0.5,
    });
    // ok, with the unrounded age.
    const fresh = row("ok", 2, 1.5);
    expect(verdictFor(snap(fresh, fresh), ALPHA, { now: NOW, live: 10 })).toEqual({
      verdict: "ok",
      ageHours: 1.5,
    });
    // A newer failure after a still-fresh ok is ok here.
    expect(verdictFor(snap(row("failed", 1, 0.5), fresh), ALPHA, { now: NOW, live: 10 })).toEqual({
      verdict: "ok",
      ageHours: 1.5,
    });
    expect(() => verdictFor(snap(fresh, fresh), ALPHA, { now: Number.NaN, live: 1 })).toThrow(
      "verdictFor(): now must be a finite number of ms — got NaN",
    );
  });

  test("RV2: interrupted inside the grace is ok; past it, interrupted; older than the newest ok, ok", () => {
    const ok = row("ok", 5, 4);
    const inside = row("interrupted", 3, 2);
    expect(verdictFor(snap(inside, ok), ALPHA, { now: NOW, live: 0 })).toEqual({
      verdict: "ok",
      ageHours: 4,
    });
    const atEdge = row("interrupted", 3, 2 + 1e-9);
    expect(verdictFor(snap(atEdge, ok), ALPHA, { now: NOW, live: 0 }).verdict).toBe("interrupted");
    const past = row("interrupted", 3, 2.5);
    expect(verdictFor(snap(past, ok), ALPHA, { now: NOW, live: 0 })).toEqual({
      verdict: "interrupted",
      at: past.finishedAt as Date,
      graceHours: 2,
    });
    const before = row("interrupted", 6, 3);
    expect(verdictFor(snap(before, ok), ALPHA, { now: NOW, live: 0 }).verdict).toBe("ok");
  });

  test("RV3: a manual job is never stale and shows interrupted at once", () => {
    const ancient = row("ok", 10_001, 10_000, { job: "beta-sync" });
    expect(verdictFor(snap(ancient, ancient), BETA, { now: NOW })).toEqual({
      verdict: "ok",
      ageHours: 10_000,
    });
    const just = row("interrupted", 1, 0, { job: "beta-sync" });
    expect(verdictFor(snap(just, ancient), BETA, { now: NOW })).toEqual({
      verdict: "interrupted",
      at: just.finishedAt as Date,
      graceHours: 0,
    });
  });

  test("RV4: archival spike boundaries are strict (archived = allowance, share = spike.share)", () => {
    const at = (archived: number, live: number) => {
      const ok = row("ok", 2, 1, { counts: { archived } });
      return verdictFor(snap(ok, ok), ALPHA, { now: NOW, live }).verdict;
    };
    expect(at(50, 0)).toBe("ok");
    expect(at(51, 0)).toBe("archival-spike");
    expect(60 / (540 + 60)).toBe(0.1);
    expect(at(60, 540)).toBe("ok");
    expect(at(61, 540)).toBe("archival-spike");
    // No archived count recorded reads 0.
    const none = row("ok", 2, 1);
    expect(verdictFor(snap(none, none), ALPHA, { now: NOW, live: 0 }).verdict).toBe("ok");
  });

  test("RV5: live missing with an archived counter refuses INPUT", () => {
    const ok = row("ok", 2, 1);
    const err = thrown(() => verdictFor(snap(ok, ok), ALPHA, { now: NOW }));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(err.message).toBe(
      "rootstock runs: verdictFor(alpha-sync): live is required when the job declares an archived counter",
    );
    expect(thrown(() => verdictFor(snap(ok, ok), ALPHA, { now: NOW, live: -1 })).message).toBe(
      "rootstock runs: verdictFor(alpha-sync): live must be a non-negative integer — got -1",
    );
    // A job without an archived counter needs no live count.
    const beta = row("ok", 2, 1, { job: "beta-sync" });
    expect(verdictFor(snap(beta, beta), BETA, { now: NOW }).verdict).toBe("ok");
  });

  test("RV7 (§20 A9): a black-holed holder — fenced, lock held, heartbeat stale — reads interrupted", () => {
    const ok = row("ok", 10, 9, { job: "beta-sync" });
    // Live (fence names it, lock held), last beat 120 s + 1 ms ago: interrupted at its last beat.
    const stuck = running(5, 120_001, true);
    expect(verdictFor(snap(ok, ok, [stuck]), BETA, { now: NOW })).toEqual({
      verdict: "interrupted",
      at: stuck.heartbeatAt as Date,
      graceHours: 0,
    });
    // Exactly at staleHeartbeatSeconds, or beating: ok.
    expect(verdictFor(snap(ok, ok, [running(5, 120_000)]), BETA, { now: NOW }).verdict).toBe("ok");
    expect(verdictFor(snap(ok, ok, [running(5, 1_000)]), BETA, { now: NOW }).verdict).toBe("ok");
    // A fence that names another holder carries no beat: not judged here.
    expect(verdictFor(snap(ok, ok, [running(5, null, false)]), BETA, { now: NOW }).verdict).toBe(
      "ok",
    );
    // A job with a grace: the grace runs from the last beat.
    const alphaOk = row("ok", 6, 5);
    const inGrace = running(4, 1.5 * H);
    expect(
      verdictFor(snap(alphaOk, alphaOk, [inGrace]), ALPHA, { now: NOW, live: 0 }).verdict,
    ).toBe("ok");
    const pastGrace = running(4, 2.5 * H);
    expect(verdictFor(snap(alphaOk, alphaOk, [pastGrace]), ALPHA, { now: NOW, live: 0 })).toEqual({
      verdict: "interrupted",
      at: pastGrace.heartbeatAt as Date,
      graceHours: 2,
    });
    // A stale running row with no settled row: it never succeeded, and was interrupted.
    const lone = running(1, 200_000);
    expect(verdictFor(snap(null, null, [lone]), BETA, { now: NOW })).toEqual({
      verdict: "never-succeeded",
      lastStatus: "interrupted",
      lastAt: lone.heartbeatAt as Date,
    });
    // The age is the database's (A18): an app clock ahead of the database
    // by an hour does not make a beating run stale.
    const skewed = { ...running(5, 1_000), heartbeatAt: new Date(NOW - H) };
    expect(verdictFor(snap(ok, ok, [skewed]), BETA, { now: NOW }).verdict).toBe("ok");
    // A stale running row older than the newest settled row is ignored (A19).
    const newer = row("failed", 2, 1, { job: "beta-sync" });
    expect(verdictFor(snap(newer, ok, [running(5, 200_000)]), BETA, { now: NOW })).toEqual(
      verdictFor(snap(newer, ok, []), BETA, { now: NOW }),
    );
    // Of several running rows, the newest stale one is the one judged.
    const older = running(6, 300_000);
    const newest = running(4, 200_000);
    expect(
      verdictFor(snap(ok, ok, [older, newest, running(3, 1_000)]), BETA, { now: NOW }),
    ).toEqual({
      verdict: "interrupted",
      at: newest.heartbeatAt as Date,
      graceHours: 0,
    });
    // stale still wins over it.
    const oldOk = row("ok", 31, 30);
    expect(
      verdictFor(snap(oldOk, oldOk, [running(1, 3 * H)]), ALPHA, { now: NOW, live: 0 }).verdict,
    ).toBe("stale");
  });
});

describe("pushVerdictFor", () => {
  test("RV6: off, never-ran, stale, ok; an interrupted or failed newest row with a fresh ok is ok", () => {
    const fresh = row("ok", 2, 1, { job: "gamma-push" });
    expect(pushVerdictFor(snap(fresh, fresh), GAMMA, { now: NOW, enabled: false })).toEqual({
      verdict: "off",
    });
    expect(pushVerdictFor(snap(null, null), GAMMA, { now: NOW, enabled: true })).toEqual({
      verdict: "never-ran",
    });
    const old = row("ok", 8, 7, { job: "gamma-push" });
    expect(pushVerdictFor(snap(old, old), GAMMA, { now: NOW, enabled: true })).toEqual({
      verdict: "stale",
      ageHours: 7,
      maxAgeHours: 6,
    });
    const six = row("ok", 7, 6, { job: "gamma-push" });
    expect(pushVerdictFor(snap(six, six), GAMMA, { now: NOW, enabled: true })).toEqual({
      verdict: "ok",
      ageHours: 6,
    });
    for (const status of ["interrupted", "failed"] as const) {
      const newer = row(status, 0.5, 0.25, { job: "gamma-push" });
      expect(
        pushVerdictFor(snap(newer, fresh, [running(0.1, 10 * H)]), GAMMA, {
          now: NOW,
          enabled: true,
        }),
      ).toEqual({ verdict: "ok", ageHours: 1 });
    }
    const err = thrown(() => pushVerdictFor(snap(null, null), BETA, { now: NOW, enabled: true }));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(err.message).toBe("rootstock runs: pushVerdictFor(beta-sync): the job declares no push");
  });
});
