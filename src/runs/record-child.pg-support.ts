import { openTestTransactor } from "../db/transactor.pg-support.ts";
import { lockDriver, openBunSqlClient, openPostgresJsClient } from "../lock/fixtures.pg-support.ts";
import {
  acquireRunLock,
  bunSqlLockSession,
  lockSlice,
  postgresJsLockSession,
} from "../lock/index.ts";
import { runsInput } from "./fixtures.test-support.ts";
import { startRun } from "./record.ts";
import { runsSlice } from "./slice.ts";

/**
 * RD4's child process (contract §13.3): in schema `argv[2]` it takes the
 * alpha-sync lock, starts a run, opens a batch transaction that writes one
 * quarantine row, prints `ready <run id>`, and waits to be killed (`kill -9`)
 * with the lock held, the run row running and the batch uncommitted.
 */

const schema = process.argv[2] ?? "";
const lock = lockSlice({
  table: { schema },
  profile: "lock",
  names: ["alpha-sync"],
  heartbeatSeconds: 5,
  probeStallSeconds: 10,
  maxRecoveries: 3,
  endTimeoutSeconds: 1,
  wait: { maxMs: 0, pollIntervalMs: 10 },
});
const runs = runsSlice(runsInput(), { schema });
const held = await acquireRunLock(
  () =>
    lockDriver() === "bun-sql"
      ? bunSqlLockSession(openBunSqlClient(), lock)
      : postgresJsLockSession(openPostgresJsClient(), lock),
  lock,
  "alpha-sync",
  {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    randomUUID: () => crypto.randomUUID(),
    sleep: (ms) => Bun.sleep(ms),
  },
);
const run = await startRun(
  openTestTransactor().transactor.sql,
  runs,
  { job: "alpha-sync", mode: "incremental", lock: held },
  { now: () => Date.now(), randomUUID: () => crypto.randomUUID() },
);
run.count("seen", 3);
const batch = openTestTransactor().transactor;
await batch.begin(async (tx) => {
  await tx.unsafe(
    `INSERT INTO "${schema}".quarantine (job, external_id, payload, reason, run_id)
     VALUES ('alpha-sync', 'child-batch', '{}'::jsonb, 'in flight', $1::uuid)`,
    [run.id],
  );
  process.stdout.write(`ready ${run.id}\n`);
  await new Promise(() => {});
});
