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

async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function runSuites(url: string, kind: string, suites: string[]): Promise<string | null> {
  // process.execPath, never "bun" from PATH: the oldest-Bun job must run its own Bun.
  const proc = Bun.spawn([process.execPath, "test", ...suites], {
    cwd: ROOT,
    env: { ...process.env, ROOTSTOCK_TEST_DATABASE_URL: url, ROOTSTOCK_TEST_TRANSACTOR: kind },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout + stderr;
  out(output);
  if (code !== 0) return `exited ${code}`;
  if (testsPassed(output) === 0) return "reported 0 passing tests";
  return null;
}

// A cancelled CI job or a Ctrl-C would otherwise kill the runner before its
// `finally`, leaving a container up (`--rm` only removes a stopped one). The
// signal can land mid-start, before any handle exists, so the sweep goes by
// the owner-pid label every throwaway container carries.
function removeOwnContainers(): void {
  const label = `${GOLDEN_LABELS.pid}=${process.pid}`;
  const ids = Bun.spawnSync(["docker", "ps", "-aq", "--filter", `label=${label}`])
    .stdout.toString()
    .split("\n")
    .filter((id) => id !== "");
  if (ids.length > 0) Bun.spawnSync(["docker", "rm", "-f", ...ids]);
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    out(`test:db: ${signal} — removing this run's throwaway Postgres`);
    removeOwnContainers();
    process.exit(code);
  });
}

async function main(): Promise<number> {
  if (!(await dockerAvailable())) {
    out("test:db: docker is not available — the DB matrix needs a running docker daemon");
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
    let pg: ThrowawayPostgres;
    try {
      pg = await startThrowawayPostgres({ image });
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      for (const kind of TRANSACTORS) {
        out(`\n=== ${name} · ${kind} ===`);
        const failure = await runSuites(pg.url, kind, suites);
        if (failure !== null) failures.push(`${name} · ${kind}: ${failure}`);
      }
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
