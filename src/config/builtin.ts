import { own, q } from "../internal/slice.ts";
import type { Invariant, RootstockConfig } from "./define.ts";

type Profile = RootstockConfig["client"]["profiles"][string];

/** Each field the lock session's profile must pin, the rule, and how the rule reads. */
const RULES: readonly [keyof Profile, (v: unknown) => boolean, string][] = [
  ["max", (v) => v === 1, "1"],
  ["maxCeiling", (v) => v === 1, "1"],
  ["idleTimeoutSeconds", (v) => v === "driver-default" || v === 0, '"driver-default" or 0'],
  ["maxLifetimeSeconds", (v) => v === "never", '"never"'],
  ["statementTimeoutMs", (v) => v === 0, "0"],
  ["readOnly", (v) => v === false, "false"],
];

/**
 * Built in, never exported: the lock slice's profile must open one
 * connection that nothing closes or times out under the lock, because the
 * advisory lock lives exactly as long as that one backend. Runs whenever a
 * lock slice is present, before the consumer's invariants.
 */
export const lockProfileSingle: Invariant = Object.freeze({
  id: "lock-profile-single",
  check(config: RootstockConfig): string | null {
    const name = config.lock?.profile;
    if (name === undefined) return null;
    const profiles = config.client.profiles;
    const profile = own(profiles, name);
    if (profile === undefined) {
      return `lock.profile names no connection profile ${q(name)} — declared: ${Object.keys(profiles).join(", ")}`;
    }
    for (const [field, holds, expected] of RULES) {
      const value = profile[field];
      if (!holds(value)) {
        return `profile ${q(name)} must have ${field} ${expected} for the lock session — got ${q(value)}`;
      }
    }
    return null;
  },
});

const tableText = (t: { schema: string; name: string }): string => `${t.schema}.${t.name}`;

/**
 * Built in, never exported: the runs slice judges a running row live against
 * the lock slice's fencing table, so both must name the same table. Holds
 * when there is no lock slice (`runs-job-locks` reports that).
 */
export const runsLockTable: Invariant = Object.freeze({
  id: "runs-lock-table",
  check(config: RootstockConfig): string | null {
    const { runs, lock } = config;
    if (runs === null || lock === null) return null;
    const a = runs.lockTable;
    const b = lock.table;
    if (a.schema === b.schema && a.name === b.name) return null;
    return `runs.lockTable ${tableText(a)} is not the lock slice's table ${tableText(b)}: running rows would be judged against the wrong fence`;
  },
});

// Job names are at most 64 characters and lock names at most 200 bytes, both
// ASCII, so the longest member of a job family derives a lock name this long.
const MAX_JOB_CHARS = 64;
const MAX_LOCK_BYTES = 200;

/** The prefix of a "prefix*" family, or undefined for an exact name. */
const familyPrefix = (name: string): string | undefined =>
  name.endsWith("*") ? name.slice(0, -1) : undefined;

/** How job `key`'s lock `lock` fails the lock slice's `names`, or null when admitted. */
function lockRefusal(names: readonly string[], key: string, lock: string): string | null {
  const lockPrefix = familyPrefix(lock);
  if (lockPrefix === undefined) {
    // An exact lock: an exact entry, or a family entry covering it, as the
    // lock slice's admits() reads it (the runs parser already held the name
    // to the lock slice's name rule and length).
    const admitted = names.some((entry) => {
      const prefix = familyPrefix(entry);
      return prefix === undefined
        ? entry === lock
        : lock.length > prefix.length && lock.startsWith(prefix);
    });
    return admitted ? null : `${key} (lock ${q(lock)})`;
  }
  // A family lock names many locks, so only an equal family entry admits it (N3).
  if (!names.includes(lock)) return `${key} (lock ${q(lock)} needs an equal family entry)`;
  // Each member's lock keeps the member's suffix (§2), so the longest must fit.
  const jobPrefix = familyPrefix(key) ?? key;
  if (lockPrefix.length + MAX_JOB_CHARS - jobPrefix.length > MAX_LOCK_BYTES) {
    return `${key} (lock ${q(lock)} cannot name every member's lock in ${MAX_LOCK_BYTES} bytes)`;
  }
  return null;
}

/**
 * Built in, never exported: every job runs under a lock the lock slice
 * admits (contract §10.2). A run needs a lock (D62), so a runs slice without
 * a lock slice fails.
 */
export const runsJobLocks: Invariant = Object.freeze({
  id: "runs-job-locks",
  check(config: RootstockConfig): string | null {
    const { runs, lock } = config;
    if (runs === null) return null;
    const jobs = Object.entries(runs.jobs);
    if (lock === null) {
      const keys = jobs.map(([key]) => key).join(", ");
      return `jobs ${keys} have no lock slice to run under: a run needs a lock`;
    }
    const offenders = jobs.flatMap(([key, job]) => {
      const why = lockRefusal(lock.names, key, job.lock);
      return why === null ? [] : [why];
    });
    if (offenders.length === 0) return null;
    return `jobs ${offenders.join(", ")} run under locks the lock slice does not admit: acquireRunLock would refuse them`;
  },
});

/**
 * Built in, never exported (contract §20 A9): a running row whose fence has
 * not beaten for `staleHeartbeatSeconds` reads interrupted, so the bound must
 * span two of the lock's beats or a live run could read interrupted between
 * them. Holds when there is no lock slice (`runs-job-locks` reports that).
 */
export const runsStaleHeartbeat: Invariant = Object.freeze({
  id: "runs-stale-heartbeat",
  check(config: RootstockConfig): string | null {
    const { runs, lock } = config;
    if (runs === null || lock === null) return null;
    const floor = 2 * lock.heartbeatSeconds;
    const offenders = Object.entries(runs.jobs).flatMap(([key, job]) =>
      job.staleHeartbeatSeconds < floor ? [`${key} (${job.staleHeartbeatSeconds})`] : [],
    );
    if (offenders.length === 0) return null;
    return `jobs ${offenders.join(", ")} have staleHeartbeatSeconds below ${floor}, twice the lock slice's heartbeatSeconds: a live run would read interrupted between two beats`;
  },
});
