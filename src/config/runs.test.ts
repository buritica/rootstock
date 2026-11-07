import { describe, expect, test } from "bun:test";
import { RUNS_INPUT } from "../runs/fixtures.test-support.ts";
import { type JobDeclInput, jobDecl, type RunsSlice, type RunsSliceInput } from "../runs/index.ts";
import { defineRootstockConfig } from "./compose.ts";
import type { RootstockConfigInput } from "./define.ts";
import { printRootstockConfig } from "./print.ts";

// R-D9 (contract §10.2–§10.3, §13.10 RC1–RC2, §20 A9): the runs slice in a
// config, its three built-in invariants, and its print.

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

type LockInput = NonNullable<RootstockConfigInput["lock"]>;

const LOCK: LockInput = {
  profile: "lock",
  names: ["alpha-sync", "shared-write", "delta:*"],
  heartbeatSeconds: 30,
  probeStallSeconds: 90,
  maxRecoveries: 5,
  endTimeoutSeconds: 5,
  wait: { maxMs: 30000, pollIntervalMs: 1000 },
};

const BUILT_IN = [
  "lock-profile-single",
  "runs-lock-table",
  "runs-job-locks",
  "runs-stale-heartbeat",
];

function input(
  over: { lock?: Partial<LockInput> | null; runs?: Partial<RunsSliceInput> } = {},
): RootstockConfigInput {
  return {
    client: { profiles: { lock: LOCK_PROFILE } },
    migrate: {},
    concurrency: { widths: { fetch: { default: 1, max: 1 } } },
    ...(over.lock === null ? {} : { lock: { ...LOCK, ...over.lock } }),
    runs: { ...RUNS_INPUT, ...over.runs },
  };
}

/** The one invariant failure `define` reports, without its prefix. */
function failure(i: RootstockConfigInput): string {
  try {
    defineRootstockConfig(i);
  } catch (err) {
    const message = (err as Error).message;
    const prefix = "defineRootstockConfig: 1 invariant(s) failed — ";
    expect(message.startsWith(prefix)).toBe(true);
    return message.slice(prefix.length);
  }
  throw new Error("expected a throw");
}

/** RUNS_INPUT's jobs with job `key`'s declaration changed by `over`. */
function withJob(key: string, over: Partial<JobDeclInput>): Partial<RunsSliceInput> {
  const job = RUNS_INPUT.jobs[key] as JobDeclInput;
  return { jobs: { ...RUNS_INPUT.jobs, [key]: { ...job, ...over } } };
}

/** RUNS_INPUT's jobs with job `key` given lock `lock`. */
const jobLock = (key: string, lock: string) => withJob(key, { lock });

describe("RC2: the runs built-in invariants", () => {
  test("RC2 they run after lock-profile-single and before the consumer's own, and hold", () => {
    const config = defineRootstockConfig({
      ...input(),
      invariants: [{ id: "app-own", check: () => null }],
    });
    expect(config.invariants).toEqual([...BUILT_IN, "app-own"]);
    // The composed slice is the parser's own, branded: runs functions take it.
    expect(jobDecl(config.runs as RunsSlice, "delta:one").key).toBe("delta:*");
  });

  test("RC2 a consumer invariant reusing a runs built-in id is refused as a duplicate", () => {
    expect(() =>
      defineRootstockConfig({
        ...input(),
        invariants: [{ id: "runs-job-locks", check: () => null }],
      }),
    ).toThrow('defineRootstockConfig: invariant id "runs-job-locks" must match');
  });

  test("RC2 runs-lock-table fails when runs.lockTable is not the lock slice's table", () => {
    expect(failure(input({ lock: { table: { schema: "ops", name: "locks_o" } } }))).toBe(
      "runs-lock-table: runs.lockTable rootstock.run_locks is not the lock slice's table ops.locks_o: running rows would be judged against the wrong fence",
    );
    // The same name in another schema is another table.
    expect(failure(input({ lock: { table: { schema: "ops" } } }))).toBe(
      "runs-lock-table: runs.lockTable rootstock.run_locks is not the lock slice's table ops.run_locks: running rows would be judged against the wrong fence",
    );
    expect(failure(input({ runs: { lockTable: { name: "locks_o" } } }))).toBe(
      "runs-lock-table: runs.lockTable rootstock.locks_o is not the lock slice's table rootstock.run_locks: running rows would be judged against the wrong fence",
    );
    // Both default from the migrate schema, and an explicit match holds.
    const moved = { table: { schema: "ops", name: "locks_o" } };
    expect(() =>
      defineRootstockConfig(input({ lock: moved, runs: { lockTable: moved.table } })),
    ).not.toThrow();
    expect(() =>
      defineRootstockConfig({ ...input(), migrate: { schema: "rs_t_0a1b2c3d" } }),
    ).not.toThrow();
  });

  test("RC2 runs-job-locks fails without a lock slice: a run needs a lock", () => {
    // runs-lock-table and runs-stale-heartbeat have nothing to compare, so hold.
    expect(failure(input({ lock: null }))).toBe(
      "runs-job-locks: jobs alpha-sync, beta-sync, gamma-push, delta:* have no lock slice to run under: a run needs a lock",
    );
    expect(defineRootstockConfig({ ...input(), runs: undefined }).invariants).toEqual([
      "lock-profile-single",
    ]);
  });

  test("RC2 an exact job lock is admitted by an exact entry or a family covering it", () => {
    expect(failure(input({ lock: { names: ["alpha-sync", "delta:*"] } }))).toBe(
      'runs-job-locks: jobs beta-sync (lock "shared-write"), gamma-push (lock "shared-write") run under locks the lock slice does not admit: acquireRunLock would refuse them',
    );
    const config = defineRootstockConfig(
      input({ lock: { names: ["alpha-*", "shared-*", "delta:*"] } }),
    );
    expect(config.lock?.names).toEqual(["alpha-*", "shared-*", "delta:*"]);
    // A family covers longer names only, as the lock slice's admits() reads it.
    expect(
      failure(
        input({
          runs: jobLock("alpha-sync", "alpha-"),
          lock: { names: ["alpha-*", "shared-write", "delta:*"] },
        }),
      ),
    ).toBe(
      'runs-job-locks: jobs alpha-sync (lock "alpha-") run under locks the lock slice does not admit: acquireRunLock would refuse them',
    );
  });

  test("RC2 a family job lock is admitted only by an equal family entry", () => {
    for (const names of [
      ["alpha-sync", "shared-write", "del*"],
      ["alpha-sync", "shared-write", "delta:one", "delta:two"],
      ["alpha-sync", "shared-write", "delta:o*"],
    ]) {
      expect(failure(input({ lock: { names } }))).toBe(
        'runs-job-locks: jobs delta:* (lock "delta:*" needs an equal family entry) run under locks the lock slice does not admit: acquireRunLock would refuse them',
      );
    }
    // A family job may also run every member under one exact lock.
    expect(() =>
      defineRootstockConfig(input({ runs: jobLock("delta:*", "shared-write") })),
    ).not.toThrow();
  });

  test("RC2 a family job's family lock must name every member's lock within 200 bytes", () => {
    const long = `${"l".repeat(188)}:*`; // prefix 189 + a 62-character suffix > 200
    const names = ["alpha-sync", "shared-write", long];
    expect(failure(input({ lock: { names }, runs: jobLock("delta:*", long) }))).toBe(
      `runs-job-locks: jobs delta:* (lock "${long}" cannot name every member's lock in 200 bytes) run under locks the lock slice does not admit: acquireRunLock would refuse them`,
    );
    // 138 + 62 = 200: the longest member's lock name just fits.
    const fits = `${"l".repeat(137)}:*`;
    expect(() =>
      defineRootstockConfig(
        input({
          lock: { names: ["alpha-sync", "shared-write", fits] },
          runs: jobLock("delta:*", fits),
        }),
      ),
    ).not.toThrow();
  });

  test("RC2 runs-stale-heartbeat holds staleHeartbeatSeconds at ≥ 2 × the lock's heartbeatSeconds (A9)", () => {
    expect(() =>
      defineRootstockConfig(input({ lock: { heartbeatSeconds: 60, probeStallSeconds: 90 } })),
    ).not.toThrow();
    const { jobs } = withJob("beta-sync", { staleHeartbeatSeconds: 122 });
    expect(
      failure(input({ lock: { heartbeatSeconds: 61, probeStallSeconds: 90 }, runs: { jobs } })),
    ).toBe(
      "runs-stale-heartbeat: jobs alpha-sync (120), gamma-push (120), delta:* (120) have staleHeartbeatSeconds below 122, twice the lock slice's heartbeatSeconds: a live run would read interrupted between two beats",
    );
  });

  test("RC2 every failing runs invariant is reported at once", () => {
    let message = "";
    try {
      defineRootstockConfig(
        input({
          lock: {
            names: ["alpha-sync"],
            heartbeatSeconds: 61,
            probeStallSeconds: 90,
            table: { name: "locks_o" },
          },
        }),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(
      message.startsWith("defineRootstockConfig: 3 invariant(s) failed — runs-lock-table: "),
    ).toBe(true);
    expect(message).toContain("; runs-job-locks: jobs beta-sync");
    expect(message).toContain("; runs-stale-heartbeat: jobs alpha-sync (120)");
  });

  test("RC2 a runs slice refusal reaches the caller unchanged, after the queue slice's", () => {
    expect(() => defineRootstockConfig(input({ runs: { maxCountKeys: 0 } }))).toThrow(
      /^runsSlice: maxCountKeys/,
    );
    expect(() =>
      defineRootstockConfig({
        ...input({ runs: { maxCountKeys: 0 } }),
        queue: { sources: [] } as never,
      }),
    ).toThrow(/^queueSlice: /);
  });
});

describe("RC1: the runs print", () => {
  test("RC1 the parsed slice, every field spelled out, tables as schema and name, prices as given", () => {
    const view = JSON.parse(printRootstockConfig(defineRootstockConfig(input())));
    expect(view.runs).toEqual({
      brakes: { "alpha-archive": { allowance: 50, armAt: 0, rounding: "ceil", share: 0.1 } },
      breakers: { "alpha-quota": { limit: 5 } },
      budgets: { "alpha-calls": { limit: 100, windowMinutes: 60 } },
      jobs: {
        "alpha-sync": {
          counters: { archived: "archived", written: "written" },
          interruptedGraceHours: 2,
          lock: "alpha-sync",
          maxAgeHours: 24,
          metered: true,
          modes: ["incremental", "backfill"],
          push: null,
          reconciles: true,
          spike: { allowance: 50, share: 0.1 },
          staleHeartbeatSeconds: 120,
        },
        "beta-sync": {
          counters: {},
          interruptedGraceHours: null,
          lock: "shared-write",
          maxAgeHours: null,
          metered: false,
          modes: ["incremental"],
          push: null,
          reconciles: false,
          spike: null,
          staleHeartbeatSeconds: 120,
        },
        "delta:*": {
          counters: {},
          interruptedGraceHours: null,
          lock: "delta:*",
          maxAgeHours: null,
          metered: false,
          modes: ["manual"],
          push: null,
          reconciles: true,
          spike: null,
          staleHeartbeatSeconds: 120,
        },
        "gamma-push": {
          counters: {},
          interruptedGraceHours: 1,
          lock: "shared-write",
          maxAgeHours: 6,
          metered: true,
          modes: ["push"],
          push: { heartbeat: true, maxAgeHours: 6 },
          reconciles: false,
          spike: null,
          staleHeartbeatSeconds: 120,
        },
      },
      lockTable: { name: "run_locks", schema: "rootstock" },
      maxCountKeys: 50,
      maxReasonChars: 500,
      maxScopeBytes: 65536,
      modes: ["incremental", "backfill", "push", "manual"],
      prices: {
        "model-a": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
        "model-b": { inputPerMTok: 1.25, outputPerMTok: 10 },
        "model-c": { inputPerMTok: 0.7, outputPerMTok: 0 },
      },
      quarantine: null,
      retention: { keepDays: 30 },
      table: { name: "runs", schema: "rootstock" },
    });
  });

  test("RC1 a declared quarantine table prints its table, columns and bounds", () => {
    const view = JSON.parse(
      printRootstockConfig(
        defineRootstockConfig(
          input({
            runs: {
              quarantine: {
                table: { name: "held_rows" },
                columns: { runId: null, externalId: "source_id" },
                maxPayloadBytes: 65_536,
                maxReasonChars: 500,
              },
            },
          }),
        ),
      ),
    );
    expect(view.runs.quarantine).toEqual({
      columns: {
        externalId: "source_id",
        failedAt: "failed_at",
        job: "job",
        payload: "payload",
        reason: "reason",
        resolvedAt: "resolved_at",
        runId: null,
        status: "status",
      },
      maxPayloadBytes: 65536,
      maxReasonChars: 500,
      table: { name: "held_rows", schema: "rootstock" },
    });
  });

  test("RC1 the print follows the migrate schema for every defaulted table", () => {
    const schema = "rs_t_0a1b2c3d";
    const view = JSON.parse(
      printRootstockConfig(defineRootstockConfig({ ...input(), migrate: { schema } })),
    );
    expect([view.runs.table.schema, view.runs.lockTable.schema]).toEqual([schema, schema]);
  });
});
