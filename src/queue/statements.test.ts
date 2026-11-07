import { describe, expect, test } from "bun:test";
import {
  cursorStatements,
  LOCK_TIMEOUT_READ,
  LOCK_TIMEOUT_SET,
  queueStatements,
} from "./statements.ts";

const TABLE = { schema: "rs_a", name: "wq" };
const q = queueStatements(TABLE);
const textCursor = cursorStatements(TABLE, "text");
const jsonCursor = cursorStatements(TABLE, "jsonb");

/** Each statement and how many parameters it is sent with. */
const ALL: [string, string, number][] = [
  ["Q1 (a)", LOCK_TIMEOUT_READ, 0],
  ["Q1 (b)", LOCK_TIMEOUT_SET, 1],
  ["Q1 (c)", q.enqueue, 7],
  ["Q2", q.claim, 6],
  ["Q3", q.ack, 2],
  ["Q4", q.fail, 6],
  ["Q5", q.retryDead, 1],
  ["Q6", q.listDead, 2],
  ["Q7", q.depth, 1],
  ["K1 text", textCursor.get, 1],
  ["K2 text", textCursor.set, 2],
  ["K3 text", textCursor.touch, 2],
  ["K1 jsonb", jsonCursor.get, 1],
  ["K2 jsonb", jsonCursor.set, 2],
  ["K3 jsonb", jsonCursor.touch, 2],
];

describe("QT1: built statements", () => {
  for (const [id, text, params] of ALL) {
    test(`${id}: placeholders 1..${params} only, each referenced, no comment`, () => {
      const used = new Set<number>();
      const stripped = text.replace(/\$([1-9][0-9]*)/g, (m, n: string) => {
        const i = Number(n);
        if (i > params) return m;
        used.add(i);
        return "";
      });
      expect(stripped).not.toMatch(/\$\d/);
      expect([...used].sort((a, b) => a - b)).toEqual(
        Array.from({ length: params }, (_, i) => i + 1),
      );
      expect(text).not.toContain("--");
    });
    test(`${id}: the table appears only quoted`, () => {
      const rest = text.replaceAll('"rs_a"."wq"', "");
      expect(rest).not.toMatch(/\brs_a\b|\bwq\b/);
    });
  }

  test("every table-bound statement names the table", () => {
    for (const [id, text] of ALL.slice(2)) expect(text, id).toContain('"rs_a"."wq"');
  });

  test("a text cursor binds the value as text; a jsonb one casts it through text", () => {
    expect(textCursor.set).toContain("VALUES ($1, $2::text, clock_timestamp())");
    expect(jsonCursor.set).toContain("VALUES ($1, $2::text::jsonb, clock_timestamp())");
    expect(Object.isFrozen(q)).toBe(true);
  });
});

/**
 * The text of contract §4.4, verbatim (`<T>`, `<C>`, `<V>` as written there).
 * Copy it from the contract, never from statements.ts: this is what catches a
 * statement drifting from the frozen one, e.g. a dropped SKIP LOCKED.
 */
const FROZEN: Record<string, string> = {
  Q1: `INSERT INTO <T> AS q (key, source, kind, payload, not_before, enqueued_at, updated_at)
VALUES (
  $1, $2, $3, $4::jsonb,
  clock_timestamp() + make_interval(secs => $5::double precision),
  clock_timestamp(), clock_timestamp()
)
ON CONFLICT (key) DO UPDATE SET
  not_before = CASE WHEN q.attempts = 0
    THEN least(
      greatest(excluded.not_before, q.not_before),
      q.enqueued_at + make_interval(secs => $6::double precision))
    ELSE greatest(excluded.not_before, q.not_before) END,
  kind = CASE WHEN q.kind = $7::text THEN q.kind ELSE excluded.kind END,
  payload = CASE WHEN q.kind = $7::text AND excluded.kind <> $7::text
                 THEN q.payload ELSE excluded.payload END,
  updated_at = clock_timestamp()
RETURNING (xmax = 0) AS inserted, dead_at IS NOT NULL AS on_dead`,
  Q2: `WITH candidates AS (
  SELECT key, claimed_at AS prev_claimed_at, claimed_by AS prev_claimed_by
  FROM <T>
  WHERE source = $1
    AND dead_at IS NULL
    AND not_before <= clock_timestamp()
    AND (claimed_at IS NULL
         OR claimed_at < clock_timestamp() - make_interval(mins => $2::int))
  ORDER BY not_before
  LIMIT $3::int
  FOR UPDATE SKIP LOCKED
),
taken AS (
  UPDATE <T> q SET
    attempts = q.attempts + CASE WHEN c.prev_claimed_at IS NULL THEN 0 ELSE 1 END,
    last_error = CASE WHEN c.prev_claimed_at IS NULL THEN q.last_error
                      ELSE coalesce(q.last_error, $4::text) END,
    dead_at = CASE WHEN c.prev_claimed_at IS NOT NULL
                    AND q.attempts + 1 >= $5::int
                   THEN clock_timestamp() ELSE q.dead_at END,
    claimed_at = CASE WHEN c.prev_claimed_at IS NOT NULL
                       AND q.attempts + 1 >= $5::int
                      THEN NULL ELSE clock_timestamp() END,
    claimed_by = CASE WHEN c.prev_claimed_at IS NOT NULL
                       AND q.attempts + 1 >= $5::int
                      THEN NULL ELSE $6::text END
  FROM candidates c
  WHERE q.key = c.key
  RETURNING q.key, q.source, q.kind, q.payload, q.attempts, q.last_error, q.dead_at,
            q.not_before, q.claimed_at, q.claimed_by, c.prev_claimed_by
)
SELECT key, source, kind, payload::text AS payload, attempts::text AS attempts,
       last_error, dead_at IS NOT NULL AS dead,
       floor(extract(epoch FROM not_before) * 1000)::text AS not_before_ms,
       floor(extract(epoch FROM claimed_at) * 1000)::text AS claimed_at_ms,
       claimed_by, prev_claimed_by
FROM taken
ORDER BY not_before, key`,
  Q3: `WITH before AS (
  SELECT enqueued_at FROM <T> WHERE key = $1
),
deleted AS (
  DELETE FROM <T>
  WHERE key = $1 AND claimed_by = $2 AND dead_at IS NULL AND updated_at <= claimed_at
  RETURNING key, source, kind
),
released AS (
  UPDATE <T> SET
    claimed_at = NULL, claimed_by = NULL, attempts = 0, last_error = NULL,
    enqueued_at = clock_timestamp()
  WHERE key = $1 AND claimed_by = $2 AND dead_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM deleted)
  RETURNING key, source, kind
)
SELECT 'deleted' AS result, source, kind,
       (SELECT floor(extract(epoch FROM enqueued_at) * 1000)::text FROM before) AS enqueued_at_ms,
       (SELECT (extract(epoch FROM (clock_timestamp() - enqueued_at)) * 1000)::text FROM before) AS queued_ms
FROM deleted
UNION ALL
SELECT 'released' AS result, source, kind,
       (SELECT floor(extract(epoch FROM enqueued_at) * 1000)::text FROM before) AS enqueued_at_ms,
       (SELECT (extract(epoch FROM (clock_timestamp() - enqueued_at)) * 1000)::text FROM before) AS queued_ms
FROM released`,
  Q4: `UPDATE <T> SET
  attempts = attempts + 1,
  last_error = $3,
  claimed_at = NULL,
  claimed_by = NULL,
  not_before = clock_timestamp() + make_interval(mins => ($4::jsonb ->> (least(attempts + 1, $5::int) - 1))::int),
  dead_at = CASE WHEN attempts + 1 >= $6::int THEN clock_timestamp() ELSE dead_at END
WHERE key = $1 AND claimed_by = $2
RETURNING source, kind, attempts::text AS attempts, dead_at IS NOT NULL AS dead`,
  Q5: `UPDATE <T> SET
  dead_at = NULL, attempts = 0, last_error = NULL,
  claimed_at = NULL, claimed_by = NULL, not_before = clock_timestamp(),
  enqueued_at = clock_timestamp()
WHERE key = $1 AND dead_at IS NOT NULL
RETURNING key, source, kind`,
  Q6: `SELECT key, source, kind, attempts::text AS attempts, last_error,
       floor(extract(epoch FROM dead_at) * 1000)::text AS dead_at_ms,
       floor(extract(epoch FROM enqueued_at) * 1000)::text AS enqueued_at_ms
FROM <T>
WHERE dead_at IS NOT NULL
  AND ($1::text IS NULL OR source = $1::text)
ORDER BY dead_at DESC
LIMIT $2::int`,
  Q7: `SELECT source,
       (count(*) FILTER (WHERE dead_at IS NULL))::text AS queued,
       (count(*) FILTER (
         WHERE dead_at IS NULL
           AND not_before <= clock_timestamp()
           AND (claimed_at IS NULL
                OR claimed_at < clock_timestamp() - make_interval(mins => $1::int))
       ))::text AS due,
       (extract(epoch FROM (clock_timestamp() - min(not_before) FILTER (
         WHERE dead_at IS NULL
           AND not_before <= clock_timestamp()
           AND (claimed_at IS NULL
                OR claimed_at < clock_timestamp() - make_interval(mins => $1::int))
       ))) / 60)::text AS oldest_due_minutes,
       (count(*) FILTER (WHERE dead_at IS NULL AND claimed_at IS NOT NULL))::text AS claimed,
       (count(*) FILTER (WHERE dead_at IS NOT NULL))::text AS dead,
       floor(extract(epoch FROM min(not_before) FILTER (WHERE dead_at IS NULL)) * 1000)::text AS oldest_not_before_ms,
       (extract(epoch FROM (clock_timestamp() - min(enqueued_at) FILTER (WHERE dead_at IS NULL))) / 3600)::text AS oldest_wait_hours,
       (extract(epoch FROM (clock_timestamp() - min(dead_at))) / 3600)::text AS oldest_dead_hours
FROM <T>
GROUP BY source
ORDER BY source`,
  K1: `SELECT value::text AS value FROM <C> WHERE name = $1`,
  K2: `INSERT INTO <C> (name, value, updated_at)
VALUES ($1, <V>, clock_timestamp())
ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = clock_timestamp()
RETURNING (SELECT value::text FROM <C> WHERE name = $1) AS previous`,
  K3: `INSERT INTO <C> (name, value, updated_at)
VALUES ($1, <V>, clock_timestamp())
ON CONFLICT (name) DO UPDATE SET updated_at = clock_timestamp()`,
};

/**
 * The recorded deviations from §4.4, applied to the frozen text: JSON bound as
 * text and cast server-side (deviations.md, R-C5), and a text cursor bound
 * `$2::text` (deviations-queue-fix.md). Nothing else may differ.
 */
function expected(id: string, v: "$2::text" | "$2::text::jsonb" = "$2::text::jsonb"): string {
  let text = FROZEN[id] as string;
  if (id === "Q1" || id === "Q4") text = text.replace("$4::jsonb", "$4::text::jsonb");
  return text
    .replaceAll("<T>", '"rootstock"."work_queue"')
    .replaceAll("<C>", '"rootstock"."cursors"')
    .replaceAll("<V>", v);
}

describe("QT1: the statements are §4.4's text, byte for byte", () => {
  const pq = queueStatements({ schema: "rootstock", name: "work_queue" });
  const C = { schema: "rootstock", name: "cursors" };
  const pt = cursorStatements(C, "text");
  const pj = cursorStatements(C, "jsonb");
  const pairs: [string, string, string][] = [
    ["Q1", pq.enqueue, expected("Q1")],
    ["Q2", pq.claim, expected("Q2")],
    ["Q3", pq.ack, expected("Q3")],
    ["Q4", pq.fail, expected("Q4")],
    ["Q5", pq.retryDead, expected("Q5")],
    ["Q6", pq.listDead, expected("Q6")],
    ["Q7", pq.depth, expected("Q7")],
    ["K1 text", pt.get, expected("K1")],
    ["K1 jsonb", pj.get, expected("K1")],
    ["K2 text", pt.set, expected("K2", "$2::text")],
    ["K2 jsonb", pj.set, expected("K2")],
    ["K3 text", pt.touch, expected("K3", "$2::text")],
    ["K3 jsonb", pj.touch, expected("K3")],
  ];
  for (const [id, built, want] of pairs) {
    test(id, () => expect(built).toBe(want));
  }
  test("Q1 (a), (b)", () => {
    expect(LOCK_TIMEOUT_READ).toBe("SELECT current_setting('lock_timeout') AS v");
    expect(LOCK_TIMEOUT_SET).toBe("SELECT set_config('lock_timeout', $1, true)");
  });
});
