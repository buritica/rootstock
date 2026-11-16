// Liveness and readiness (contract §4). The consumer mounts both on its own
// routes; neither is a profile route.

import type { Sql } from "../db/index.ts";
import type { MigrationStatus } from "../migrate/index.ts";
import { raceDeadline } from "./deadline.ts";
import { className, configError, isNonNegativeNumber } from "./errors.ts";
import type { Clock, LogEvent, Timers } from "./types.ts";

/** A JSON body serialized once; every call answers 200 with it. */
export function liveness(o: {
  fields: Readonly<Record<string, string | number | boolean | null>>;
  headers: Readonly<Record<string, string>>;
}): () => Response {
  const body = JSON.stringify(o.fields);
  const headers = { ...o.headers };
  return () => new Response(body, { status: 200, headers });
}

export interface ProbeTiming {
  /** Bounds the answer, not the computation. */
  timeoutMs: number;
  /** How long a verdict (an `undefined` one included) is reused. */
  cacheTtlMs: number;
  /** No new computation while one younger than this is still running. */
  pendingMaxMs: number;
}

function assertTiming(fn: string, t: ProbeTiming): void {
  for (const k of ["timeoutMs", "cacheTtlMs", "pendingMaxMs"] as const) {
    const v = t?.[k];
    if (!isNonNegativeNumber(v)) {
      throw configError(fn, `timing.${k} must be a finite number >= 0`, v);
    }
  }
}

/**
 * One computation in flight at a time, its verdict cached for `cacheTtlMs`,
 * the answer bounded by `timeoutMs`, and no new computation while one is
 * still running and younger than `pendingMaxMs` (a wedged database is not
 * hit again on every poll). Never rejects: a failed, timed-out or skipped
 * computation answers `undefined` and logs `serve.probe_failed`,
 * `serve.probe_timeout` or `serve.probe_skipped` with `probe: label`.
 * Durations read `clock.monotonic()`.
 */
export function cachedProbe<T>(
  compute: () => Promise<T>,
  timing: ProbeTiming,
  label: string,
  deps: { clock: Clock; timers: Timers; log: LogEvent },
): () => Promise<T | undefined> {
  assertTiming("cachedProbe", timing);
  const { clock, timers, log } = deps;
  let inFlight: Promise<T | undefined> | undefined;
  let verdict: { state: T | undefined; expiresAt: number } | undefined;
  let pendingSince: number | undefined;

  const probeOnce = async (): Promise<T | undefined> => {
    const pendingMs = pendingSince === undefined ? undefined : clock.monotonic() - pendingSince;
    if (pendingMs !== undefined && pendingMs < timing.pendingMaxMs) {
      log("serve.probe_skipped", { probe: label, pendingMs: Math.round(pendingMs) });
      return undefined;
    }
    const startedAt = clock.monotonic();
    pendingSince = startedAt;
    const settle = () => {
      if (pendingSince === startedAt) pendingSince = undefined;
    };
    // Through .then, so a compute that throws synchronously rejects instead.
    const query = Promise.resolve().then(compute);
    void query.then(settle, settle);
    try {
      const outcome = await raceDeadline(timers, timing.timeoutMs, query);
      if (outcome === "timeout") {
        log("serve.probe_timeout", { probe: label, timeoutMs: timing.timeoutMs });
        return undefined;
      }
      return outcome.value;
    } catch (err) {
      // The message is for the operator's log only; the unauthenticated route never carries it.
      log("serve.probe_failed", { probe: label, errorClass: className(err), error: err });
      return undefined;
    }
  };

  return () => {
    if (verdict && clock.monotonic() < verdict.expiresAt) return Promise.resolve(verdict.state);
    // probeOnce catches its own failures, but a throwing `log` would still
    // reject it; the probe answers undefined then, and inFlight is cleared.
    inFlight ??= probeOnce()
      .catch((): T | undefined => undefined)
      .then((state) => {
        verdict = { state, expiresAt: clock.monotonic() + timing.cacheTtlMs };
        inFlight = undefined;
        return state;
      });
    return inFlight;
  };
}

/** `select 1`; rejects with the driver's error. */
export function dbProbe(sql: Sql): () => Promise<"ok"> {
  return async () => {
    await sql`select 1`;
    return "ok";
  };
}

export interface MigrationsVerdict {
  readonly ok: boolean;
  readonly behind: readonly string[];
  readonly ahead: readonly string[];
  readonly tampered: readonly string[];
}

/**
 * Readiness's view of a migration status: `ok` is false only when the
 * database is behind the image or a recorded file changed. Ahead is reported
 * and stays ready (an old instance after a deploy's migrate is ahead by
 * design). Ids only, `<source>/<id>`, never hashes.
 */
export function migrationsProbe(
  read: () => Promise<MigrationStatus>,
): () => Promise<MigrationsVerdict> {
  return async () => {
    const status = await read();
    return Object.freeze({
      ok: !(status.behind || status.tampered),
      behind: status.sources.flatMap((s) => s.pending.map((m) => `${s.source}/${m.id}`)),
      ahead: status.sources.flatMap((s) => s.ahead.map((id) => `${s.source}/${id}`)),
      tampered: status.sources.flatMap((s) => s.tampered.map((t) => `${s.source}/${t.id}`)),
    });
  };
}

/**
 * `{ status, sha, db, ...probes }`: probes in insertion order, an `undefined`
 * one omitted. 503 when `db` is not "ok" (`null` db answers "unconfigured",
 * which is not ready) or a gating probe reports `ok: false`. The db probe
 * and every other probe go through `cachedProbe` with `timing`; `db` reads
 * "unreachable" when its probe answers nothing, and the first "ok" after
 * that logs `serve.ready_recovered`.
 */
export function readiness(o: {
  sha: string | null;
  db: (() => Promise<"ok">) | null;
  probes: Readonly<
    Record<string, { read: () => Promise<{ ok?: boolean } | undefined>; gates: boolean }>
  >;
  headers: Readonly<Record<string, string>>;
  timing: ProbeTiming;
  clock: Clock;
  timers: Timers;
  log: LogEvent;
}): () => Promise<Response> {
  assertTiming("readiness", o.timing);
  const deps = { clock: o.clock, timers: o.timers, log: o.log };
  const db = o.db === null ? null : cachedProbe(o.db, o.timing, "db", deps);
  const probes = Object.entries(o.probes).map(
    ([name, p]) => [name, p.gates, cachedProbe(p.read, o.timing, name, deps)] as const,
  );
  const headers = { ...o.headers };
  let lastDb: "ok" | "unreachable" | undefined;
  return async () => {
    const [dbState, ...values] = await Promise.all([
      db === null ? Promise.resolve("unconfigured" as const) : db(),
      ...probes.map(([, , read]) => read()),
    ]);
    const dbField = dbState === undefined ? "unreachable" : dbState;
    if (dbField !== "unconfigured") {
      if (dbField === "ok" && lastDb === "unreachable") o.log("serve.ready_recovered", {});
      lastDb = dbField;
    }
    const fields: Record<string, unknown> = {};
    let ok = dbField === "ok";
    probes.forEach(([name, gates], i) => {
      const v = values[i];
      if (v === undefined) return;
      fields[name] = v;
      if (gates && v.ok === false) ok = false;
    });
    const body = { status: ok ? "ok" : "not_ready", sha: o.sha, db: dbField, ...fields };
    return new Response(JSON.stringify(body), { status: ok ? 200 : 503, headers });
  };
}
