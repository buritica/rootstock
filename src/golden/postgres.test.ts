import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { GOLDEN_LABELS, startThrowawayPostgres } from "./postgres.ts";

// A stand-in `docker` records every call and answers per subcommand, so the
// container lifecycle is tested without a daemon. Bun resolves a spawned
// command against the PATH the process started with, so each scenario runs in
// a child process whose PATH puts the stand-in first.

const POSTGRES = join(import.meta.dir, "postgres.ts");

interface Scenario {
  /** Exit codes for `docker stop` and `docker port`; 0 when omitted. */
  codes?: { stop?: number; port?: number };
  /** Child script body; `start` is startThrowawayPostgres and `report(value)` prints the result. */
  body: string;
}

async function runScenario({ codes = {}, body }: Scenario): Promise<{
  result: Record<string, unknown>;
  calls: string[][];
}> {
  const dir = await mkdtemp(join(tmpdir(), "golden-docker-"));
  const log = join(dir, "calls.log");
  await writeFile(log, "");
  await writeFile(
    join(dir, "docker"),
    `#!/bin/sh
printf '%s\\n' "$@" '--end--' >> '${log}'
case "$1" in
  run) echo 0123456789ab ;;
  port) if [ ${codes.port ?? 0} -eq 0 ]; then echo 127.0.0.1:55432; else echo 'no such container' >&2; exit ${codes.port}; fi ;;
  stop) exit ${codes.stop ?? 0} ;;
esac
exit 0
`,
  );
  await chmod(join(dir, "docker"), 0o755);
  const script = join(dir, "scenario.ts");
  await writeFile(
    script,
    `import { hostname } from "node:os";
import { startThrowawayPostgres as start } from ${JSON.stringify(POSTGRES)};
const report = (value: Record<string, unknown>) =>
  process.stdout.write(JSON.stringify({ pid: process.pid, host: hostname(), ownerStart: Math.round(performance.timeOrigin), ...value }));
${body}
`,
  );
  const proc = Bun.spawnSync([process.execPath, script], {
    env: { ...Bun.env, PATH: `${dir}:${Bun.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.stderr.toString()).toBe("");
  const calls: string[][] = [];
  let current: string[] = [];
  for (const line of (await readFile(log, "utf8")).split("\n")) {
    if (line === "--end--") {
      calls.push(current);
      current = [];
    } else if (line !== "") {
      current.push(line);
    }
  }
  return { result: JSON.parse(proc.stdout.toString()), calls };
}

describe("startThrowawayPostgres with a stand-in docker", () => {
  test("docker run carries all four labels; stop is a plain docker stop", async () => {
    const { result, calls } = await runScenario({
      body: `const pg = await start({ image: "example/pg:1" });
await pg.stop();
report({ name: pg.name, url: pg.url });`,
    });
    const name = String(result.name);
    expect(name).toBe(`rootstock-golden-pg-${result.pid}-0`);
    expect(result.url).toBe("postgres://golden:golden@127.0.0.1:55432/golden");
    expect(result.host).toBe(hostname());
    expect(calls).toEqual([
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "--label",
        "rootstock.golden=1",
        "--label",
        `rootstock.golden.pid=${result.pid}`,
        "--label",
        `rootstock.golden.host=${result.host}`,
        "--label",
        `rootstock.golden.owner-start=${result.ownerStart}`,
        "-e",
        "POSTGRES_USER=golden",
        "-e",
        "POSTGRES_PASSWORD=golden",
        "-e",
        "POSTGRES_DB=golden",
        "-p",
        "127.0.0.1::5432",
        "example/pg:1",
      ],
      ["port", name, "5432/tcp"],
      ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "golden"],
      ["stop", name],
    ]);
  });

  test("a failed docker stop falls back to docker rm -f, and stop still resolves", async () => {
    const { result, calls } = await runScenario({
      codes: { stop: 1 },
      body: `const pg = await start();
report({ name: pg.name, stopped: await pg.stop() });`,
    });
    expect(result.stopped).toBeUndefined();
    expect(calls.slice(-2)).toEqual([
      ["stop", String(result.name)],
      ["rm", "-f", String(result.name)],
    ]);
  });

  test("a setup failure after docker run removes the container before rejecting", async () => {
    const { result, calls } = await runScenario({
      codes: { port: 1, stop: 1 },
      body: `report({ error: await start().then(() => "resolved", (err) => err.message) });`,
    });
    expect(result.error).toBe("startThrowawayPostgres: no port mapping (no such container)");
    const name = `rootstock-golden-pg-${result.pid}-0`;
    expect(calls.slice(1)).toEqual([
      ["port", name, "5432/tcp"],
      ["stop", name],
      ["rm", "-f", name],
    ]);
  });

  test("names count up within a process", async () => {
    const { result } = await runScenario({
      body: `const a = await start();
const b = await start();
report({ names: [a.name, b.name] });`,
    });
    expect(result.names).toEqual([
      `rootstock-golden-pg-${result.pid}-0`,
      `rootstock-golden-pg-${result.pid}-1`,
    ]);
  });
});

// Needs a Docker daemon and the default image; run with ROOTSTOCK_DOCKER_TESTS=1.
test.if(Bun.env.ROOTSTOCK_DOCKER_TESTS === "1")(
  "labels on a real container",
  async () => {
    const pg = await startThrowawayPostgres();
    try {
      const inspect = Bun.spawnSync(
        ["docker", "inspect", "--format", "{{json .Config.Labels}}", pg.name],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(inspect.exitCode).toBe(0);
      const labels = JSON.parse(inspect.stdout.toString()) as Record<string, string>;
      expect({
        marker: labels[GOLDEN_LABELS.marker],
        pid: labels[GOLDEN_LABELS.pid],
        host: labels[GOLDEN_LABELS.host],
        ownerStart: labels[GOLDEN_LABELS.ownerStart],
      }).toEqual({
        marker: "1",
        pid: String(process.pid),
        host: hostname(),
        ownerStart: String(Math.round(performance.timeOrigin)),
      });
    } finally {
      await pg.stop();
    }
    // `--rm` removes the container shortly after `docker stop` returns.
    const listed = () =>
      Bun.spawnSync(["docker", "ps", "-a", "--quiet", "--filter", `name=^${pg.name}$`], {
        stdout: "pipe",
      })
        .stdout.toString()
        .trim();
    const deadline = performance.now() + 20_000;
    while (listed() !== "" && performance.now() < deadline) await Bun.sleep(250);
    expect(listed()).toBe("");
  },
  120_000,
);
