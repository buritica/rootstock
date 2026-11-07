import type { QueueSliceInput } from "./slice.ts";

/** The synthetic slice of contract §4.8. */
export const QUEUE_INPUT: QueueSliceInput = {
  sources: ["alpha", "beta"],
  kinds: ["put", "drop"],
  stickyKind: "drop",
  expiredClaimClass: "ExpiredClaim",
  backoffMinutes: [1, 5, 30, 120, 240, 480],
  maxAttempts: 8,
  claimTimeoutMinutes: 30,
  maxDebounceSeconds: 900,
  maxDebounceSlideMinutes: 15,
  maxKeyChars: 512,
  maxNameChars: 128,
  maxPayloadBytes: 65536,
  maxClaimLimit: 500,
  enqueueLockTimeoutMs: 2000,
  cursors: { value: "jsonb", maxNameChars: 128, maxValueChars: 512 },
};
