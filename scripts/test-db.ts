import { hostname } from "node:os";
import { SQL } from "bun";
import { TEST_TRANSACTOR_KINDS } from "../src/db/test-client.pg-support.ts";
import {
  GOLDEN_LABELS,
  startThrowawayPostgres,
  type ThrowawayPostgres,
} from "../src/golden/postgres.ts";

/**
 * The DB test matrix: every `src/**\/*.pg.ts` suite, once per transactor kind,
 * against each digest-pinned Postgres image, on the Bun running this script.
 *
 * Red, never empty: it fails when docker is missing, when no suite is found,
 * when a container will not start, when any run exits non-zero, and when any
 * run reports zero passing tests. Each run covers every suite at once, so the
 * zero-test check is per run, not per suite file.
 */

export const IMAGES = [
  "pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d",
  "pgvector/pgvector:pg18@sha256:2358fcba361ed2233a5ed81b5fe4ca779ccb304120ce531a3bf51c0ed7e2bc11",
] as const;

export const TRANSACTORS = TEST_TRANSACTOR_KINDS;

const ROOT = `${import.meta.dir}/..`;

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Every DB suite under `src/`, sorted, each with a `./` prefix: without it
 * `bun test` treats the argument as a name filter and runs nothing. Support
 * modules (`*.pg-support.ts`) never match, so they are never run as suites.
 */
export async function suitesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.pg.ts").scan({ cwd: root })) {
    found.push(`./${path}`);
  }
  return found.sort();
}

/**
 * How many tests a `bun test` run reports as passed, or 0 when it reports none.
 * Skipped and todo tests are not passes. The last summary wins, so a test that
 * prints a look-alike line cannot stand in for the real one.
 */
export function testsPassed(output: string): number {
  const counts = [...output.matchAll(/^\s*(\d+) pass$/gm)];
  const last = counts.at(-1);
  return last ? Number(last[1]) : 0;
}

async function dockerProblem(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return code === 0 ? null : err.trim() || `docker version exited ${code}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Echoes a stream as it arrives, so a hung suite still shows its progress, and keeps a copy. */
async function tee(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let all = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    process.stdout.write(text);
    all += text;
  }
  return all + decoder.decode();
}

/** What a signal handler must clean up: the live child, and whether a start is in flight. */
const live: { child: Bun.Subprocess | null; starting: boolean; exitCode: number | null } = {
  child: null,
  starting: false,
  exitCode: null,
};

async function runSuites(url: string, kind: string, suites: string[]): Promise<string | null> {
  // process.execPath, never "bun" from PATH: the oldest-Bun job must run its own Bun.
  const proc = Bun.spawn([process.execPath, "test", ...suites], {
    cwd: ROOT,
    env: { ...process.env, ROOTSTOCK_TEST_DATABASE_URL: url, ROOTSTOCK_TEST_TRANSACTOR: kind },
    stdout: "pipe",
    stderr: "pipe",
  });
  live.child = proc;
  const [stdout, stderr, code] = await Promise.all([
    tee(proc.stdout),
    tee(proc.stderr),
    proc.exited,
  ]);
  live.child = null;
  if (code !== 0) return `exited ${code}${proc.signalCode ? ` (${proc.signalCode})` : ""}`;
  if (testsPassed(stdout + stderr) === 0) return "reported 0 passing tests";
  return null;
}

/**
 * Removes every container this process started, found by the owner labels
 * every throwaway container carries (pid, host and process start together, so
 * another run on the same daemon is never touched).
 */
function removeOwnContainers(): void {
  const filters = [
    `${GOLDEN_LABELS.pid}=${process.pid}`,
    `${GOLDEN_LABELS.host}=${hostname()}`,
    `${GOLDEN_LABELS.ownerStart}=${Math.round(performance.timeOrigin)}`,
  ].flatMap((label) => ["--filter", `label=${label}`]);
  const listed = Bun.spawnSync(["docker", "ps", "-aq", ...filters], { timeout: 15_000 });
  const ids = listed.stdout
    .toString()
    .split("\n")
    .filter((id) => id !== "");
  if (ids.length > 0) Bun.spawnSync(["docker", "rm", "-f", ...ids], { timeout: 30_000 });
}

// A cancelled CI job or a Ctrl-C would otherwise kill the runner before its
// `finally`, leaving the container up (`--rm` only removes a stopped one) and
// the child suite running against it. A signal that lands while a container
// is starting waits for the start to settle, then sweeps, because the
// container does not exist yet when the signal arrives.
function onSignal(signal: "SIGINT" | "SIGTERM", code: number): void {
  out(`test:db: ${signal} — stopping the suite and removing this run's throwaway Postgres`);
  live.child?.kill();
  live.exitCode = code;
  if (live.starting) return;
  removeOwnContainers();
  process.exit(code);
}

async function startOrExit(image: string): Promise<ThrowawayPostgres> {
  live.starting = true;
  try {
    return await startThrowawayPostgres({ image });
  } finally {
    live.starting = false;
    if (live.exitCode !== null) {
      removeOwnContainers();
      process.exit(live.exitCode);
    }
  }
}

/**
 * A fresh database per transactor kind, so one kind never sees what another
 * left behind in the shared container.
 */
async function databaseFor(url: string, kind: string): Promise<string> {
  const name = `rs_${kind.replaceAll("-", "_")}`;
  const admin = new SQL({ url, max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
  const fresh = new URL(url);
  fresh.pathname = `/${name}`;
  return fresh.toString();
}

async function main(): Promise<number> {
  process.on("SIGINT", () => onSignal("SIGINT", 130));
  process.on("SIGTERM", () => onSignal("SIGTERM", 143));
  const problem = await dockerProblem();
  if (problem !== null) {
    out(
      `test:db: docker is not available — the DB matrix needs a running docker daemon (${problem})`,
    );
    return 1;
  }
  const suites = await suitesUnder(ROOT);
  if (suites.length === 0) {
    out("test:db: no src/**/*.pg.ts suite found — refusing to pass empty");
    return 1;
  }
  out(`test:db: Bun ${Bun.version}, suites: ${suites.join(" ")}`);
  const failures: string[] = [];
  for (const image of IMAGES) {
    const name = image.split("@")[0];
    out(`\ntest:db: starting ${image}`);
    let pg: ThrowawayPostgres;
    try {
      pg = await startOrExit(image);
    } catch (err) {
      const failure = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      out(`test:db: ${failure}`);
      failures.push(failure);
      continue;
    }
    try {
      for (const kind of TRANSACTORS) {
        out(`\n=== ${name} · ${kind} ===`);
        const failure = await runSuites(await databaseFor(pg.url, kind), kind, suites);
        if (failure !== null) failures.push(`${name} · ${kind}: ${failure}`);
      }
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await pg.stop();
    }
  }
  if (failures.length > 0) {
    out(`\ntest:db: FAILED\n${failures.map((f) => `  ${f}`).join("\n")}`);
    return 1;
  }
  out(`\ntest:db: ${IMAGES.length * TRANSACTORS.length} runs passed`);
  return 0;
}

if (import.meta.main) process.exit(await main());
