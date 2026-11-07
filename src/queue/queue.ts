import { pgCode, type Sql, type Transactor, type TxSql } from "../db/index.ts";
import { notable } from "./errors.ts";
import { emitter, type QueueHooks } from "./events.ts";
import { checkEnqueue, clampLimit, type EnqueueArgs, text } from "./input.ts";
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
}
export type AckResult = "deleted" | "released" | "missing";
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

const built = new WeakMap<QueueSlice, QueueStatements>();

/** The slice's statements, after the brand check, built once per slice. */
function statementsOf(fn: string, s: QueueSlice): QueueStatements {
  assertQueueSlice(fn, s);
  let st = built.get(s);
  if (st === undefined) {
    st = queueStatements(s.table);
    built.set(s, st);
  }
  return st;
}

/** Runs `run`, turning a missing table (42P01) into NOTABLE. */
async function guarded<T>(s: QueueSlice, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (pgCode(err) === "42P01") throw notable(s.table, err);
    throw err;
  }
}

/** A text column read as a number, or null for NULL (the C1 rule). */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

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
  const work = async (tx: Sql): Promise<Row | undefined> => {
    const [current] = await tx.unsafe(LOCK_TIMEOUT_READ);
    try {
      await tx.unsafe(LOCK_TIMEOUT_SET, [`${s.enqueueLockTimeoutMs}ms`]);
      const [row] = await tx.unsafe(st.enqueue, [
        c.key,
        c.source,
        c.kind,
        c.json,
        c.debounce,
        c.slide,
        s.stickyKind,
      ]);
      return row;
    } finally {
      try {
        await tx.unsafe(LOCK_TIMEOUT_SET, [String(current?.v ?? "0")]);
      } catch {
        // The scope is already failing; its own error is the one to report.
      }
    }
  };
  let row: Row | undefined;
  try {
    row = await ("savepoint" in scope ? scope.savepoint(work) : scope.begin(work));
  } catch (err) {
    if (pgCode(err) === "55P03") {
      emit({ type: "queue.contended", key: c.key, source: c.source, kind: c.kind });
      return "contended";
    }
    if (pgCode(err) === "42P01") throw notable(s.table, err);
    throw err;
  }
  const result =
    row?.on_dead === true ? "on_dead" : row?.inserted === true ? "inserted" : "coalesced";
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
  const rows = await guarded(s, () =>
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
    if (r.dead === true) {
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
 * Q3. Deletes a claimed row nothing touched since the claim, or releases it
 * for another pass when an enqueue landed meanwhile. `missing` when this
 * worker no longer holds it.
 */
export async function ack(
  sql: Sql,
  s: QueueSlice,
  a: { key: string; worker: string },
  hooks?: QueueHooks,
): Promise<AckResult> {
  const st = statementsOf("ack", s);
  const emit = emitter(hooks);
  const [row] = await guarded(s, () => sql.unsafe(st.ack, [a.key, a.worker]));
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
  sql: Sql,
  s: QueueSlice,
  a: { key: string; worker: string; errorClass: string },
  hooks?: QueueHooks,
): Promise<FailResult> {
  const st = statementsOf("fail", s);
  const emit = emitter(hooks);
  const errorClass = text(
    emit,
    a.errorClass,
    s.maxNameChars,
    "error class",
    "error_class_invalid",
    { key: typeof a.key === "string" ? a.key : null },
  );
  const [row] = await guarded(s, () =>
    sql.unsafe(st.fail, [
      a.key,
      a.worker,
      errorClass,
      JSON.stringify(s.backoffMinutes),
      s.backoffMinutes.length,
      s.maxAttempts,
    ]),
  );
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
  const dead = row.dead === true;
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

/** Q5. Puts a dead row back, due now with a clean slate. False when it was not dead. */
export async function retryDead(
  sql: Sql,
  s: QueueSlice,
  key: string,
  hooks?: QueueHooks,
): Promise<boolean> {
  const st = statementsOf("retryDead", s);
  const emit = emitter(hooks);
  const [row] = await guarded(s, () => sql.unsafe(st.retryDead, [key]));
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
  const rows = await guarded(s, () => sql.unsafe(st.listDead, [a?.source ?? null, limit]));
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
  const rows = await guarded(s, () => sql.unsafe(st.depth, [s.claimTimeoutMinutes]));
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

export type { EnqueueArgs };
