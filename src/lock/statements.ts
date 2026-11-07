import { quoteTable } from "../internal/slice.ts";

/**
 * Every statement the lock sends, frozen text, built once per table. The
 * advisory key is `hashtext(name)`, one-argument form, so a lock taken here
 * and one taken by `pg_try_advisory_lock(hashtext(name))` elsewhere exclude
 * each other. No statement carries a comment or a `$` outside a placeholder.
 */

/** L1 try-lock, params [name]. */
export const L1 = "SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid";

/** L3 probe: this backend's pid and how many advisory locks it holds. No params. */
export const L3 = `SELECT pg_backend_pid() AS pid,
       (SELECT count(*)::int FROM pg_locks l
         WHERE l.pid = pg_backend_pid() AND l.locktype = 'advisory' AND l.granted) AS held`;

/** L6 unlock, params [name]. */
export const L6 = "SELECT pg_advisory_unlock(hashtext($1))";

/**
 * The pg_locks test for "some session in this database holds the one-key
 * advisory lock hashtext($1)", for a consumer that embeds it in its own SQL.
 * `objsubid = 1` is the one-key form; `database =` keeps a lock of the same
 * key in another database on the server from reading as held.
 */
export const LOCK_HELD_PREDICATE = `EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory'
    AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND objsubid = 1
    AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
    AND objid = (hashtext($1)::bigint & 4294967295)::oid
)`;

/** L7 probe many, params [JSON.stringify(names)]. */
export const L7 = `SELECT n AS name, ${LOCK_HELD_PREDICATE.replaceAll("$1", "n")} AS held
FROM jsonb_array_elements_text($1::text::jsonb) AS n`;

/** L8 collisions, params [JSON.stringify(names)]. */
export const L8 = `SELECT a.n AS a, b.n AS b
FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS a(n, i)
JOIN jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS b(n, i)
  ON a.i < b.i AND a.n <> b.n AND hashtext(a.n) = hashtext(b.n)
ORDER BY a.i, b.i`;

export interface TableStatements {
  /** L2 fence, params [name, holder]. */
  readonly fence: string;
  /** L4 recovery claim, params [name]. */
  readonly claim: string;
  /** L5 heartbeat, params [name, holder]. */
  readonly heartbeat: string;
}

/** The statements that name the fencing table, for `<schema>.<name>`. */
export function tableStatements(table: { schema: string; name: string }): TableStatements {
  const t = quoteTable(table);
  return Object.freeze({
    fence: `INSERT INTO ${t} (name, holder, acquired_at, heartbeat_at)
VALUES ($1, $2::uuid, now(), now())
ON CONFLICT (name) DO UPDATE SET holder = $2::uuid, acquired_at = now(), heartbeat_at = now()
RETURNING pg_backend_pid() AS pid`,
    claim: `SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid,
       (SELECT holder::text FROM ${t} WHERE name = $1) AS holder`,
    heartbeat: `UPDATE ${t} SET heartbeat_at = now() WHERE name = $1 AND holder = $2::uuid`,
  });
}
