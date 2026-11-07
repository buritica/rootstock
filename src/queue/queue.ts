import { pgCode, type Sql, type Transactor, type TxSql } from "../db/index.ts";
import { perSlice } from "../internal/slice.ts";
import { guarded } from "./errors.ts";
import { type Emit, emitter, type QueueHooks } from "./events.ts";
import { checkClaim, checkEnqueue, clampLimit, type EnqueueArgs, text } from "./input.ts";
import { assertQueueSlice, type QueueSlice } from "./slice.ts";
import {
  LOCK_TIMEOUT_READ,
  LOCK_TIMEOUT_SET,
  type QueueStatements,
  queueStatements,
} from "./statements.ts";

type Row = Record<string, unknown>;

export type EnqueueResult = "enqueued" | "contended";
export interface QueueRow {
  key: string;
  source: string;
  kind: string;
  payload: unknown;
  attempts: number;
  notBefore: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  /** What ack, fail and extendClaim present: the claim's token, and the row's version (a bigint as text). */
  claim: { token: string; version: string };
}
export type AckResult = "deleted" | "released" | "missing";
export type ExtendResult = "extended" | "changed" | "missing";
export interface FailResult {
  result: "failed" | "dead" | "missing";
  attempts: number;
}
export interface DeadRow {
  key: string;
  source: string;
  kind: string;
  attempts: number;
  lastError: string | null;
  deadAt: Date;
  enqueuedAt: Date;
}
export interface QueueDepth {
  source: string;
  queued: number;
  due: number;
  claimed: number;
  dead: number;
  oldestNotBefore: Date | null;
  oldestWaitHours: number | null;
  oldestDueMinutes: number | null;
  oldestDeadHours: number | null;
}

interface Built {
  readonly statements: QueueStatements;
  /** Q4's backoff parameter. */
  readonly backoffJson: string;
}

/** What each call needs from the slice, after the brand check. */
const builtOf = perSlice(
  assertQueueSlice,
  (s: QueueSlice): Built => ({
    statements: queueStatements(s.table),
    backoffJson: JSON.stringify(s.backoffMinutes),
  }),
);
const statementsOf = (fn: string, s: QueueSlice): QueueStatements => builtOf(fn, s).statements;

/** A text column read as a number, or null for NULL (the C1 rule). */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** A boolean column: a driver that hands back text gives "t" or "true". */
const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";

/**
 * Q1 (a)(b)(d) around one statement, in one scope: a `Transactor` opens its
 * own transaction, a `TxSql` a savepoint, so a caller's transaction keeps
 * working. `lock_timeout` is `ms` for the statement and restored after it.
 * Returns the statement's first row.
 */
async function withLockTimeout(
  scope: Transactor | TxSql,
  s: QueueSlice,
  ms: number,
  statement: string,
  params: readonly unknown[],
): Promise<Row | undefined> {
  const work = async (tx: Sql): Promise<Row | undefined> => {
    const [current] = await tx.unsafe(LOCK_TIMEOUT_READ);
    try {
      await tx.unsafe(LOCK_TIMEOUT_SET, [`${ms}ms`]);
      const [row] = await tx.unsafe(statement, params);
      return row;
    } finally {
      try {
        await tx.unsafe(LOCK_TIMEOUT_SET, [String(current?.v ?? "0")]);
      } catch {
        // On a failing scope its own error is the one to report. On the
        // success path a failed restore leaves the transaction aborted, so
        // the commit or savepoint release that follows rejects and reports it.
      }
    }
  };
  return guarded(s.table, () => ("savepoint" in scope ? scope.savepoint(work) : scope.begin(work)));
}

/**
 * Runs an ack, fail or extend statement under `ackLockTimeoutMs`. A row lock
 * held past it emits `queue.ack_contended` and rethrows: the row stays
 * claimed and is reclaimed on expiry.
 */
async function underAckLock(
  scope: Transactor | TxSql,
  s: QueueSlice,
  emit: Emit,
  a: { key: string; worker: string; operation: "ack" | "fail" | "extend" },
  statement: string,
  params: readonly unknown[],
): Promise<Row | undefined> {
  try {
    return await withLockTimeout(scope, s, s.ackLockTimeoutMs, statement, params);
  } catch (err) {
    if (pgCode(err) === "55P03") {
      emit({ type: "queue.ack_contended", key: a.key, worker: a.worker, operation: a.operation });
    }
    throw err;
  }
}

/**
 * Q1. Enqueues or coalesces one row under a bounded lock wait, in one scope:
 * a `Transactor` opens its own transaction, a `TxSql` a savepoint, so a
 * caller's transaction keeps working. A row lock held past
 * `enqueueLockTimeoutMs` returns `"contended"`.
 */
export async function enqueue(
  scope: Transactor | TxSql,
  s: QueueSlice,
  a: EnqueueArgs,
  hooks?: QueueHooks,
): Promise<EnqueueResult> {
  const st = statementsOf("enqueue", s);
  const emit = emitter(hooks);
  const c = checkEnqueue(emit, s, a);
  let row: Row | undefined;
  try {
    row = await withLockTimeout(scope, s, s.enqueueLockTimeoutMs, st.enqueue, [
      c.key,
      c.source,
      c.kind,
      c.json,
      c.debounce,
      c.slide,
      s.stickyKind,
    ]);
  } catch (err) {
    if (pgCode(err) !== "55P03") throw err;
    emit({ type: "queue.contended", key: c.key, source: c.source, kind: c.kind });
    return "contended";
  }
  const result = bool(row?.on_dead) ? "on_dead" : bool(row?.inserted) ? "inserted" : "coalesced";
  emit({
    type: "queue.enqueued",
    key: c.key,
    source: c.source,
    kind: c.kind,
    debounceSeconds: c.debounce,
    result,
  });
  return "enqueued";
}

/**
 * Q2. Claims up to `limit` due rows of one source, oldest first, skipping rows
 * another claimer holds. An expired claim is retaken with an attempt charged,
 * and dead-lettered instead once that reaches `maxAttempts`.
 */
export async function claim(
  sql: Sql,
  s: QueueSlice,
  a: { source: string; limit: number; worker: string },
  hooks?: QueueHooks,
): Promise<QueueRow[]> {
  const st = statementsOf("claim", s);
  const emit = emitter(hooks);
  const worker = text(emit, a.worker, s.maxNameChars, "worker", "worker_invalid", {
    source: typeof a.source === "string" ? a.source : null,
  });
  const limit = clampLimit(a.limit, s.maxClaimLimit, 1);
  const rows = await guarded(s.table, () =>
    sql.unsafe(st.claim, [
      a.source,
      s.claimTimeoutMinutes,
      limit,
      s.expiredClaimClass,
      s.maxAttempts,
      worker,
    ]),
  );
  const out: QueueRow[] = [];
  let deadLettered = 0;
  for (const r of rows) {
    const key = String(r.key);
    const source = String(r.source);
    const kind = String(r.kind);
    const attempts = Number(r.attempts);
    if (bool(r.dead)) {
      deadLettered += 1;
      emit({
        type: "queue.dead",
        key,
        source,
        kind,
        attempts,
        worker,
        error: str(r.last_error) ?? s.expiredClaimClass,
      });
      continue;
    }
    const from = str(r.prev_claimed_by);
    if (from !== null) {
      emit({ type: "queue.reclaimed", key, source, kind, attempts, worker, from });
    }
    out.push({
      key,
      source,
      kind,
      payload: JSON.parse(String(r.payload)),
      attempts,
      notBefore: date(r.not_before_ms) as Date,
      claimedAt: date(r.claimed_at_ms),
      claimedBy: str(r.claimed_by),
      claim: { token: String(r.claim_token), version: String(r.version) },
    });
    emit({ type: "queue.claimed", key, source, kind, attempts, worker });
  }
  emit({
    type: "queue.drained",
    source: a.source,
    worker,
    limit,
    claimed: out.length,
    deadLettered,
  });
  return out;
}

/**
 * Q3. Deletes a claimed row nothing touched since the claim (same version),
 * or releases it for another pass when an enqueue landed meanwhile.
 * `missing` when this claim no longer holds it (another worker, or a reclaim
 * that changed the token).
 */
export async function ack(
  scope: Transactor | TxSql,
  s: QueueSlice,
  a: { key: string; worker: string; claim: QueueRow["claim"] },
  hooks?: QueueHooks,
): Promise<AckResult> {
  const st = statementsOf("ack", s);
  const emit = emitter(hooks);
  const c = checkClaim(emit, a.key, a.claim);
  const row = await underAckLock(scope, s, emit, { ...a, operation: "ack" }, st.ack, [
    a.key,
    a.worker,
    c.token,
    c.version,
  ]);
  if (row === undefined) {
    emit({ type: "queue.lost", key: a.key, worker: a.worker, operation: "ack" });
    return "missing";
  }
  const result = row.result === "deleted" ? "deleted" : "released";
  const enqueuedAt = date(row.enqueued_at_ms);
  emit({
    type: "queue.acked",
    key: a.key,
    source: String(row.source),
    kind: String(row.kind),
    worker: a.worker,
    result,
    enqueuedAt: enqueuedAt === null ? null : enqueuedAt.toISOString(),
    queuedMs: num(row.queued_ms),
  });
  return result;
}

/**
 * Q4. Records a failure: the next attempt waits the backoff rung for this
 * attempt (the last rung repeats), and the row is dead at `maxAttempts`.
 */
export async function fail(
  scope: Transactor | TxSql,
  s: QueueSlice,
  a: { key: string; worker: string; errorClass: string; claim: QueueRow["claim"] },
  hooks?: QueueHooks,
): Promise<FailResult> {
  const { statements: st, backoffJson } = builtOf("fail", s);
  const emit = emitter(hooks);
  const errorClass = text(
    emit,
    a.errorClass,
    s.maxNameChars,
    "error class",
    "error_class_invalid",
    { key: typeof a.key === "string" ? a.key : null },
  );
  const c = checkClaim(emit, a.key, a.claim);
  const row = await underAckLock(scope, s, emit, { ...a, operation: "fail" }, st.fail, [
    a.key,
    a.worker,
    errorClass,
    backoffJson,
    s.backoffMinutes.length,
    s.maxAttempts,
    c.token,
  ]);
  if (row === undefined) {
    emit({
      type: "queue.lost",
      key: a.key,
      worker: a.worker,
      operation: "fail",
      error: errorClass,
    });
    return { result: "missing", attempts: 0 };
  }
  const source = String(row.source);
  const kind = String(row.kind);
  const attempts = Number(row.attempts);
  emit({
    type: "queue.failed",
    key: a.key,
    source,
    kind,
    worker: a.worker,
    attempts,
    error: errorClass,
  });
  const dead = bool(row.dead);
  if (dead) {
    emit({
      type: "queue.dead",
      key: a.key,
      source,
      kind,
      attempts,
      worker: a.worker,
      error: errorClass,
    });
  }
  return { result: dead ? "dead" : "failed", attempts };
}

/**
 * Q8. Moves a held claim's `claimed_at` to now, so a long job is not
 * reclaimed. `changed` when an enqueue landed since the claim: extending
 * would let ack delete the new work, so the claim is left as it is and the
 * worker's ack will release. `missing` when this claim no longer holds it.
 */
export async function extendClaim(
  scope: Transactor | TxSql,
  s: QueueSlice,
  a: { key: string; worker: string; claim: QueueRow["claim"] },
  hooks?: QueueHooks,
): Promise<ExtendResult> {
  const st = statementsOf("extendClaim", s);
  const emit = emitter(hooks);
  const c = checkClaim(emit, a.key, a.claim);
  const row = await underAckLock(scope, s, emit, { ...a, operation: "extend" }, st.extendClaim, [
    a.key,
    a.worker,
    c.token,
  ]);
  if (Number(row?.extended) === 1) {
    emit({ type: "queue.claim_extended", key: a.key, worker: a.worker });
    return "extended";
  }
  if (Number(row?.held) === 1) return "changed";
  emit({ type: "queue.lost", key: a.key, worker: a.worker, operation: "extend" });
  return "missing";
}

/** Q5. Puts a dead row back, due now with a clean slate. False when it was not dead. */
export async function retryDead(
  sql: Sql,
  s: QueueSlice,
  key: string,
  hooks?: QueueHooks,
): Promise<boolean> {
  const st = statementsOf("retryDead", s);
  const emit = emitter(hooks);
  const [row] = await guarded(s.table, () => sql.unsafe(st.retryDead, [key]));
  if (row === undefined) {
    emit({ type: "queue.retry_noop", key });
    return false;
  }
  emit({ type: "queue.retried", key, source: String(row.source), kind: String(row.kind) });
  return true;
}

/** Q6. Dead rows, newest first, of one source or all. */
export async function listDead(
  sql: Sql,
  s: QueueSlice,
  a?: { source?: string; limit?: number },
): Promise<DeadRow[]> {
  const st = statementsOf("listDead", s);
  const limit = clampLimit(a?.limit ?? 50, s.maxClaimLimit, 50);
  const rows = await guarded(s.table, () => sql.unsafe(st.listDead, [a?.source ?? null, limit]));
  return rows.map((r) => ({
    key: String(r.key),
    source: String(r.source),
    kind: String(r.kind),
    attempts: Number(r.attempts),
    lastError: str(r.last_error),
    deadAt: date(r.dead_at_ms) as Date,
    enqueuedAt: date(r.enqueued_at_ms) as Date,
  }));
}

/** Q7. Per source: live, due, claimed and dead counts, and how old the oldest of each is. */
export async function depth(sql: Sql, s: QueueSlice): Promise<QueueDepth[]> {
  const st = statementsOf("depth", s);
  const rows = await guarded(s.table, () => sql.unsafe(st.depth, [s.claimTimeoutMinutes]));
  return rows.map((r) => ({
    source: String(r.source),
    queued: Number(r.queued),
    due: Number(r.due),
    claimed: Number(r.claimed),
    dead: Number(r.dead),
    oldestNotBefore: date(r.oldest_not_before_ms),
    oldestWaitHours: num(r.oldest_wait_hours),
    oldestDueMinutes: num(r.oldest_due_minutes),
    oldestDeadHours: num(r.oldest_dead_hours),
  }));
}
