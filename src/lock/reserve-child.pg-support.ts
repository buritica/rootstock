import postgres from "postgres";

/**
 * X3's child process (contract §3.2): a postgres.js `pool.reserve()` handle
 * takes the try-lock, its backend is killed from a second client, and the next
 * query runs on the handle. Run as its own process so an uncaught driver error
 * cannot end the suite. It prints one line naming what the query did, and
 * exits 3 when the query never settled within the watchdog's window.
 */

const L1 = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid";
const WATCHDOG_MS = 3_000;

const url = process.env.ROOTSTOCK_TEST_DATABASE_URL ?? "";
const admin = postgres(url, { max: 1, onnotice: () => {} });
const pool = postgres(url, { max: 2, onnotice: () => {} });
const reserved = await pool.reserve();
const [row] = await reserved.unsafe(L1, ["alpha-sync"]);
const pid = Number(row?.pid);
await admin.unsafe("SELECT pg_terminate_backend($1)", [pid]);
for (;;) {
  const alive = await admin.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
  if (alive.length === 0) break;
  await Bun.sleep(10);
}
await admin.end();
setTimeout(() => {
  process.stdout.write("query never settled\n");
  process.exit(3);
}, WATCHDOG_MS);
try {
  await reserved.unsafe("SELECT pg_backend_pid() AS pid");
  process.stdout.write("query resolved\n");
  process.exit(0);
} catch (err) {
  process.stdout.write(`query rejected: ${(err as Error).message}\n`);
  process.exit(4);
}
