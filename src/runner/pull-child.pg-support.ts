import { openTestTransactor } from "../db/transactor.pg-support.ts";
import { memSource, type Rec, runnerEnvOf } from "./fixtures.pg-support.ts";
import { runPull } from "./pull.ts";

/**
 * RD5's child process (contract §9, §14 F9, F22): in schema `argv[2]` it
 * takes the alpha-sync lock and runs a pull of r1..r4 in batches of two.
 * Batch 1 commits; inside batch 2's transaction the load of r3 parks in JS,
 * so the backend sits idle in the transaction, and the child prints
 * `ready <run id>` and waits to be killed (`kill -9`).
 */

const sc = process.argv[2] ?? "";
const { transactor } = openTestTransactor();
const env = runnerEnvOf(sc, []);
const recs: Rec[] = ["r1", "r2", "r3", "r4"].map((id) => ({ id, hash: `h-${id}` }));
const src = memSource(env, transactor, recs, { fromCursor: "exclusive" });
src.beforeLoad = async (id) => {
  if (id !== "r3") return;
  const started = env.events.find((e) => e.type === "runner.pull_started") as { runId: string };
  process.stdout.write(`ready ${started.runId}\n`);
  await new Promise(() => {});
};
const lock = await env.acquire("alpha-sync");
await runPull(
  {
    tx: transactor,
    runs: env.runs,
    quarantine: env.quarantine,
    cursors: env.cursors,
    source: src,
    mode: "incremental",
    lock,
    batchSize: 2,
    fetchConcurrency: 1,
  },
  env.deps,
);
