import { pgCode } from "../db/index.ts";
import { intIn, safeHook } from "../internal/slice.ts";
import { ack, claim, extendClaim, fail, type QueueRow } from "../queue/index.ts";
import { checkTransactor, isFn, input as refusal } from "./errors.ts";
import type {
  DrainDeps,
  DrainFailure,
  DrainInput,
  DrainLock,
  DrainOutcome,
  DrainReport,
  DrainSource,
  HeldWhy,
  RunnerEvent,
  SourceDrain,
} from "./types.ts";

const FN = "drainQueue";
const input = (field: string, what: string, value: unknown) => refusal(FN, field, what, value);
const BOUND = 1_000_000;

function check<T, L extends DrainLock>(i: DrainInput<T, L>): void {
  if (typeof i !== "object" || i === null) throw input("input", "must be an object", i);
  checkTransactor(FN, i.tx);
  if (!Array.isArray(i.sources)) throw input("sources", "must be an array", i.sources);
  for (const s of i.sources) {
    const src = s as Partial<DrainSource<T>> | null;
    if (typeof src?.source !== "string" || typeof src.lockName !== "string") {
      throw input("sources[]", "must each be { source: string, lockName: string }", s);
    }
    if (src.handle !== undefined && !isFn(src.handle)) {
      throw input("sources[].handle", "must be a function when given", src.handle);
    }
  }
  if (typeof i.worker !== "string" || i.worker === "") {
    throw input("worker", "must be a non-empty string", i.worker);
  }
  if (!intIn(i.limit, 1, Number.MAX_SAFE_INTEGER)) {
    throw input("limit", "must be a positive integer", i.limit);
  }
  for (const k of ["maxArchivals", "minRowsForAllFailed", "contendedBrake"] as const) {
    if (!intIn(i[k], 1, BOUND)) throw input(k, `must be an integer in 1–${BOUND}`, i[k]);
  }
  for (const k of ["acquire", "isHeld", "isFatal", "errorClassOf", "interrupted"] as const) {
    if (!isFn(i[k])) throw input(k, "must be a function", i[k]);
  }
  if (i.archivedBefore !== undefined && !isFn(i.archivedBefore)) {
    throw input("archivedBefore", "must be a function when given", i.archivedBefore);
  }
  const held = i.heldClass as Partial<Record<HeldWhy, unknown>> | null;
  for (const k of ["capped", "interrupted", "aborted"] as const) {
    if (typeof held?.[k] !== "string" || held[k] === "") {
      throw input(`heldClass.${k}`, "must be a non-empty string", held?.[k]);
    }
  }
  const rec = i.record as Partial<DrainInput<T, L>["record"]> | null;
  if (!isFn(rec?.start) || !isFn(rec?.settle)) {
    throw input("record", "must be { start, settle }", i.record);
  }
}

/** A part count a handler reported: a non-negative safe integer, else 0. */
const parts = (n: unknown): number => (intIn(n, 0, Number.MAX_SAFE_INTEGER) ? n : 0);

/** The drain's state shared across sources: one cap, one contention streak. */
interface Shared {
  archived: number;
  capped: boolean;
  contendedRun: number;
  jammed: boolean;
}

/**
 * Drains a queue source by source (contract §4.2): each under its own lock
 * taken without waiting, a claimed batch handed row by row to its handler,
 * acked or failed, with one archival cap across the whole drain, a
 * contention brake, an interrupt, and a fatal stop. The record is the
 * consumer's: started after a claim that returned rows, settled once.
 */
export async function drainQueue<T, L extends DrainLock>(
  input: DrainInput<T, L>,
  deps: DrainDeps = {},
): Promise<DrainReport> {
  check(input);
  const emit = (e: RunnerEvent): void => safeHook(deps.onEvent, e);
  const shared: Shared = { archived: 0, capped: false, contendedRun: 0, jammed: false };
  const drains: SourceDrain[] = [];
  let status: 0 | 1 = 0;

  for (const src of input.sources) {
    if (src.handle === undefined) {
      emit({ type: "drain.no_handler", source: src.source });
      continue;
    }
    if (shared.capped || shared.jammed || input.interrupted()) {
      emit({
        type: "drain.sources_stopped",
        source: src.source,
        reason: shared.capped ? "archival-cap" : shared.jammed ? "queue-jammed" : "interrupted",
      });
      status = 1;
      break;
    }
    const drain: SourceDrain = {
      source: src.source,
      handled: 0,
      acked: 0,
      failed: 0,
      archived: 0,
      excluded: 0,
      dead: 0,
      skippedLocked: 0,
      contended: 0,
      jammed: 0,
    };
    drains.push(drain);
    if (await drainSource(input, deps, emit, shared, src, drain)) status = 1;
  }

  emit({ type: "drain.done", worker: input.worker, status, archived: shared.archived, drains });
  return { worker: input.worker, status, drains, archived: shared.archived };
}

/** One source (D2). True when the caller should page. */
async function drainSource<T, L extends DrainLock>(
  i: DrainInput<T, L>,
  deps: DrainDeps,
  emit: (e: RunnerEvent) => void,
  shared: Shared,
  src: DrainSource<T>,
  drain: SourceDrain,
): Promise<boolean> {
  const source = src.source;
  const handle = src.handle as NonNullable<DrainSource<T>["handle"]>;
  let recorded = false;
  let record: T | null = null;

  let lock: L;
  try {
    lock = await i.acquire(src);
  } catch (err) {
    if (!i.isHeld(err)) throw err;
    drain.skippedLocked = 1;
    emit({ type: "drain.skipped_locked", source, lockName: src.lockName });
    return false;
  }

  try {
    lock.startKeepalive();
    const rows = await claim(
      i.tx.sql,
      i.queue,
      { source, limit: i.limit, worker: i.worker },
      deps.queueHooks,
    );
    if (rows.length === 0) {
      emit({ type: "drain.empty", source });
      return false;
    }
    shared.contendedRun = 0;
    record = await i.record.start(lock, source);
    const state = await rowLoop(i, deps, emit, shared, src, drain, rows, handle, lock, record);

    const allFailed = drain.handled >= i.minRowsForAllFailed && state.threw === drain.handled;
    if (allFailed) emit({ type: "drain.all_failed", source, handled: drain.handled });
    if (drain.dead > 0) emit({ type: "drain.dead_lettered", source, dead: drain.dead });
    const failure: DrainFailure | undefined = state.fatal.set
      ? { kind: "fatal", error: state.fatal.error }
      : firstFailure(drain, {
          stopped: state.stopped,
          jammed: state.jammed,
          capped: shared.capped,
          allFailed,
          archived: shared.archived,
          cap: i.maxArchivals,
        });
    recorded = true;
    await i.record.settle(record, failure === undefined ? { drain } : { drain, failure });
    if (failure === undefined) return false;
    if (failure.kind === "fatal") emit({ type: "drain.aborted", source, error: failure.error });
    return true;
  } catch (err) {
    emit({ type: "drain.failed", source, error: err });
    if (recorded) return true;
    try {
      await i.record.settle(record, { drain, failure: { kind: "queue", error: err } });
    } catch (error) {
      emit({ type: "drain.settle_failed", source, error });
    }
    return true;
  } finally {
    lock.stopKeepalive();
    await lock.release();
  }
}

/** Why a row loop ended early. */
interface LoopState {
  stopped: boolean;
  fatal: { set: boolean; error: unknown };
  threw: number;
  jammed: boolean;
}

/** D3: one claimed batch, row by row. */
async function rowLoop<T, L extends DrainLock>(
  i: DrainInput<T, L>,
  deps: DrainDeps,
  emit: (e: RunnerEvent) => void,
  shared: Shared,
  src: DrainSource<T>,
  drain: SourceDrain,
  rows: readonly QueueRow[],
  handle: NonNullable<DrainSource<T>["handle"]>,
  lock: L,
  record: T | null,
): Promise<LoopState> {
  const source = src.source;
  const { tx, queue, worker } = i;
  const state: LoopState = {
    stopped: false,
    fatal: { set: false, error: undefined },
    threw: 0,
    jammed: false,
  };
  const jam = (n: number): void => {
    state.jammed = true;
    drain.jammed = n;
    emit({ type: "drain.queue_jammed", source, unprocessed: n, leftClaimed: n + drain.contended });
  };
  /** Runs one ack or fail, absorbing only a lock timeout (55P03). */
  const settleRow = async <R>(
    row: QueueRow,
    operation: "ack" | "fail",
    op: () => Promise<R>,
  ): Promise<R | undefined> => {
    try {
      const done = await op();
      shared.contendedRun = 0;
      return done;
    } catch (err) {
      if (pgCode(err) !== "55P03") throw err;
      drain.contended += 1;
      shared.contendedRun += 1;
      if (shared.contendedRun >= i.contendedBrake) shared.jammed = true;
      emit({ type: "drain.row_contended", source, key: row.key, operation });
      return undefined;
    }
  };
  /** Fails a row with `errorClass`, counting it when the fail landed. */
  const failRow = async (row: QueueRow, errorClass: string) => {
    const result = await settleRow(row, "fail", () =>
      fail(tx, queue, { key: row.key, worker, errorClass, claim: row.claim }, deps.queueHooks),
    );
    if (result !== undefined) drain.failed += 1;
    if (result?.result === "dead") drain.dead += 1;
    return result;
  };
  const charge = (n: number): void => {
    shared.archived += n;
    drain.archived += n;
  };
  const trip = (remaining: number): void => {
    if (shared.capped || shared.archived < i.maxArchivals) return;
    shared.capped = true;
    emit({
      type: "drain.archival_cap",
      source,
      archived: shared.archived,
      cap: i.maxArchivals,
      remaining,
    });
  };

  for (const [at, row] of rows.entries()) {
    if (shared.jammed) {
      jam(rows.length - at);
      break;
    }
    if (!state.stopped && i.interrupted()) {
      state.stopped = true;
      emit({
        type: "drain.interrupted",
        source,
        handled: drain.handled,
        remaining: rows.length - at,
      });
    }
    if (shared.capped || state.stopped || state.fatal.set) {
      const why: HeldWhy = shared.capped ? "capped" : state.stopped ? "interrupted" : "aborted";
      await failRow(row, i.heldClass[why]);
      continue;
    }
    drain.handled += 1;
    const ctx = {
      source,
      record,
      ensureExclusive: () => lock.ensureExclusive(),
      extend: () =>
        extendClaim(tx, queue, { key: row.key, worker, claim: row.claim }, deps.queueHooks),
    };
    let outcome: DrainOutcome;
    try {
      outcome = await handle(row, ctx);
    } catch (err) {
      state.threw += 1;
      const result = await failRow(row, i.errorClassOf(err));
      let before = 0;
      try {
        before = parts(i.archivedBefore?.(err));
      } catch {
        // A throwing archivedBefore counts nothing.
      }
      charge(before);
      emit({
        type: "drain.row_failed",
        source,
        key: row.key,
        kind: row.kind,
        attempts: result?.attempts ?? null,
        archivedBefore: before,
        error: err,
      });
      if (i.isFatal(err)) state.fatal = { set: true, error: err };
      trip(rows.length - at - 1);
      continue;
    }
    charge(parts(outcome?.archived));
    if (outcome?.excluded === true) drain.excluded += 1;
    const acked = await settleRow(row, "ack", () =>
      ack(tx, queue, { key: row.key, worker, claim: row.claim }, deps.queueHooks),
    );
    if (acked !== undefined) drain.acked += 1;
    trip(rows.length - at - 1);
  }
  if (shared.jammed && !state.jammed) jam(0);
  return state;
}

/** D4: the one reason this source's drain is not clean, in order. */
function firstFailure(
  drain: SourceDrain,
  s: {
    stopped: boolean;
    jammed: boolean;
    capped: boolean;
    allFailed: boolean;
    archived: number;
    cap: number;
  },
): DrainFailure | undefined {
  const leftClaimed = drain.jammed + drain.contended;
  if (s.capped) {
    return { kind: "capped", archived: s.archived, cap: s.cap, jammed: s.jammed, leftClaimed };
  }
  if (s.stopped) return { kind: "interrupted", jammed: s.jammed, leftClaimed };
  if (s.jammed) return { kind: "jammed", leftClaimed };
  if (s.allFailed) return { kind: "all-failed", handled: drain.handled };
  if (drain.dead > 0) return { kind: "dead", dead: drain.dead };
  return undefined;
}
