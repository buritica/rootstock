import { forEachBounded } from "../concurrency/index.ts";
import type { Transactor, TxSql } from "../db/index.ts";
import { intIn, q, safeHook } from "../internal/slice.ts";
import type { RunLock } from "../lock/index.ts";
import { getCursor, setCursor } from "../queue/index.ts";
import {
  type Breaker,
  pendingQuarantine,
  quarantineSafe,
  type Run,
  resolveQuarantine,
  startRun,
} from "../runs/index.ts";
import { RootstockRunnerError } from "./errors.ts";
import type {
  Exclusion,
  LoadContext,
  PlanAction,
  PlanArgs,
  PlanDeps,
  PlanItem,
  PullArgs,
  PullCounts,
  PullDeps,
  PullDoc,
  PullFailure,
  PullListing,
  PullPlan,
  PullRef,
  PullReport,
  PullSource,
  RunnerEvent,
} from "./types.ts";

const BATCH = { lo: 1, hi: 10_000 } as const;
const WIDTH = { lo: 1, hi: 64 } as const;
const REFS = { lo: 1, hi: 1_000_000 } as const;

/** An error's message when it has a non-empty one, else its string form. Never throws. */
export function messageOf(err: unknown): string {
  try {
    const m = (err as { message?: unknown } | null)?.message;
    if (typeof m === "string" && m !== "") return m;
  } catch {
    // Falls through to the string form.
  }
  try {
    return String(err);
  } catch {
    return "unprintable error";
  }
}

/** The id-mismatch text (T1). */
export const mismatchReason = (asked: string, got: unknown): string =>
  `fetched a doc for a different externalId: asked for ${asked}, got ${safeString(got)}`;

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return "unprintable value";
  }
}

/** A consumer's text function, falling back to `fallback` on a throw or a non-string. */
function guardedText<A extends unknown[]>(
  fn: ((...a: A) => string) | undefined,
  fallback: (...a: A) => string,
): (...a: A) => string {
  if (fn === undefined) return fallback;
  return (...a) => {
    try {
      const out = fn(...a);
      if (typeof out === "string") return out;
    } catch {
      // Falls back below.
    }
    return fallback(...a);
  };
}

/** The runner's own reason for each failure (contract §2.5). */
export function defaultReason(
  f: PullFailure,
  describe: (err: unknown) => string = messageOf,
): string {
  const d = guardedText(describe, messageOf);
  switch (f.kind) {
    case "options": {
      const b = f.field === "batchSize" ? BATCH : WIDTH;
      return `rootstock runner: ${f.field} must be an integer in ${b.lo}–${b.hi}, got ${json(f.value)}`;
    }
    case "list":
      return `rootstock runner: list failed: ${d(f.error)}`;
    case "lost-lock":
      return `rootstock runner: lost the run lock: ${d(f.error)}`;
    case "batch":
      return `rootstock runner: batch failed: ${d(f.error)}`;
    case "quota":
      return `rootstock runner: ${f.count} quota failures in a row; the run stopped after ${f.externalId}, committed through it`;
    case "cursor":
      return `rootstock runner: could not store the cursor on an empty listing: ${d(f.error)}`;
    case "threw":
      return `rootstock runner: run threw: ${d(f.error)}`;
    case "identity":
      return "rootstock runner: the buckets do not balance";
  }
}

function json(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? safeString(v) : s;
  } catch {
    return safeString(v);
  }
}

const input = (fn: string, field: string, what: string, value: unknown): RootstockRunnerError =>
  new RootstockRunnerError(
    "ERR_ROOTSTOCK_RUNNER_INPUT",
    `${fn}(): ${field} ${what} — got ${q(value)}`,
  );

const isFn = (v: unknown): boolean => typeof v === "function";

/** "Set" means a non-empty string (F17). */
const hasHash = (h: unknown): h is string => typeof h === "string" && h !== "";

/** Shape checks shared by runPull and planPull; every refusal is before any I/O. */
function checkSource(fn: string, source: unknown, since: unknown): void {
  const s = source as Partial<PullSource<PullRef, PullDoc, unknown>> | null;
  if (typeof s !== "object" || s === null) throw input(fn, "source", "must be an object", source);
  if (typeof s.job !== "string" || s.job === "") {
    throw input(fn, "source.job", "must be a non-empty string", s.job);
  }
  for (const k of ["cursorOf", "list", "fetch", "existing", "load"] as const) {
    if (!isFn(s[k])) throw input(fn, `source.${k}`, "must be a function", s[k]);
  }
  for (const k of ["tryRepoint", "planLoad"] as const) {
    if (s[k] !== undefined && !isFn(s[k])) {
      throw input(fn, `source.${k}`, "must be a function when given", s[k]);
    }
  }
  if (since !== undefined) {
    if (!(since instanceof Date) || !Number.isFinite(since.getTime())) {
      throw input(fn, "since", "must be a valid Date when given", since);
    }
    if (s.boundedBackfill !== true) {
      throw new RootstockRunnerError(
        "ERR_ROOTSTOCK_RUNNER_BACKFILL",
        `${q(s.job)} cannot honour a backfill window (boundedBackfill is not declared) — refusing rather than listing the whole source`,
      );
    }
  }
}

function checkCommon(
  fn: string,
  a: { tx?: unknown; describe?: unknown; mismatchReason?: unknown },
): void {
  const t = a.tx as Partial<Transactor> | null;
  if (typeof t !== "object" || t === null || !isFn(t.begin) || typeof t.sql !== "function") {
    throw input(fn, "tx", "must be a Transactor", a.tx);
  }
  for (const k of ["describe", "mismatchReason"] as const) {
    if (a[k] !== undefined && !isFn(a[k])) {
      throw input(fn, k, "must be a function when given", a[k]);
    }
  }
}

function checkLock(fn: string, lock: unknown, field: string): void {
  const l = lock as Partial<RunLock> | null;
  if (typeof l !== "object" || l === null || !isFn(l.ensureExclusive)) {
    throw input(fn, field, "must be a RunLock", lock);
  }
}

/** Exclusions summed and folded, first-seen order (P5); a refusal when malformed. */
function foldExclusions(
  excluded: readonly Exclusion[] | undefined,
): { total: number; reasons: Exclusion[] } | RootstockRunnerError {
  if (excluded === undefined) return { total: 0, reasons: [] };
  if (!Array.isArray(excluded)) {
    return input("list", "excluded", "must be an array when given", excluded);
  }
  const byReason = new Map<string, number>();
  let total = 0;
  for (const e of excluded) {
    const reason = (e as Exclusion | null)?.reason;
    const count = (e as Exclusion | null)?.count;
    if (
      typeof reason !== "string" ||
      reason === "" ||
      reason.includes("\u0000") ||
      !intIn(count, 0, Number.MAX_SAFE_INTEGER)
    ) {
      return input(
        "list",
        "excluded",
        "entries must be { reason: non-empty string without NUL, count: non-negative integer }",
        e,
      );
    }
    total += count;
    byReason.set(reason, (byReason.get(reason) ?? 0) + count);
  }
  return { total, reasons: [...byReason].map(([reason, count]) => ({ reason, count })) };
}

function checkListing<R extends PullRef>(listing: unknown): PullListing<R> {
  const l = listing as Partial<PullListing<R>> | null;
  if (typeof l !== "object" || l === null || !Array.isArray(l.refs)) {
    throw input("list", "result", "must be { refs: array }", listing);
  }
  for (const r of l.refs) {
    if (typeof (r as PullRef | null)?.externalId !== "string") {
      throw input("list", "refs[]", "must each carry a string externalId", r);
    }
  }
  return l as PullListing<R>;
}

/** Internal sentinel: a gate inside the batch transaction refused; carries its error. */
class GateLost extends Error {
  override readonly name = "GateLost";
  readonly error: unknown;
  constructor(error: unknown) {
    super("lost the run lock inside the batch");
    this.error = error;
  }
}

/** Internal sentinel: a plan's transaction always rolls back. */
class PlanRollback extends Error {
  override readonly name = "PlanRollback";
}

/** A pass's fetch outcome for one ref position. */
type Fetched<D> = { doc: D } | { error: unknown };

type Klass = "dup-done" | "skip" | "fetch";

/**
 * Fetches the `fetch`-classified refs outside any transaction, at most
 * `width` at a time, gating before each. A fetch throw is that ref's outcome;
 * a gate throw rejects (after in-flight fetches settle).
 */
async function fetchAll<R extends PullRef, D extends PullDoc>(
  source: PullSource<R, D, unknown>,
  batch: readonly R[],
  klass: readonly Klass[],
  width: number,
  gate: (() => Promise<void>) | undefined,
): Promise<Map<number, Fetched<D>>> {
  const out = new Map<number, Fetched<D>>();
  const positions: number[] = [];
  klass.forEach((k, i) => {
    if (k === "fetch") positions.push(i);
  });
  await forEachBounded(
    positions,
    gate === undefined ? { width } : { width, before: gate },
    async (i) => {
      try {
        out.set(i, { doc: await source.fetch(batch[i] as R) });
      } catch (error) {
        out.set(i, { error });
      }
    },
  );
  return out;
}

interface Totals {
  fetched: number;
  written: number;
  unchanged: number;
  quarantined: number;
  repointed: number;
}

const zero = (): Totals => ({ fetched: 0, written: 0, unchanged: 0, quarantined: 0, repointed: 0 });

/** A plan's LoadContext: nothing reaches a run. */
const PLAN_CTX: LoadContext = Object.freeze({
  quotaHit() {},
  meter() {},
  count() {},
});

/**
 * Runs a pull source to completion (contract §2.2, §14): start the run row,
 * read the cursor, list, then per batch fetch outside any transaction and
 * load inside one, the cursor moving with the batch that covers it. Settles
 * the row on every path. The lock is the caller's: gated, never released.
 */
export async function runPull<R extends PullRef, D extends PullDoc, N>(
  args: PullArgs<R, D, N>,
  deps: PullDeps,
): Promise<PullReport> {
  const fn = "runPull";
  if (typeof args !== "object" || args === null) throw input(fn, "args", "must be an object", args);
  checkCommon(fn, args);
  checkLock(fn, args.lock, "lock");
  checkSource(fn, args.source, args.since);
  if (typeof args.mode !== "string") throw input(fn, "mode", "must be a string", args.mode);
  if (args.reasonOf !== undefined && !isFn(args.reasonOf)) {
    throw input(fn, "reasonOf", "must be a function when given", args.reasonOf);
  }
  if (args.afterRun !== undefined && !isFn(args.afterRun)) {
    throw input(fn, "afterRun", "must be a function when given", args.afterRun);
  }
  const quota = args.quota as Partial<NonNullable<PullArgs<R, D, N>["quota"]>> | undefined;
  if (quota !== undefined && (!isFn(quota?.make) || !isFn(quota?.isQuota))) {
    throw input(fn, "quota", "must be { make, isQuota } when given", args.quota);
  }
  if (typeof deps !== "object" || deps === null || typeof deps.runs !== "object") {
    throw input(fn, "deps.runs", "must be RunsDeps", deps);
  }
  const { tx, source, lock, mode, since } = args;
  const backfill = since !== undefined;
  const emit = (e: RunnerEvent): void => safeHook(deps.onEvent, e);
  const describe = guardedText(args.describe, messageOf);
  const fallbackReason = (f: PullFailure): string => defaultReason(f, describe);
  const reasonOf = guardedText(args.reasonOf, fallbackReason);

  // P1
  let run: Run;
  try {
    run = await startRun(
      tx.sql,
      args.runs,
      {
        job: source.job,
        mode,
        lock,
        ...(args.afterRun === undefined ? {} : { afterRun: args.afterRun }),
      },
      deps.runs,
    );
  } catch (cause) {
    throw new RootstockRunnerError(
      "ERR_ROOTSTOCK_RUNNER_START",
      `could not start the run record: ${describe(cause)}`,
      { cause },
    );
  }
  emit({ type: "runner.pull_started", job: source.job, runId: run.id, mode, backfill });

  const counts: PullCounts = {
    listed: 0,
    excluded: 0,
    excludedReasons: [],
    ...zero(),
  };
  /** A run call that must never fail the pull: a refusal is an event. */
  const guarded = (call: "account" | "count" | "meter", f: () => void): void => {
    try {
      f();
    } catch (error) {
      emit({ type: "runner.settle_refused", job: source.job, runId: run.id, call, error });
    }
  };

  const settle = async (failure?: PullFailure): Promise<PullReport> => {
    // P9 (F19): account first, then each count, each guarded.
    guarded("account", () =>
      run.account({
        listed: counts.listed,
        written: counts.written,
        unchanged: counts.unchanged,
        quarantined: counts.quarantined,
        excluded: counts.excluded,
        excludedReasons: Object.fromEntries(counts.excludedReasons.map((e) => [e.reason, e.count])),
      }),
    );
    guarded("count", () => run.count("fetched", counts.fetched));
    guarded("count", () => run.count("repointed", counts.repointed));
    const balanced =
      counts.listed === counts.written + counts.unchanged + counts.quarantined + counts.excluded;
    const f: PullFailure | undefined = failure ?? (balanced ? undefined : { kind: "identity" });
    const status = f === undefined ? "ok" : "failed";
    const reason = f === undefined || f.kind === "identity" ? undefined : reasonOf(f);
    const finish = await run.finish(status, reason === undefined ? undefined : { reason });
    emit({
      type: "runner.pull_finished",
      job: source.job,
      runId: run.id,
      status,
      failure: f?.kind ?? null,
    });
    return {
      job: source.job,
      mode,
      runId: run.id,
      status,
      ...counts,
      excludedReasons: [...counts.excludedReasons],
      ...(f === undefined ? {} : { failure: f }),
      finish,
    };
  };

  let settled = false;
  const settleOnce = (failure?: PullFailure): Promise<PullReport> => {
    settled = true;
    return settle(failure);
  };
  try {
    return await pullLocked(args, deps, run, counts, settleOnce, emit, guarded, describe);
  } catch (error) {
    // The guard (F20): settle `threw` with the totals committed so far, rethrow the original.
    if (!settled) {
      try {
        await settle({ kind: "threw", error });
      } catch {
        // The original error is the one the caller needs.
      }
    }
    throw error;
  }
}

async function pullLocked<R extends PullRef, D extends PullDoc, N>(
  args: PullArgs<R, D, N>,
  deps: PullDeps,
  run: Run,
  counts: PullCounts,
  settle: (failure?: PullFailure) => Promise<PullReport>,
  emit: (e: RunnerEvent) => void,
  guarded: (call: "account" | "count" | "meter", f: () => void) => void,
  describe: (err: unknown) => string,
): Promise<PullReport> {
  const { tx, source, lock, since } = args;
  const backfill = since !== undefined;
  const mismatch = guardedText(args.mismatchReason, mismatchReason);
  // P2
  const breaker: Breaker | undefined = args.quota?.make(deps.runs);
  // P3
  if (!intIn(args.batchSize, BATCH.lo, BATCH.hi)) {
    return settle({ kind: "options", field: "batchSize", value: args.batchSize });
  }
  if (!intIn(args.fetchConcurrency, WIDTH.lo, WIDTH.hi)) {
    return settle({ kind: "options", field: "fetchConcurrency", value: args.fetchConcurrency });
  }
  const gate = (): Promise<void> => lock.ensureExclusive();
  const gateIn = async (): Promise<void> => {
    try {
      await gate();
    } catch (error) {
      throw new GateLost(error);
    }
  };

  // P4
  try {
    await gate();
  } catch (error) {
    return settle({ kind: "lost-lock", error });
  }
  let listing: PullListing<R>;
  try {
    const cursor = backfill
      ? undefined
      : await getCursor(tx.sql, args.cursors, source.job, deps.queueHooks);
    listing = checkListing<R>(await source.list(cursor, since));
  } catch (error) {
    return settle({ kind: "list", error });
  }
  // P5
  const folded = foldExclusions(listing.excluded);
  if (folded instanceof RootstockRunnerError) return settle({ kind: "list", error: folded });
  const refs = listing.refs;
  counts.excluded = folded.total;
  counts.excludedReasons = folded.reasons;
  counts.listed = refs.length + folded.total;

  // P6
  const idCounts = new Map<string, number>();
  for (const r of refs) idCounts.set(r.externalId, (idCounts.get(r.externalId) ?? 0) + 1);
  const processed = new Set<string>();
  const repeated = (id: string): boolean => (idCounts.get(id) ?? 0) > 1;

  // P7
  let batchNo = 0;
  for (let at = 0; at < refs.length; at += args.batchSize) {
    const batch = refs.slice(at, at + args.batchSize);
    batchNo += 1;
    // P7.1
    try {
      await gate();
    } catch (error) {
      return settle({ kind: "lost-lock", error });
    }
    const ids = batch.map((r) => r.externalId);
    // P7.2
    let known: ReadonlyMap<string, string | null>;
    try {
      known = await source.existing(ids);
    } catch (error) {
      return settle({ kind: "batch", error });
    }
    // P7.3
    const klass: Klass[] = batch.map((r) => {
      if (repeated(r.externalId) && processed.has(r.externalId)) return "dup-done";
      if (hasHash(r.contentHash) && known.get(r.externalId) === r.contentHash) return "skip";
      return "fetch";
    });
    // P7.4
    let fetched: Map<number, Fetched<D>>;
    try {
      fetched = await fetchAll(
        source as PullSource<R, D, unknown>,
        batch,
        klass,
        args.fetchConcurrency,
        gate,
      );
      // P7.4, last gate: the fetches may have taken minutes.
      await gate();
    } catch (error) {
      return settle({ kind: "lost-lock", error });
    }

    // P7.5
    const b = zero();
    const batchProcessed = new Set<string>();
    /** The batch position of the ref that tripped the breaker (F6), else -1. */
    let trippedAt = -1;
    try {
      await tx.begin(async (t: TxSql<N>) => {
        const pending = new Set(
          (await pendingQuarantine(t, args.quarantine, { job: source.job, externalIds: ids })).map(
            (p) => p.externalId,
          ),
        );
        const toResolve: string[] = [];
        const quarantinedHere = new Set<string>();
        const put = async (externalId: string, payload: unknown, reason: string): Promise<void> => {
          await quarantineSafe(
            t,
            args.quarantine,
            { job: source.job, externalId, payload, reason, runId: run.id },
            deps.runs,
          );
          b.quarantined += 1;
          quarantinedHere.add(externalId);
        };
        const mark = (id: string): void => {
          if (repeated(id)) batchProcessed.add(id);
        };
        /** One breaker hit; true once it has tripped. */
        const hit = (): boolean => {
          if (breaker === undefined) return false;
          breaker.hit();
          return breaker.tripped;
        };

        for (const [i, ref] of batch.entries()) {
          const id = ref.externalId;
          // a
          if (klass[i] === "dup-done" || (repeated(id) && batchProcessed.has(id))) {
            b.quarantined += 1;
            continue;
          }
          // b
          if (klass[i] === "skip") {
            b.unchanged += 1;
            mark(id);
            continue;
          }
          const got = fetched.get(i) as Fetched<D>;
          // c
          if ("error" in got) {
            await put(id, ref, describe(got.error));
            continue;
          }
          const doc = got.doc;
          // d
          if (doc?.externalId !== id) {
            await put(id, ref, mismatch(id, doc?.externalId));
            continue;
          }
          // e
          b.fetched += 1;
          // F7: gate before the doc's writes.
          await gateIn();
          const flag = { hit: false };
          const ctx: LoadContext = {
            quotaHit: () => {
              flag.hit = true;
            },
            meter: (model, inTok, outTok, opts) =>
              guarded("meter", () => run.meter(model, inTok, outTok, opts)),
            count: (name, n) => guarded("count", () => run.count(name, n)),
          };
          // f
          const tryRepoint = source.tryRepoint;
          if (tryRepoint !== undefined && !known.has(doc.externalId)) {
            let claimed = false;
            try {
              claimed = await t.savepoint((_sp, n) => tryRepoint.call(source, n, doc, ctx));
            } catch (error) {
              emit({ type: "runner.repoint_failed", job: source.job, externalId: id, error });
            }
            if (claimed === true) {
              b.repointed += 1;
              b.unchanged += 1;
              mark(id);
              if (flag.hit && hit()) {
                trippedAt = i;
                break;
              }
              continue;
            }
          }
          // g
          if (!hasHash(ref.contentHash) && known.get(doc.externalId) === doc.contentHash) {
            b.unchanged += 1;
            mark(id);
            if (flag.hit && hit()) {
              trippedAt = i;
              break;
            }
            continue;
          }
          // h
          try {
            await t.savepoint((_sp, n) => source.load(n, doc, ctx));
          } catch (err) {
            await put(id, doc, describe(err));
            if ((flag.hit || args.quota?.isQuota(err) === true) && hit()) {
              trippedAt = i;
              break;
            }
            continue;
          }
          b.written += 1;
          mark(id);
          if (pending.has(id)) toResolve.push(id);
          if (flag.hit) {
            if (hit()) {
              trippedAt = i;
              break;
            }
          } else {
            breaker?.clear();
          }
        }

        // 3
        const resolve = toResolve.filter((id) => !quarantinedHere.has(id));
        if (resolve.length > 0) {
          try {
            await t.savepoint((sp) =>
              resolveQuarantine(
                sp,
                args.quarantine,
                { job: source.job, externalIds: resolve },
                deps.runs,
              ),
            );
          } catch (error) {
            emit({ type: "runner.resolve_failed", job: source.job, count: resolve.length, error });
          }
        }
        // 4: the cursor of the last ref this batch covered.
        const last = batch[trippedAt === -1 ? batch.length - 1 : trippedAt];
        if (last !== undefined && !backfill) {
          await setCursor(t, args.cursors, source.job, source.cursorOf(last), deps.queueHooks);
        }
        // F7: the transaction's last step.
        await gateIn();
      });
    } catch (error) {
      // P7.6: the batch rolled back; the totals are those before it.
      if (error instanceof GateLost) {
        emit({
          type: "runner.batch_rolled_back",
          job: source.job,
          runId: run.id,
          batch: batchNo,
          kind: "lost-lock",
        });
        return settle({ kind: "lost-lock", error: error.error });
      }
      emit({
        type: "runner.batch_rolled_back",
        job: source.job,
        runId: run.id,
        batch: batchNo,
        kind: "batch",
      });
      return settle({ kind: "batch", error });
    }
    for (const id of batchProcessed) processed.add(id);
    counts.fetched += b.fetched;
    counts.written += b.written;
    counts.unchanged += b.unchanged;
    counts.quarantined += b.quarantined;
    counts.repointed += b.repointed;
    emit({
      type: "runner.batch_committed",
      job: source.job,
      runId: run.id,
      batch: batchNo,
      size: trippedAt === -1 ? batch.length : trippedAt + 1,
      written: b.written,
      unchanged: b.unchanged,
      quarantined: b.quarantined,
    });
    // F6: the batch committed through the tripping ref; the run stops here.
    if (trippedAt !== -1) {
      return settle({
        kind: "quota",
        count: breaker?.count ?? 0,
        externalId: (batch[trippedAt] as R).externalId,
      });
    }
  }

  // P8
  if (refs.length === 0 && listing.nextCursor !== undefined && !backfill) {
    try {
      await gate();
    } catch (error) {
      return settle({ kind: "lost-lock", error });
    }
    try {
      await setCursor(tx.sql, args.cursors, source.job, listing.nextCursor, deps.queueHooks);
    } catch (error) {
      return settle({ kind: "cursor", error });
    }
  }

  // P9
  return settle();
}

const ACTIONS: readonly PlanAction[] = [
  "unchanged",
  "duplicate",
  "new",
  "changed",
  "fetch-failed",
  "id-mismatch",
];

/**
 * Plans a pull (contract §3, §14 F5): list, then per batch skip and fetch
 * exactly as a run would, stop before load and say what each ref would do.
 * Writes nothing: no run row, no cursor, no quarantine. A source with
 * `planLoad` gets each batch's docs that would load inside a READ ONLY
 * transaction, opened after that batch's fetches, that always rolls back.
 */
export async function planPull<R extends PullRef, D extends PullDoc, N>(
  args: PlanArgs<R, D, N>,
  deps: PlanDeps = {},
): Promise<PullPlan> {
  const fn = "planPull";
  if (typeof args !== "object" || args === null) throw input(fn, "args", "must be an object", args);
  checkCommon(fn, args);
  if (args.lock !== undefined) checkLock(fn, args.lock, "lock");
  checkSource(fn, args.source, args.since);
  if (!intIn(args.batchSize, BATCH.lo, BATCH.hi)) {
    throw input(fn, "batchSize", `must be an integer in ${BATCH.lo}–${BATCH.hi}`, args.batchSize);
  }
  if (!intIn(args.fetchConcurrency, WIDTH.lo, WIDTH.hi)) {
    throw input(
      fn,
      "fetchConcurrency",
      `must be an integer in ${WIDTH.lo}–${WIDTH.hi}`,
      args.fetchConcurrency,
    );
  }
  if (args.maxRefs !== undefined && !intIn(args.maxRefs, REFS.lo, REFS.hi)) {
    throw input(
      fn,
      "maxRefs",
      `must be an integer in ${REFS.lo}–${REFS.hi} when given`,
      args.maxRefs,
    );
  }
  const { tx, source, lock, since } = args;
  const backfill = since !== undefined;
  const gate = lock === undefined ? undefined : (): Promise<void> => lock.ensureExclusive();
  const describe = guardedText(args.describe, messageOf);
  const mismatch = guardedText(args.mismatchReason, mismatchReason);

  await gate?.();
  const stored = backfill
    ? undefined
    : await getCursor(tx.sql, args.cursors, source.job, deps.queueHooks);
  const listing = checkListing<R>(await source.list(stored, since));
  const folded = foldExclusions(listing.excluded);
  if (folded instanceof RootstockRunnerError) throw folded;
  const all = listing.refs;
  const refs = args.maxRefs === undefined ? all : all.slice(0, args.maxRefs);

  // Earlier occurrences that would count: anything but a fetch failure or a mismatch.
  const counted = new Set<string>();
  const items: PlanItem[] = [];
  const planLoad = source.planLoad;

  for (let at = 0; at < refs.length; at += args.batchSize) {
    const batch = refs.slice(at, at + args.batchSize);
    await gate?.();
    const known = await source.existing(batch.map((r) => r.externalId));
    // A duplicate is decided after the fetch (an earlier failed fetch does not count), so
    // classify skip/fetch first and resolve duplicates in order below.
    const klass: Klass[] = batch.map((r) =>
      hasHash(r.contentHash) && known.get(r.externalId) === r.contentHash ? "skip" : "fetch",
    );
    const fetched = await fetchAll(
      source as PullSource<R, D, unknown>,
      batch,
      klass,
      args.fetchConcurrency,
      gate,
    );

    const toPlan: { item: PlanItem; doc: D }[] = [];
    batch.forEach((ref, i) => {
      const id = ref.externalId;
      if (counted.has(id)) {
        items.push({ externalId: id, action: "duplicate" });
        return;
      }
      if (klass[i] === "skip") {
        counted.add(id);
        items.push({ externalId: id, action: "unchanged" });
        return;
      }
      const got = fetched.get(i) as Fetched<D>;
      if ("error" in got) {
        items.push({ externalId: id, action: "fetch-failed", reason: describe(got.error) });
        return;
      }
      const doc = got.doc;
      if (doc?.externalId !== id) {
        items.push({
          externalId: id,
          action: "id-mismatch",
          reason: mismatch(id, doc?.externalId),
        });
        return;
      }
      counted.add(id);
      if (!known.has(id)) {
        const item: PlanItem = { externalId: id, action: "new" };
        items.push(item);
        toPlan.push({ item, doc });
        return;
      }
      if (!hasHash(ref.contentHash) && known.get(id) === doc.contentHash) {
        items.push({ externalId: id, action: "unchanged" });
        return;
      }
      const item: PlanItem = { externalId: id, action: "changed" };
      items.push(item);
      toPlan.push({ item, doc });
    });

    if (planLoad !== undefined && toPlan.length > 0) {
      try {
        await tx.begin(async (t: TxSql<N>) => {
          await t`SET TRANSACTION READ ONLY`;
          for (const p of toPlan) {
            try {
              p.item.detail = await t.savepoint((_sp, n) =>
                planLoad.call(source, n, p.doc, PLAN_CTX),
              );
            } catch (err) {
              p.item.detail = { error: describe(err) };
            }
          }
          throw new PlanRollback();
        });
      } catch (err) {
        if (!(err instanceof PlanRollback)) throw err;
      }
    }
  }

  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
  for (const it of items) counts[it.action] += 1;
  const last = refs[refs.length - 1];
  const wouldStore = backfill
    ? undefined
    : last !== undefined
      ? source.cursorOf(last)
      : listing.nextCursor;
  return {
    job: source.job,
    cursor: { stored, wouldStore },
    listed: all.length + folded.total,
    excluded: folded.total,
    excludedReasons: folded.reasons,
    truncated: refs.length < all.length,
    items,
    counts,
  };
}
