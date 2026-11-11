import { canonicalJson } from "../golden/canonical.ts";
import { isRootstockConfig, type RootstockConfig } from "./define.ts";

// Slices later stages add. Each prints as "absent" until its stage lands, so
// a config golden shows what a repo has not adopted yet.
const ABSENT = ["embed", "runner"] as const;

const table = (t: { name: string; schema: string }) => ({ name: t.name, schema: t.schema });

function lockView(lock: RootstockConfig["lock"]): unknown {
  if (lock === null) return "absent";
  const groups: Record<string, unknown> = {};
  for (const [name, list] of Object.entries(lock.groups)) groups[name] = [...list];
  return {
    endTimeoutSeconds: lock.endTimeoutSeconds,
    groups,
    heartbeatSeconds: lock.heartbeatSeconds,
    maxRecoveries: lock.maxRecoveries,
    names: [...lock.names],
    probeStallSeconds: lock.probeStallSeconds,
    profile: lock.profile,
    table: table(lock.table),
    wait: {
      maxMs: lock.wait.maxMs,
      pollIntervalMs: lock.wait.pollIntervalMs,
      // Printed only when given, so a config without it prints as before.
      ...(lock.wait.block === undefined
        ? {}
        : { block: { checkIntervalMs: lock.wait.block.checkIntervalMs } }),
    },
  };
}

function queueView(queue: RootstockConfig["queue"]): unknown {
  if (queue === null) return "absent";
  const c = queue.cursors;
  return {
    ackLockTimeoutMs: queue.ackLockTimeoutMs,
    backoffMinutes: [...queue.backoffMinutes],
    claimTimeoutMinutes: queue.claimTimeoutMinutes,
    cursors:
      c === null
        ? "absent"
        : {
            maxNameChars: c.maxNameChars,
            maxValueChars: c.maxValueChars,
            table: table(c.table),
            value: c.value,
          },
    enqueueLockTimeoutMs: queue.enqueueLockTimeoutMs,
    expiredClaimClass: queue.expiredClaimClass,
    kinds: [...queue.kinds],
    maxAttempts: queue.maxAttempts,
    maxClaimLimit: queue.maxClaimLimit,
    maxDebounceSeconds: queue.maxDebounceSeconds,
    maxDebounceSlideMinutes: queue.maxDebounceSlideMinutes,
    maxKeyChars: queue.maxKeyChars,
    maxNameChars: queue.maxNameChars,
    maxPayloadBytes: queue.maxPayloadBytes,
    sources: [...queue.sources],
    stickyKind: queue.stickyKind,
    table: table(queue.table),
  };
}

/** Each entry of `map` through `view`, keyed as given (canonicalJson sorts the keys). */
function mapView<T>(map: Readonly<Record<string, T>>, view: (v: T) => unknown) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, view(v)]));
}

function runsView(runs: NonNullable<RootstockConfig["runs"]>): unknown {
  const q = runs.quarantine;
  return {
    brakes: mapView(runs.brakes, (b) => ({
      allowance: b.allowance,
      armAt: b.armAt,
      rounding: b.rounding,
      share: b.share,
    })),
    breakers: mapView(runs.breakers, (b) => ({ limit: b.limit })),
    budgets: mapView(runs.budgets, (b) => ({ limit: b.limit, windowMinutes: b.windowMinutes })),
    // The declaration's own `key` is the map key, so it is not printed twice.
    jobs: mapView(runs.jobs, (j) => ({
      counters: { ...j.counters },
      interruptedGraceHours: j.interruptedGraceHours,
      lock: j.lock,
      maxAgeHours: j.maxAgeHours,
      metered: j.metered,
      modes: [...j.modes],
      push:
        j.push === null ? null : { heartbeat: j.push.heartbeat, maxAgeHours: j.push.maxAgeHours },
      reconciles: j.reconciles,
      spike: j.spike === null ? null : { allowance: j.spike.allowance, share: j.spike.share },
      staleHeartbeatSeconds: j.staleHeartbeatSeconds,
    })),
    lockTable: table(runs.lockTable),
    maxCountKeys: runs.maxCountKeys,
    maxReasonChars: runs.maxReasonChars,
    maxScopeBytes: runs.maxScopeBytes,
    modes: [...runs.modes],
    // Prices are policy, not secrets: printed as the numbers given.
    prices: mapView(runs.prices, (p) => ({
      inputPerMTok: p.inputPerMTok,
      outputPerMTok: p.outputPerMTok,
    })),
    quarantine:
      q === null
        ? null
        : {
            columns: { ...q.columns },
            maxPayloadBytes: q.maxPayloadBytes,
            maxReasonChars: q.maxReasonChars,
            table: table(q.table),
          },
    retention: { keepDays: runs.retention.keepDays },
    table: table(runs.table),
  };
}

/**
 * The config as canonical JSON, every field spelled out, for a repo to pin
 * as its config golden. No version field: a patch release must not move it.
 */
export function printRootstockConfig(config: RootstockConfig): string {
  if (!isRootstockConfig(config)) {
    throw new Error(
      "printRootstockConfig: expected a RootstockConfig built by defineRootstockConfig() — got an object that parser did not return",
    );
  }
  // The view is the frozen field list, not whatever a slice object holds,
  // so nothing a parser keeps for itself reaches a golden. A slice field a
  // later stage adds is printed only once it is named here.
  const profiles: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(config.client.profiles)) {
    profiles[name] = {
      connectTimeoutSeconds: p.connectTimeoutSeconds,
      idleTimeoutSeconds: p.idleTimeoutSeconds,
      keepAliveSeconds: p.keepAliveSeconds,
      max: p.max,
      maxCeiling: p.maxCeiling,
      maxLifetimeSeconds: p.maxLifetimeSeconds,
      prepare: p.prepare,
      readOnly: p.readOnly,
      statementTimeoutMs: p.statementTimeoutMs,
    };
  }
  const widths: Record<string, unknown> = {};
  for (const [name, w] of Object.entries(config.concurrency.widths)) {
    widths[name] = { default: w.default, max: w.max };
  }
  const view: Record<string, unknown> = {
    client: { profiles },
    concurrency: { widths },
    invariants: [...config.invariants],
    lock: lockView(config.lock),
    migrate: { accepted: config.migrate.accepted, schema: config.migrate.schema },
    queue: queueView(config.queue),
  };
  // Printed only when given, so a config without it prints byte-identically
  // to 0.7.0's and no consumer's config golden moves with the bump (§0.4).
  if (config.runs !== null) view.runs = runsView(config.runs);
  for (const name of ABSENT) view[name] = "absent";
  return `${canonicalJson(view, 2)}\n`;
}
