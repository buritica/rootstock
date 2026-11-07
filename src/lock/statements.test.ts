import { describe, expect, test } from "bun:test";
import { L1, L3, L6, L7, L8, LOCK_HELD_PREDICATE, tableStatements } from "./statements.ts";

/** The contract's §2.4 texts, copied by hand, for `rootstock.run_locks`. */
const T = `"rootstock"."run_locks"`;
const PREDICATE = `EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory'
    AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND objsubid = 1
    AND classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
    AND objid = (hashtext($1)::bigint & 4294967295)::oid
)`;

describe("lock statements", () => {
  test("LOCK_HELD_PREDICATE is the frozen text byte for byte", () => {
    expect(LOCK_HELD_PREDICATE).toBe(PREDICATE);
    expect(LOCK_HELD_PREDICATE.endsWith("\n")).toBe(false);
  });

  test("L1, L3, L6 are the frozen texts", () => {
    expect(L1).toBe("SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid");
    expect(L3).toBe(`SELECT pg_backend_pid() AS pid,
       (SELECT count(*)::int FROM pg_locks l
         WHERE l.pid = pg_backend_pid() AND l.locktype = 'advisory' AND l.granted) AS held`);
    expect(L6).toBe("SELECT pg_advisory_unlock(hashtext($1))");
  });

  test("L7 and L8 are the frozen texts", () => {
    expect(L7).toBe(`SELECT n AS name, EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory'
    AND granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND objsubid = 1
    AND classid = ((hashtext(n)::bigint >> 32) & 4294967295)::oid
    AND objid = (hashtext(n)::bigint & 4294967295)::oid
) AS held
FROM jsonb_array_elements_text($1::text::jsonb) AS n`);
    expect(L8).toBe(`SELECT a.n AS a, b.n AS b
FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS a(n, i)
JOIN jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS b(n, i)
  ON a.i < b.i AND a.n <> b.n AND hashtext(a.n) = hashtext(b.n)
ORDER BY a.i, b.i`);
  });

  test("L2, L4, L5 name the table quoted", () => {
    const s = tableStatements({ schema: "rootstock", name: "run_locks" });
    expect(s.fence).toBe(`INSERT INTO ${T} (name, holder, acquired_at, heartbeat_at)
VALUES ($1, $2::uuid, now(), now())
ON CONFLICT (name) DO UPDATE SET holder = $2::uuid, acquired_at = now(), heartbeat_at = now()
RETURNING pg_backend_pid() AS pid`);
    expect(
      s.claim,
    ).toBe(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked, pg_backend_pid() AS pid,
       (SELECT holder::text FROM ${T} WHERE name = $1) AS holder`);
    expect(s.heartbeat).toBe(
      `UPDATE ${T} SET heartbeat_at = now() WHERE name = $1 AND holder = $2::uuid`,
    );
    expect(Object.isFrozen(s)).toBe(true);
  });

  test("no statement carries a comment or a stray dollar", () => {
    const s = tableStatements({ schema: "a", name: "b" });
    for (const text of [L1, L3, L6, L7, L8, s.fence, s.claim, s.heartbeat]) {
      expect(text).not.toContain("--");
      expect(text.replace(/\$\d+/g, "")).not.toContain("$");
    }
  });
});
