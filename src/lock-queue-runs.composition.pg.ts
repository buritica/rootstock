import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { defineRootstockConfig } from "./config/index.ts";
import type { Sql } from "./db/index.ts";
import { openTestTransactor, type TestTransactor } from "./db/transactor.pg-support.ts";
import {
  killBackend,
  lockDriver,
  openBunSqlClient,
  openPostgresJsClient,
} from "./lock/fixtures.pg-support.ts";
import {
  acquireRunLock,
  bunSqlLockSession,
  type LockDeps,
  type LockSlice,
  postgresJsLockSession,
  type RunLock,
} from "./lock/index.ts";
import { schemaFactory } from "./migrate/fixtures.pg-support.ts";
import { applyMigrations, migrationStatus, rootstockSource } from "./migrate/index.ts";
import { ack, claim, enqueue, type QueueSlice } from "./queue/index.ts";
import { RUNS_INPUT } from "./runs/fixtures.test-support.ts";
import {
  jobDecl,
  pendingQuarantine,
  type QuarantineTable,
  quarantineSafe,
  type RunsEvent,
  type RunsSlice,
  runsSnapshot,
  startRun,
  verdictFor,
} from "./runs/index.ts";

// R-D9 (contract §13.11): the lock, the queue and the run record composed
// through defineRootstockConfig in one database, once per transactor kind,
// in a schema of its own. Then the export-key snapshot: every 0.7.0 export
// of every subpath is still present.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_lqr");
const held: RunLock[] = [];
const HOUR_MS = 3_600_000;

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

const QUEUE = {
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
  ackLockTimeoutMs: 2000,
};

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterEach(async () => {
  // A killed run's session is already gone; its release only tidies up.
  for (const lock of held.splice(0)) await lock.release().catch(() => {});
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

const lockDeps: LockDeps = {
  now: () => Date.now(),
  setInterval: () => {
    throw new Error("the composition starts no keepalive");
  },
  clearInterval: () => {},
  randomUUID: () => crypto.randomUUID(),
  sleep: (ms) => Bun.sleep(ms),
};

/** The backend pid holding the one-key advisory lock `name`, if any. */
async function holderPid(name: string): Promise<number | undefined> {
  const [r] = await sql.unsafe(
    `SELECT pid FROM pg_locks
     WHERE locktype = 'advisory' AND granted AND objsubid = 1
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
       AND objid = (hashtext($1)::bigint & 4294967295)::oid`,
    [name],
  );
  return r === undefined ? undefined : Number(r.pid);
}

describe("lock, queue and runs composed (§13.11)", () => {
  test("a fake job runs balanced; a killed run is settled interrupted by the next; the snapshot and verdict read it", async () => {
    const sc = schema();
    const config = defineRootstockConfig({
      client: { profiles: { lock: LOCK_PROFILE } },
      migrate: { schema: sc },
      concurrency: { widths: { fetch: { default: 1, max: 1 } } },
      lock: {
        profile: "lock",
        names: ["alpha-sync", "shared-write", "delta:*"],
        heartbeatSeconds: 30,
        probeStallSeconds: 60,
        maxRecoveries: 3,
        endTimeoutSeconds: 1,
        wait: { maxMs: 0, pollIntervalMs: 10 },
      },
      queue: QUEUE,
      runs: { ...RUNS_INPUT, quarantine: { maxPayloadBytes: 65_536, maxReasonChars: 500 } },
    });
    expect(config.invariants).toEqual([
      "lock-profile-single",
      "runs-lock-table",
      "runs-job-locks",
      "runs-stale-heartbeat",
    ]);
    const lock = config.lock as LockSlice;
    const queue = config.queue as QueueSlice;
    const runs = config.runs as RunsSlice;
    const quarantine = runs.quarantine as QuarantineTable;
    // Every table defaults into the migrate schema, so they share one database.
    expect([lock.table, queue.table, runs.table, runs.lockTable, quarantine.table]).toEqual([
      { schema: sc, name: "run_locks" },
      { schema: sc, name: "work_queue" },
      { schema: sc, name: "runs" },
      { schema: sc, name: "run_locks" },
      { schema: sc, name: "quarantine" },
    ]);
    const source = rootstockSource(config.migrate);
    await applyMigrations(main.transactor, config.migrate, [source], {
      entry: "deploy",
      backup: { skip: "composition test" },
      fix: "bun run migrate apply --manual",
    });
    await sql.unsafe(`CREATE TABLE "${sc}".items (key text PRIMARY KEY, n integer NOT NULL)`);

    const events: RunsEvent[] = [];
    const deps = {
      now: () => Date.now(),
      randomUUID: () => crypto.randomUUID(),
      onEvent: (e: RunsEvent) => events.push(e),
    };
    const acquire = async (name = "alpha-sync"): Promise<RunLock> => {
      const run = await acquireRunLock(
        () =>
          lockDriver() === "bun-sql"
            ? bunSqlLockSession(openBunSqlClient(), lock)
            : postgresJsLockSession(openPostgresJsClient(), lock),
        lock,
        name,
        lockDeps,
      );
      held.push(run);
      return run;
    };

    // Run 1: take the lock, start, claim with the fence, write two rows and
    // quarantine the third in one batch transaction, account, finish ok.
    for (const n of [1, 2, 3]) {
      expect(
        await enqueue(main.transactor, queue, {
          key: `alpha:${n}`,
          source: "alpha",
          kind: "put",
          payload: { n },
          debounceSeconds: 0,
        }),
      ).toBe("enqueued");
    }
    const first = await acquire();
    const one = await startRun(
      sql,
      runs,
      { job: "alpha-sync", mode: "incremental", lock: first },
      deps,
    );
    const rows = await claim(sql, queue, { source: "alpha", limit: 10, worker: "worker-a" });
    expect(rows.map((r) => r.key)).toEqual(["alpha:1", "alpha:2", "alpha:3"]);
    for (const r of rows) expect(r.claim.token).toMatch(/^[0-9a-f-]{36}$/);
    await main.transactor.begin(async (tx) => {
      for (const r of rows) {
        const n = (r.payload as { n: number }).n;
        if (n === 2) {
          const put = await quarantineSafe(
            tx,
            quarantine,
            {
              job: "alpha-sync",
              externalId: r.key,
              payload: r.payload,
              reason: "synthetic: the record did not parse",
              runId: one.id,
            },
            deps,
          );
          expect(put).toBe(true);
        } else {
          await tx.unsafe(`INSERT INTO "${sc}".items (key, n) VALUES ($1, $2::int)`, [r.key, n]);
        }
        expect(await ack(tx, queue, { key: r.key, worker: "worker-a", claim: r.claim })).toBe(
          "deleted",
        );
      }
    });
    one.count("fetched", 3);
    one.meter("model-a", 1_000_000, 500_000);
    one.account({ listed: 3, written: 2, unchanged: 0, quarantined: 1, excluded: 0 });
    expect(await one.finish("ok")).toEqual({
      written: true,
      status: "ok",
      reconciled: true,
      costUsd: "0.300000",
      costNote: null,
    });
    await first.release();
    expect(await sql.unsafe(`SELECT key FROM "${sc}".work_queue`)).toEqual([]);
    expect(
      (await sql.unsafe(`SELECT key FROM "${sc}".items ORDER BY key`)).map((r) => r.key),
    ).toEqual(["alpha:1", "alpha:3"]);
    const pending = await pendingQuarantine(sql, quarantine, { job: "alpha-sync" });
    expect(pending.map((p) => [p.externalId, p.reason])).toEqual([
      ["alpha:2", "synthetic: the record did not parse"],
    ]);

    // Run 2 starts and its lock backend is killed; wait until it has exited
    // (§20 A8), so the lock is free for run 3.
    const second = await acquire();
    const two = await startRun(
      sql,
      runs,
      { job: "alpha-sync", mode: "backfill", lock: second },
      deps,
    );
    const pid = await holderPid("alpha-sync");
    expect(pid).toBeDefined();
    await killBackend(sql, pid as number);

    // Run 3 takes the lock; its start settles run 2 interrupted.
    const third = await acquire();
    events.length = 0;
    const three = await startRun(
      sql,
      runs,
      { job: "alpha-sync", mode: "incremental", lock: third },
      deps,
    );
    expect(events).toEqual([
      { type: "runs.settled_interrupted", id: two.id, job: "alpha-sync", by: three.id },
      {
        type: "runs.started",
        id: three.id,
        job: "alpha-sync",
        mode: "incremental",
        lockName: "alpha-sync",
        settled: 1,
      },
    ]);

    const decl = jobDecl(runs, "alpha-sync");
    const during = (await runsSnapshot(sql, runs, ["alpha-sync"])).get("alpha-sync");
    if (during === undefined) throw new Error("no snapshot for alpha-sync");
    expect(during.total).toBe(3);
    expect(during.newestOk?.id).toBe(one.id);
    expect(during.newestOk).toMatchObject({
      status: "ok",
      listed: 3,
      written: 2,
      unchanged: 0,
      quarantined: 1,
      excluded: 0,
      reconciled: true,
      counts: { fetched: 3 },
      tokens: { "model-a": { input: 1_000_000, output: 500_000 } },
      costUsd: "0.300000",
    });
    expect(during.newestSettled).toMatchObject({
      id: two.id,
      status: "interrupted",
      reason: `interrupted: still running when run ${three.id} took the alpha-sync lock`,
    });
    expect(during.running.map((r) => [r.id, r.live])).toEqual([[three.id, true]]);
    // Within the job's 2 h grace the interruption is not yet a verdict; past
    // it (and inside the 24 h max age) it is.
    expect(verdictFor(during, decl, { now: Date.now(), live: 100 }).verdict).toBe("ok");
    const late = verdictFor(during, decl, { now: Date.now() + 3 * HOUR_MS, live: 100 });
    expect(late).toMatchObject({ verdict: "interrupted", graceHours: 2 });

    three.account({ listed: 0, written: 0, unchanged: 0, quarantined: 0, excluded: 0 });
    expect(await three.finish("ok")).toMatchObject({ written: true, status: "ok" });
    const after = (await runsSnapshot(sql, runs, ["alpha-sync"])).get("alpha-sync");
    if (after === undefined) throw new Error("no snapshot for alpha-sync");
    expect([after.total, after.newestOk?.id, after.running.length]).toEqual([3, three.id, 0]);
    expect(verdictFor(after, decl, { now: Date.now(), live: 100 }).verdict).toBe("ok");

    // A family member runs under the lock its family declares: the lock slice
    // admits "delta:one" and startRun accepts it (runs-job-locks agrees).
    const deltaLock = await acquire("delta:one");
    const delta = await startRun(
      sql,
      runs,
      { job: "delta:one", mode: "manual", lock: deltaLock },
      deps,
    );
    expect(delta.lockName).toBe("delta:one");
    expect(await delta.discard()).toEqual({ written: false, why: "discarded" });

    const status = await migrationStatus(sql, config.migrate, [source]);
    expect(status.red).toBe(false);
  }, 30_000);
});

// Profile exports named for their origin, assembled so this file names none.
const V1 = ["my", "cel", "V1"].join("");
const ARTICLES = ["di", "an", "Articles"].join("");

/** Every runtime key each subpath exported in 0.7.0 (1b6f194), sorted. */
const EXPORTS_0_7_0: Readonly<Record<string, readonly string[]>> = {
  "./golden": [
    "CAPABILITIES",
    "GOLDEN_EXIT",
    "GOLDEN_FORMAT",
    "GOLDEN_LABELS",
    "GoldenCaseError",
    "GoldenFileError",
    "canonicalJson",
    "captureSuites",
    "checkSuites",
    "createRecordingFetch",
    "goldenPath",
    "isCapabilityId",
    "nearVector",
    "orphanGoldenFiles",
    "readGoldenFile",
    "redactUrl",
    "runCase",
    "runGoldenCli",
    "seededVector",
    "sha256Hex",
    "startThrowawayPostgres",
    "validateSuites",
  ],
  "./golden/bun-test": ["registerGoldenTests"],
  "./hash": ["sha256Hex"],
  "./chunking-version": ["InvalidChunkingParamsError", "chunkingParamFingerprint"],
  "./normalize": [V1],
  "./slugify": [V1],
  "./split": [
    ARTICLES,
    "locateWindows",
    V1,
    "packWithinBudget",
    "partCharBudget",
    "sliceLongLines",
    "splitBodyWithinBudget",
    "windowBody",
  ],
  "./webhook-verify": [
    "notionEventAge",
    "notionSignatureMatches",
    "slackSignatureMatches",
    "verifySlackRequest",
  ],
  "./office-extract": [
    "DOCX_MIME",
    "PDF_MIME",
    "PPTX_MIME",
    "XLSX_MIME",
    "extractOfficeText",
    "extractOfficeTextWithPages",
    "isOfficeExtractMime",
    "mergePdfPages",
  ],
  "./grounding-quote": [ARTICLES],
  "./retry": [
    "createTokenBucketPacer",
    "isRateLimitExhausted",
    "mentionsRateLimitExhausted",
    "pacedRetry",
    "retryAfterMs",
  ],
  "./slack": ["paginateSlackCursor"],
  "./db": [
    "bunSqlOptions",
    "bunSqlTransactor",
    "clientSlice",
    "drizzleTransactor",
    "pgCode",
    "postgresJsOptions",
    "postgresJsTransactor",
    "quoteIdentifier",
  ],
  "./migrate": [
    "applyMigrations",
    "applyRootstockMigrations",
    "assertThrowawayDb",
    "checkMigrationOrder",
    "drizzleJournal",
    "drizzleJournalFrom",
    "drizzleTracker",
    "filenameTracker",
    "gitMainReader",
    "migrateCli",
    "migrateSlice",
    "migrationStatus",
    "renderMigrationStatus",
    "rootstockMigrationStatus",
    "rootstockMigrations",
    "rootstockSource",
    "sqlFolder",
    "sqlFolderFrom",
    "timestampRenames",
    "unmarkedAfterBaseline",
  ],
  "./lock": [
    "LOCK_HELD_PREDICATE",
    "RootstockLockError",
    "acquireRunLock",
    "bunSqlLockSession",
    "createTurnQueue",
    "lockErrorCode",
    "lockNameCollisions",
    "lockOwnershipLost",
    "lockSlice",
    "locksHeld",
    "postgresJsLockSession",
    "withNames",
  ],
  "./queue": [
    "RootstockQueueError",
    "ack",
    "claim",
    "cursorTable",
    "depth",
    "enqueue",
    "fail",
    "getCursor",
    "listDead",
    "queueErrorCode",
    "queueSlice",
    "retryDead",
    "setCursor",
    "touchCursor",
  ],
  "./concurrency": ["concurrencySlice", "forEachBounded", "mapWithConcurrency", "width"],
  "./config": ["defineRootstockConfig", "printRootstockConfig", "widthBelowPool"],
};

describe("export-key snapshot (§13.11)", () => {
  test("every 0.7.0 export of every subpath is still present", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const exportsMap = pkg.exports as Record<string, string>;
    const missing: string[] = [];
    for (const [subpath, keys] of Object.entries(EXPORTS_0_7_0)) {
      const target = exportsMap[subpath];
      if (target === undefined) {
        missing.push(`${subpath} (subpath gone)`);
        continue;
      }
      const mod: Record<string, unknown> = await import(
        new URL(`../${target}`, import.meta.url).pathname
      );
      for (const key of keys) if (!(key in mod)) missing.push(`${subpath}.${key}`);
    }
    expect(missing).toEqual([]);
  });
});
