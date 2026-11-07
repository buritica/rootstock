import { SQL } from "bun";
import postgres from "postgres";

/**
 * H2's child process (contract §14): it takes the advisory lock, fences, and
 * inserts a running row through R1's insert, then prints one JSON line with
 * its backend pid and idles until it is killed. Run as its own process so the
 * parent can `kill -9` it. Arguments: driver (`postgres-js` | `bun-sql`),
 * schema, lock name, holder uuid, run id.
 */

const [driver, schema, name, holder, id] = process.argv.slice(2);
const url = process.env.ROOTSTOCK_TEST_DATABASE_URL ?? "";

type Unsafe = (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
let unsafe: Unsafe;
if (driver === "bun-sql") {
  const c = new SQL({ url, max: 1 });
  unsafe = async (q, p) => (await c.unsafe(q, p)) as Record<string, unknown>[];
} else {
  const c = postgres(url, { max: 1, onnotice: () => {} });
  unsafe = async (q, p) =>
    (await c.unsafe(q, p as never[])) as unknown as Record<string, unknown>[];
}

const [locked] = await unsafe(
  "SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid",
  [name],
);
await unsafe(
  `INSERT INTO "${schema}".run_locks (name, holder, acquired_at, heartbeat_at)
VALUES ($1, $2::uuid, now(), now())
ON CONFLICT (name) DO UPDATE SET holder = $2::uuid, acquired_at = now(), heartbeat_at = now()`,
  [name, holder],
);
await unsafe(
  `INSERT INTO "${schema}".runs (id, job, mode, status, lock_name, holder, started_at)
VALUES ($1::uuid, 'alpha-sync', 'incremental', 'running', $2::text, $3::uuid, clock_timestamp())`,
  [id, name, holder],
);
process.stdout.write(`${JSON.stringify({ locked: locked?.locked, pid: Number(locked?.pid) })}\n`);
setInterval(() => {}, 60_000);
