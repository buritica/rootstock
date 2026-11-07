import { describe, expect, test } from "bun:test";
import { QUEUE_INPUT } from "../queue/fixtures.test-support.ts";
import { defineRootstockConfig } from "./compose.ts";
import type { Invariant, RootstockConfigInput } from "./define.ts";
import { printRootstockConfig } from "./print.ts";

// R-C7 (contract §5.5 CF2-CF4): the lock and queue slices in a config, and
// the built-in lock-profile-single invariant.

const LOCK_PROFILE = {
  max: 1,
  maxCeiling: 1,
  idleTimeoutSeconds: "driver-default",
  maxLifetimeSeconds: "never",
  connectTimeoutSeconds: "driver-default",
  prepare: "driver-default",
  keepAliveSeconds: "driver-default",
  statementTimeoutMs: 0,
  readOnly: false,
} as const;

const LOCK = {
  profile: "lock",
  names: ["alpha-sync", "gamma-*"],
  groups: { writers: ["alpha-sync"] },
  heartbeatSeconds: 30,
  probeStallSeconds: 60,
  maxRecoveries: 5,
  endTimeoutSeconds: 5,
  wait: { maxMs: 30000, pollIntervalMs: 1000 },
};

function input(lockProfile: Record<string, unknown> = LOCK_PROFILE): RootstockConfigInput {
  return {
    client: {
      profiles: {
        app: { ...LOCK_PROFILE, max: 5, maxCeiling: 20 },
        lock: lockProfile as typeof LOCK_PROFILE,
      },
    },
    migrate: {},
    concurrency: { widths: { fetch: { default: 2, max: 4 } } },
    lock: LOCK,
    queue: QUEUE_INPUT,
  };
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
}

const LOCK_PRINT = {
  endTimeoutSeconds: 5,
  groups: { writers: ["alpha-sync"] },
  heartbeatSeconds: 30,
  maxRecoveries: 5,
  names: ["alpha-sync", "gamma-*"],
  probeStallSeconds: 60,
  profile: "lock",
  table: { name: "run_locks", schema: "rootstock" },
  wait: { maxMs: 30000, pollIntervalMs: 1000 },
};

describe("lock and queue slices", () => {
  test("CF2: they compose and print with every field spelled out", () => {
    const config = defineRootstockConfig(input());
    expect(config.invariants).toEqual(["lock-profile-single"]);
    const view = JSON.parse(printRootstockConfig(config));
    expect(view.lock).toEqual(LOCK_PRINT);
    expect(view.queue).toEqual({
      backoffMinutes: [1, 5, 30, 120, 240, 480],
      claimTimeoutMinutes: 30,
      cursors: {
        maxNameChars: 128,
        maxValueChars: 512,
        table: { name: "cursors", schema: "rootstock" },
        value: "jsonb",
      },
      enqueueLockTimeoutMs: 2000,
      expiredClaimClass: "ExpiredClaim",
      kinds: ["put", "drop"],
      maxAttempts: 8,
      maxClaimLimit: 500,
      maxDebounceSeconds: 900,
      maxDebounceSlideMinutes: 15,
      maxKeyChars: 512,
      maxNameChars: 128,
      maxPayloadBytes: 65536,
      sources: ["alpha", "beta"],
      stickyKind: "drop",
      table: { name: "work_queue", schema: "rootstock" },
    });
    const { cursors: _c, stickyKind: _s, ...bare } = QUEUE_INPUT;
    const plain = JSON.parse(
      printRootstockConfig(defineRootstockConfig({ ...input(), queue: bare })),
    );
    expect(plain.queue.cursors).toBe("absent");
    expect(plain.queue.stickyKind).toBeNull();
    expect(Object.keys(view).sort()).toEqual([
      "client",
      "concurrency",
      "embed",
      "invariants",
      "lock",
      "migrate",
      "queue",
      "runner",
    ]);
  });

  test("CF4: an omitted table schema is migrate.schema", () => {
    const config = defineRootstockConfig({ ...input(), migrate: { schema: "rs_a" } });
    expect(config.lock?.table).toEqual({ schema: "rs_a", name: "run_locks" });
    expect(config.queue?.table).toEqual({ schema: "rs_a", name: "work_queue" });
    expect(config.queue?.cursors?.table).toEqual({ schema: "rs_a", name: "cursors" });
    const own = defineRootstockConfig({
      ...input(),
      migrate: { schema: "rs_a" },
      lock: { ...LOCK, table: { schema: "app", name: "locks" } },
    });
    expect(own.lock?.table).toEqual({ schema: "app", name: "locks" });
  });

  test("a lock slice's refusal reaches the caller unchanged", () => {
    expect(
      messageOf(() => defineRootstockConfig({ ...input(), lock: { ...LOCK, names: [] } })),
    ).toBe("lockSlice: names must be a non-empty array of lock names — got []");
  });
});

describe("CF3: lock-profile-single", () => {
  const cases: [string, unknown, string][] = [
    ["max", 2, "1"],
    ["maxCeiling", 2, "1"],
    ["idleTimeoutSeconds", 20, '"driver-default" or 0'],
    ["maxLifetimeSeconds", 600, '"never"'],
    ["statementTimeoutMs", 5000, "0"],
    ["readOnly", true, "false"],
  ];
  for (const [field, value, expected] of cases) {
    test(`${field}: ${JSON.stringify(value)} fails`, () => {
      const profile = {
        ...LOCK_PROFILE,
        [field]: value,
        ...(field === "max" ? { maxCeiling: 2 } : {}),
      };
      expect(messageOf(() => defineRootstockConfig(input(profile)))).toBe(
        `defineRootstockConfig: 1 invariant(s) failed — lock-profile-single: profile "lock" must have ${field} ${expected} for the lock session — got ${JSON.stringify(value)}`,
      );
    });
  }

  test("an idle timeout of 0 holds", () => {
    expect(
      defineRootstockConfig(input({ ...LOCK_PROFILE, idleTimeoutSeconds: 0 })).invariants,
    ).toEqual(["lock-profile-single"]);
  });

  test("a missing profile, invariants: [] included, and joined with a consumer failure", () => {
    const missing = { ...input(), lock: { ...LOCK, profile: "session" }, invariants: [] };
    expect(messageOf(() => defineRootstockConfig(missing))).toBe(
      'defineRootstockConfig: 1 invariant(s) failed — lock-profile-single: lock.profile names no connection profile "session" — declared: app, lock',
    );
    const consumer: Invariant = { id: "app-pool-sane", check: () => "pool too small" };
    expect(messageOf(() => defineRootstockConfig({ ...missing, invariants: [consumer] }))).toBe(
      'defineRootstockConfig: 2 invariant(s) failed — lock-profile-single: lock.profile names no connection profile "session" — declared: app, lock; app-pool-sane: pool too small',
    );
  });

  test("its id comes first, a consumer cannot reuse it, and no lock means no check", () => {
    const config = defineRootstockConfig({
      ...input(),
      invariants: [{ id: "app-pool-sane", check: () => null }],
    });
    expect(config.invariants).toEqual(["lock-profile-single", "app-pool-sane"]);
    expect(
      messageOf(() =>
        defineRootstockConfig({
          ...input(),
          invariants: [{ id: "lock-profile-single", check: () => null }],
        }),
      ),
    ).toBe(
      'defineRootstockConfig: invariant id "lock-profile-single" must match [a-z0-9][a-z0-9.-]* and be unique',
    );
    const { lock: _l, ...noLock } = input({ ...LOCK_PROFILE, max: 3, maxCeiling: 3 });
    expect(defineRootstockConfig(noLock).invariants).toEqual([]);
  });
});
