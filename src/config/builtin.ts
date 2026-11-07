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
