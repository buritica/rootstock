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
    wait: { maxMs: lock.wait.maxMs, pollIntervalMs: lock.wait.pollIntervalMs },
  };
}

function queueView(queue: RootstockConfig["queue"]): unknown {
  if (queue === null) return "absent";
  const c = queue.cursors;
  return {
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
  for (const name of ABSENT) view[name] = "absent";
  return `${canonicalJson(view, 2)}\n`;
}
