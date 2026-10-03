/**
 * A throwaway Postgres in Docker for DB-backed goldens: run-unique name,
 * Docker-assigned loopback port, removed on stop. Never point goldens at a
 * shared dev or prod database — this exists so they never need to.
 */
export interface ThrowawayPostgres {
  url: string;
  name: string;
  stop: () => Promise<void>;
}

let counter = 0;

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

export async function startThrowawayPostgres(
  opts: { image?: string; readyTimeoutMs?: number } = {},
): Promise<ThrowawayPostgres> {
  const image = opts.image ?? "pgvector/pgvector:pg17";
  const name = `rootstock-golden-pg-${process.pid}-${counter++}`;
  const started = await run([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_USER=golden",
    "-e",
    "POSTGRES_PASSWORD=golden",
    "-e",
    "POSTGRES_DB=golden",
    "-p",
    "127.0.0.1::5432",
    image,
  ]);
  if (started.code !== 0) {
    throw new Error(`startThrowawayPostgres: docker run failed: ${started.err}`);
  }
  const stop = async () => {
    await run(["stop", name]);
  };
  try {
    const port = await run(["port", name, "5432/tcp"]);
    const match = /:(\d+)\s*$/m.exec(port.out);
    if (port.code !== 0 || !match) {
      throw new Error(`startThrowawayPostgres: no port mapping (${port.err || port.out})`);
    }
    // TCP readiness inside the container: the init-phase server listens on
    // the unix socket only, so this passes only once the real server is up.
    const deadline = performance.now() + (opts.readyTimeoutMs ?? 60_000);
    for (;;) {
      const ready = await run(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "golden"]);
      if (ready.code === 0) break;
      if (performance.now() > deadline) {
        throw new Error("startThrowawayPostgres: not ready before timeout");
      }
      await Bun.sleep(250);
    }
    return {
      url: `postgres://golden:golden@127.0.0.1:${match[1]}/golden`,
      name,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
