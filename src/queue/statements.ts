import { quoteIdentifier } from "../db/index.ts";

/**
 * Every statement the queue and the cursors send, frozen text, built once per
 * table. Statements carry no comment and no `$` outside a placeholder.
 * JSON parameters are bound as text and cast server-side
 * (`$n::text::jsonb`): bound straight to a jsonb parameter, both drivers
 * would encode the string again and store a JSON string.
 */

export const LOCK_TIMEOUT_READ = "SELECT current_setting('lock_timeout') AS v";
export const LOCK_TIMEOUT_SET = "SELECT set_config('lock_timeout', $1, true)";

const splice = (table: { schema: string; name: string }) =>
  `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;

export interface QueueStatements {
  /** Q1 (c), params [key, source, kind, json, debounce, slide, stickyKind]. */
  readonly enqueue: string;
  /** Q2, params [source, claimTimeoutMinutes, limit, expiredClaimClass, maxAttempts, worker]. */
  readonly claim: string;
  /** Q3, params [key, worker]. */
  readonly ack: string;
  /** Q4, params [key, worker, errorClass, JSON.stringify(backoff), backoff.length, maxAttempts]. */
  readonly fail: string;
  /** Q5, params [key]. */
  readonly retryDead: string;
  /** Q6, params [source, limit]. */
  readonly listDead: string;
  /** Q7, params [claimTimeoutMinutes]. */
  readonly depth: string;
}

export function queueStatements(table: { schema: string; name: string }): QueueStatements {
  const T = splice(table);
  return Object.freeze({
    enqueue: `INSERT INTO ${T} AS q (key, source, kind, payload, not_before, enqueued_at, updated_at)
VALUES (
  $1, $2, $3, $4::text::jsonb,
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
    claim: `WITH candidates AS (
  SELECT key, claimed_at AS prev_claimed_at, claimed_by AS prev_claimed_by
  FROM ${T}
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
  UPDATE ${T} q SET
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
    ack: `WITH before AS (
  SELECT enqueued_at FROM ${T} WHERE key = $1
),
deleted AS (
  DELETE FROM ${T}
  WHERE key = $1 AND claimed_by = $2 AND dead_at IS NULL AND updated_at <= claimed_at
  RETURNING key, source, kind
),
released AS (
  UPDATE ${T} SET
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
    fail: `UPDATE ${T} SET
  attempts = attempts + 1,
  last_error = $3,
  claimed_at = NULL,
  claimed_by = NULL,
  not_before = clock_timestamp() + make_interval(mins => ($4::text::jsonb ->> (least(attempts + 1, $5::int) - 1))::int),
  dead_at = CASE WHEN attempts + 1 >= $6::int THEN clock_timestamp() ELSE dead_at END
WHERE key = $1 AND claimed_by = $2
RETURNING source, kind, attempts::text AS attempts, dead_at IS NOT NULL AS dead`,
    retryDead: `UPDATE ${T} SET
  dead_at = NULL, attempts = 0, last_error = NULL,
  claimed_at = NULL, claimed_by = NULL, not_before = clock_timestamp(),
  enqueued_at = clock_timestamp()
WHERE key = $1 AND dead_at IS NOT NULL
RETURNING key, source, kind`,
    listDead: `SELECT key, source, kind, attempts::text AS attempts, last_error,
       floor(extract(epoch FROM dead_at) * 1000)::text AS dead_at_ms,
       floor(extract(epoch FROM enqueued_at) * 1000)::text AS enqueued_at_ms
FROM ${T}
WHERE dead_at IS NOT NULL
  AND ($1::text IS NULL OR source = $1::text)
ORDER BY dead_at DESC
LIMIT $2::int`,
    depth: `SELECT source,
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
FROM ${T}
GROUP BY source
ORDER BY source`,
  });
}

export interface CursorStatements {
  /** K1, params [name]. */
  readonly get: string;
  /** K2, params [name, v]. */
  readonly set: string;
  /** K3, params [name, v]. */
  readonly touch: string;
}

export function cursorStatements(
  table: { schema: string; name: string },
  value: "text" | "jsonb",
): CursorStatements {
  const C = splice(table);
  const V = value === "text" ? "$2" : "$2::text::jsonb";
  return Object.freeze({
    get: `SELECT value::text AS value FROM ${C} WHERE name = $1`,
    set: `INSERT INTO ${C} (name, value, updated_at)
VALUES ($1, ${V}, clock_timestamp())
ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = clock_timestamp()
RETURNING (SELECT value::text FROM ${C} WHERE name = $1) AS previous`,
    touch: `INSERT INTO ${C} (name, value, updated_at)
VALUES ($1, ${V}, clock_timestamp())
ON CONFLICT (name) DO UPDATE SET updated_at = clock_timestamp()`,
  });
}
