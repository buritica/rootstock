import { quoteTable } from "../internal/slice.ts";
import { LOCK_HELD_PREDICATE } from "../lock/index.ts";

/**
 * Every statement the run record sends (contract §3.2–§3.4), frozen text,
 * built once per slice. `<R>` is the runs table, `<L>` the lock's fencing
 * table. No statement carries a comment or a `$` outside a placeholder.
 */

/** `<P(r)>`: a run row as one jsonb object, read `::text` and parsed (§3.2). */
export const PROJECTION = `jsonb_build_object(
  'id', r.id::text, 'job', r.job, 'mode', r.mode, 'status', r.status, 'phase', r.phase,
  'lockName', r.lock_name, 'holder', r.holder::text,
  'startedAtMs', floor(extract(epoch FROM r.started_at) * 1000)::text,
  'finishedAtMs', floor(extract(epoch FROM r.finished_at) * 1000)::text,
  'listed', r.listed, 'written', r.written, 'unchanged', r.unchanged,
  'quarantined', r.quarantined, 'excluded', r.excluded_count, 'reconciled', r.reconciled,
  'excludedReasons', r.excluded_reasons, 'counts', r.counts, 'tokens', r.tokens,
  'costUsd', r.cost_usd::text, 'costNote', r.cost_note,
  'scope', r.scope, 'scopeExcluded', r.scope_excluded, 'overrides', r.overrides,
  'reason', r.reason)`;

export interface RunsStatements {
  /** R1 start, params [id, job, mode, lockName, holder]. */
  readonly start: string;
  /** R2 finish, params [id, holder, status, phase, listed, written, unchanged, quarantined, excluded, reconciled, excludedReasonsJson, countsJson, tokensJson, costUsd, costNote, scopeJson, scopeExcludedJson, overridesJson, reason]. */
  readonly finish: string;
  /** R3 discard, params [id, holder]. */
  readonly discard: string;
  /** R2b: this run's own row once settled, read back after a retried R2 (§20 A25). */
  readonly settledOwn: string;
  /** R4 snapshot, params [JSON.stringify(jobs)]. */
  readonly snapshot: string;
  /** R5 prune, params [keepDays]. */
  readonly prune: string;
}

/** The run record's statements for runs table `runs` and fencing table `locks`. */
export function runsStatements(
  runs: { schema: string; name: string },
  locks: { schema: string; name: string },
): RunsStatements {
  const R = quoteTable(runs);
  const L = quoteTable(locks);
  const P = PROJECTION;
  const held = LOCK_HELD_PREDICATE.replaceAll("$1", "r.lock_name");
  return Object.freeze({
    start: `WITH fence AS (
  SELECT 1 AS ok FROM ${L} l WHERE l.name = $4::text AND l.holder = $5::uuid
),
settled AS (
  UPDATE ${R} SET status = 'interrupted', finished_at = clock_timestamp(),
    reason = coalesce(reason, 'interrupted: still running when run ' || $1::text || ' took the ' || $4::text || ' lock')
  WHERE lock_name = $4::text AND status = 'running' AND holder <> $5::uuid
    AND EXISTS (SELECT 1 FROM fence)
  RETURNING id::text AS id, job
),
ins AS (
  INSERT INTO ${R} (id, job, mode, status, lock_name, holder, started_at)
  SELECT $1::uuid, $2::text, $3::text, 'running', $4::text, $5::uuid, clock_timestamp()
  WHERE EXISTS (SELECT 1 FROM fence)
  RETURNING floor(extract(epoch FROM started_at) * 1000)::text AS started_at_ms
)
SELECT EXISTS (SELECT 1 FROM ins) AS inserted,
       (SELECT started_at_ms FROM ins) AS started_at_ms,
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'job', job) ORDER BY id) FROM settled),
                '[]'::jsonb)::text AS settled`,
    finish: `UPDATE ${R} AS r SET
  status = $3::text, phase = $4::text, finished_at = clock_timestamp(),
  listed = $5::int, written = $6::int, unchanged = $7::int, quarantined = $8::int,
  excluded_count = $9::int, reconciled = $10::boolean,
  excluded_reasons = coalesce($11::text::jsonb, '{}'::jsonb),
  counts = coalesce($12::text::jsonb, '{}'::jsonb),
  tokens = coalesce($13::text::jsonb, '{}'::jsonb),
  cost_usd = $14::text::numeric, cost_note = $15::text,
  scope = $16::text::jsonb, scope_excluded = $17::text::jsonb,
  overrides = coalesce($18::text::jsonb, '[]'::jsonb),
  reason = $19::text
WHERE r.id = $1::uuid AND r.holder = $2::uuid AND r.status = 'running'
RETURNING ${P}::text AS row`,
    discard: `DELETE FROM ${R} WHERE id = $1::uuid AND holder = $2::uuid AND status = 'running' RETURNING 1 AS ok`,
    settledOwn: `SELECT ${P}::text AS row FROM ${R} r WHERE r.id = $1::uuid AND r.holder = $2::uuid AND r.status <> 'running'`,
    snapshot: `SELECT j.job,
  (SELECT count(*) FROM ${R} r WHERE r.job = j.job)::text AS total,
  (SELECT ${P} FROM ${R} r WHERE r.job = j.job AND r.status <> 'running'
     ORDER BY r.started_at DESC, r.id DESC LIMIT 1)::text AS newest_settled,
  (SELECT ${P} FROM ${R} r WHERE r.job = j.job AND r.status = 'ok'
     ORDER BY r.started_at DESC, r.id DESC LIMIT 1)::text AS newest_ok,
  (SELECT jsonb_agg(${P} || jsonb_build_object('live',
            EXISTS (SELECT 1 FROM ${L} l WHERE l.name = r.lock_name AND l.holder = r.holder)
            AND ${held})
          || coalesce((SELECT jsonb_build_object(
                'heartbeatAtMs', floor(extract(epoch FROM l.heartbeat_at) * 1000)::text,
                'heartbeatAgeMs', floor(extract(epoch FROM clock_timestamp() - l.heartbeat_at) * 1000)::text)
              FROM ${L} l WHERE l.name = r.lock_name AND l.holder = r.holder), '{}'::jsonb)
          ORDER BY r.started_at, r.id)
     FROM ${R} r WHERE r.job = j.job AND r.status = 'running')::text AS running
FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS j(job, i)
ORDER BY j.i`,
    prune: `WITH d AS (
  DELETE FROM ${R} r
  WHERE r.status <> 'running'
    AND r.started_at < clock_timestamp() - make_interval(days => $1::int)
    AND r.id IS DISTINCT FROM (
      SELECT k.id FROM ${R} k WHERE k.job = r.job AND k.status = 'ok'
      ORDER BY k.started_at DESC, k.id DESC LIMIT 1)
    AND r.id IS DISTINCT FROM (
      SELECT k.id FROM ${R} k WHERE k.job = r.job AND k.status <> 'running'
      ORDER BY k.started_at DESC, k.id DESC LIMIT 1)
  RETURNING 1
)
SELECT count(*)::text AS deleted FROM d`,
  });
}
