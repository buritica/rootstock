import type { Transactor } from "../db/index.ts";
import type { RunLock } from "../lock/index.ts";
import type {
  CursorTable,
  ExtendResult,
  QueueHooks,
  QueueRow,
  QueueSlice,
} from "../queue/index.ts";
import type {
  Breaker,
  FinishResult,
  QuarantineTable,
  RunRow,
  RunsDeps,
  RunsSlice,
} from "../runs/index.ts";

/** What the runner reads from a ref. A source's own ref type extends it. */
export interface PullRef {
  externalId: string;
  /** When the source knows the hash before fetching: enables the skip before fetch. */
  contentHash?: string;
}

/** What the runner reads from a fetched doc. */
export interface PullDoc {
  externalId: string;
  contentHash: string;
}

/** One reason a listing left records out, and how many. */
export interface Exclusion {
  reason: string;
  count: number;
}

export interface PullListing<R extends PullRef> {
  refs: readonly R[];
  /** Seen and deliberately left out. Each count a non-negative integer; repeated reasons are summed. */
  excluded?: readonly Exclusion[];
  /** Read only when `refs` is empty: the cursor to land (undefined: leave it). */
  nextCursor?: unknown;
}

/**
 * What a source's `load`, `tryRepoint` and `planLoad` may tell the run. In a
 * plan, `meter` and `count` do nothing and `quotaHit` is ignored.
 */
export interface LoadContext {
  /** This doc hit a quota (e.g. a rate limit it absorbed): one breaker hit, the doc still counts as loaded. */
  quotaHit(): void;
  /** Forwards to the run's `meter`; a refusal is an event, never a load failure. */
  meter(model: string, input: number, output: number, opts?: { estimated?: boolean }): void;
  /** Forwards to the run's `count`; a refusal is an event, never a load failure. */
  count(name: string, n?: number): void;
}

export interface PullSource<R extends PullRef, D extends PullDoc, N> {
  /** The runs job, the quarantine job and the cursor name. */
  readonly job: string;
  /** Can `list` honour a backfill window? Absent = no. */
  readonly boundedBackfill?: boolean;
  /**
   * The cursor to store once a batch ending in `ref` commits: a JSON value,
   * monotone in list order. `list(cursorOf(r))` must return every ref that
   * followed `r` in the listing (equal cursors across a boundary need an
   * inclusive `list`).
   */
  cursorOf(ref: R): unknown;
  /** `cursor` is undefined when none is stored, and on a backfill; `since` is given only on a backfill. */
  list(cursor: unknown, since?: Date): Promise<PullListing<R>>;
  /** Called outside any transaction. */
  fetch: (ref: R) => Promise<D>;
  /**
   * The stored hash per external id among `ids`, read outside any
   * transaction. A known id whose hash is null must be loaded again (it never
   * matches); an id absent from the map has no row.
   */
  existing(ids: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  /** Optional rename hook, inside the batch transaction in its own savepoint. True = treat as unchanged. */
  tryRepoint?(native: N, doc: D, ctx: LoadContext): Promise<boolean>;
  /** Writes one doc, inside the batch transaction in its own savepoint. A throw quarantines the doc. */
  load(native: N, doc: D, ctx: LoadContext): Promise<void>;
  /**
   * Optional plan-capable writer: what `load` would do, computed inside a
   * READ ONLY transaction that is always rolled back. Absent: a plan stops
   * before load.
   */
  planLoad?(native: N, doc: D, ctx: LoadContext): Promise<unknown>;
}

export interface PullDeps {
  /** Passed to startRun, the breaker, quarantine and resolve unchanged. */
  runs: RunsDeps;
  /** Passed to the cursor calls unchanged. */
  queueHooks?: QueueHooks;
  onEvent?: (e: RunnerEvent) => void;
}

export interface PlanDeps {
  /** Passed to the cursor read unchanged. */
  queueHooks?: QueueHooks;
  onEvent?: (e: RunnerEvent) => void;
}

export interface PullArgs<R extends PullRef, D extends PullDoc, N> {
  tx: Transactor<N>;
  runs: RunsSlice;
  quarantine: QuarantineTable;
  cursors: CursorTable;
  source: PullSource<R, D, N>;
  /** A mode the job declares. */
  mode: string;
  /** A backfill window: passed to list, and the cursor is neither read nor written. */
  since?: Date;
  /** Held by the caller, keepalive started by the caller; the runner gates it and never releases it. */
  lock: RunLock;
  /** 1–10 000. */
  batchSize: number;
  /** 1–64: fetches in flight at once within a batch. */
  fetchConcurrency: number;
  /** Optional quota breaker: one breaker per run, made by `make(deps.runs)`. */
  quota?: {
    make: (deps: Pick<RunsDeps, "onEvent">) => Breaker;
    isQuota: (err: unknown) => boolean;
  };
  /** The row's reason for a failure; default rootstock's text. A throw or a non-string falls back to it. */
  reasonOf?: (f: PullFailure) => string;
  /** An error's text in quarantine reasons and default reasons; default its message. */
  describe?: (err: unknown) => string;
  /** The quarantine reason for a fetched doc carrying another id; default rootstock's text. */
  mismatchReason?: (asked: string, got: unknown) => string;
  afterRun?: (row: RunRow) => void | Promise<void>;
}

export type PullFailure =
  | { kind: "options"; field: "batchSize" | "fetchConcurrency"; value: unknown }
  | { kind: "list"; error: unknown }
  | { kind: "lost-lock"; error: unknown }
  | { kind: "batch"; error: unknown }
  | { kind: "quota"; count: number; externalId: string }
  | { kind: "cursor"; error: unknown }
  | { kind: "threw"; error: unknown }
  /** Settled with no failure of the runner's own but the buckets do not balance; `runs` writes the reason. */
  | { kind: "identity" };

/** The run's buckets and counters, as they stood when it settled. */
export interface PullCounts {
  /** refs + excluded: everything the source observed. */
  listed: number;
  fetched: number;
  written: number;
  unchanged: number;
  quarantined: number;
  excluded: number;
  /** Folded: one entry per reason, in first-seen order. */
  excludedReasons: readonly Exclusion[];
  /** Subset of `unchanged`: a rename hook claimed the doc. */
  repointed: number;
}

export interface PullReport extends PullCounts {
  job: string;
  mode: string;
  runId: string;
  status: "ok" | "failed";
  /** Absent when ok. */
  failure?: PullFailure;
  /** The settle's result from `runs`. */
  finish: FinishResult;
}

export interface PlanArgs<R extends PullRef, D extends PullDoc, N> {
  tx: Transactor<N>;
  cursors: CursorTable;
  source: PullSource<R, D, N>;
  since?: Date;
  /** Optional: when given, gated before the listing, before each batch and before each fetch. */
  lock?: RunLock;
  /** 1–10 000: refs planned per batch (docs are dropped after their batch). */
  batchSize: number;
  /** 1–64. */
  fetchConcurrency: number;
  /** 1–1 000 000: plan only the listing's first `maxRefs` refs (`truncated` says so). */
  maxRefs?: number;
  /** As PullArgs. */
  describe?: (err: unknown) => string;
  mismatchReason?: (asked: string, got: unknown) => string;
}

export type PlanAction =
  | "unchanged"
  | "duplicate"
  | "new"
  | "changed"
  | "fetch-failed"
  | "id-mismatch";

export interface PlanItem {
  externalId: string;
  action: PlanAction;
  /** fetch-failed: the fetch error's message; id-mismatch: the mismatch text. */
  reason?: string;
  /** planLoad's answer, for new and changed, when the source declares it. */
  detail?: unknown;
}

export interface PullPlan {
  job: string;
  /** `stored`: undefined when none is stored or on a backfill. `wouldStore`: undefined when nothing would be written. */
  cursor: { stored: unknown; wouldStore: unknown };
  listed: number;
  excluded: number;
  excludedReasons: readonly Exclusion[];
  /** True when `maxRefs` cut the listing; `listed` still counts the whole listing. */
  truncated: boolean;
  /** One per planned ref, in list order. */
  items: readonly PlanItem[];
  counts: Readonly<Record<PlanAction, number>>;
}

export interface DrainOutcome {
  /** Live parts this row archived: what the cap counts. */
  archived?: number;
  /** The row was outside the corpus: acked, counted, never retried. */
  excluded?: boolean;
}

/** What the drain needs of a lock: a RunLock satisfies it. */
export interface DrainLock {
  ensureExclusive(): Promise<void>;
  startKeepalive(): void;
  stopKeepalive(): void;
  release(): Promise<void>;
}

export interface DrainContext<T> {
  readonly source: string;
  /** The consumer's record for this source's drain (what `record.start` returned), or null. */
  readonly record: T | null;
  /** The lock's gate. */
  ensureExclusive(): Promise<void>;
  /** Extends this row's claim (queue Q8); the drain never calls it on its own. */
  extend(): Promise<ExtendResult>;
}

export interface DrainSource<T> {
  /** The queue source. */
  source: string;
  /** For the consumer's `acquire` and the skipped-locked event. */
  lockName: string;
  /** Absent: the source is in scope but has no handler; it is never claimed. */
  handle?: (row: QueueRow, ctx: DrainContext<T>) => Promise<DrainOutcome>;
}

export type HeldWhy = "capped" | "interrupted" | "aborted";

export type DrainFailure =
  | { kind: "fatal"; error: unknown }
  | { kind: "capped"; archived: number; cap: number; jammed: boolean; leftClaimed: number }
  | { kind: "interrupted"; jammed: boolean; leftClaimed: number }
  | { kind: "jammed"; leftClaimed: number }
  | { kind: "all-failed"; handled: number }
  | { kind: "dead"; dead: number }
  | { kind: "queue"; error: unknown };

export interface SourceDrain {
  source: string;
  handled: number;
  acked: number;
  failed: number;
  archived: number;
  excluded: number;
  dead: number;
  skippedLocked: 0 | 1;
  contended: number;
  jammed: number;
}

export interface DrainRecord<T, L extends DrainLock = RunLock> {
  /** After a claim returned rows; null = no record (the drain goes on). */
  start(lock: L, source: string): Promise<T | null>;
  /** Once per started source, on every path. */
  settle(record: T | null, s: { drain: SourceDrain; failure?: DrainFailure }): Promise<void>;
}

export interface DrainInput<T, L extends DrainLock = RunLock> {
  tx: Transactor;
  queue: QueueSlice;
  /** In drain order. */
  sources: readonly DrainSource<T>[];
  worker: string;
  /** A positive integer; `claim` clamps it to the slice's maxClaimLimit. */
  limit: number;
  /** 1–1 000 000: parts this drain may archive before it stops. */
  maxArchivals: number;
  /** 1–1 000 000: rows handled before "every one failed" reads as an outage. */
  minRowsForAllFailed: number;
  /** 1–1 000 000: contended acks or fails in a row before the drain stops touching the queue. */
  contendedBrake: number;
  /** Takes the source's lock without waiting; a refusal `isHeld` recognises skips the source. */
  acquire(source: DrainSource<T>): Promise<L>;
  isHeld(err: unknown): boolean;
  /** A handler error that dooms the rest of the drain (a lost lock). */
  isFatal(err: unknown): boolean;
  /** The error class `fail` stores for a handler's throw. */
  errorClassOf(err: unknown): string;
  /** The error class `fail` stores for a row claimed but never handled. */
  heldClass: Readonly<Record<HeldWhy, string>>;
  /** Parts a throwing handler archived before it threw; default 0. */
  archivedBefore?: (err: unknown) => number;
  /** Asked between rows and between sources. */
  interrupted(): boolean;
  record: DrainRecord<T, L>;
}

export interface DrainReport {
  worker: string;
  /** 0 clean, 1 page. */
  status: 0 | 1;
  drains: readonly SourceDrain[];
  archived: number;
}

export interface DrainDeps {
  /** Passed to claim, ack, fail and extendClaim unchanged. */
  queueHooks?: QueueHooks;
  onEvent?: (e: RunnerEvent) => void;
}

export type RunnerEvent =
  | { type: "runner.pull_started"; job: string; runId: string; mode: string; backfill: boolean }
  | {
      type: "runner.batch_committed";
      job: string;
      runId: string;
      batch: number;
      size: number;
      written: number;
      unchanged: number;
      quarantined: number;
    }
  | {
      type: "runner.batch_rolled_back";
      job: string;
      runId: string;
      batch: number;
      kind: "batch" | "lost-lock";
    }
  | { type: "runner.repoint_failed"; job: string; externalId: string; error: unknown }
  | { type: "runner.resolve_failed"; job: string; count: number; error: unknown }
  | {
      type: "runner.settle_refused";
      job: string;
      runId: string;
      call: "account" | "count" | "meter";
      error: unknown;
    }
  | {
      type: "runner.pull_finished";
      job: string;
      runId: string;
      status: "ok" | "failed";
      failure: PullFailure["kind"] | null;
    }
  | { type: "drain.no_handler"; source: string }
  | {
      type: "drain.sources_stopped";
      source: string;
      reason: "archival-cap" | "queue-jammed" | "interrupted";
    }
  | { type: "drain.skipped_locked"; source: string; lockName: string }
  | { type: "drain.empty"; source: string }
  | { type: "drain.interrupted"; source: string; handled: number; remaining: number }
  | {
      type: "drain.row_failed";
      source: string;
      key: string;
      kind: string;
      attempts: number | null;
      archivedBefore: number;
      error: unknown;
    }
  | { type: "drain.row_contended"; source: string; key: string; operation: "ack" | "fail" }
  | { type: "drain.archival_cap"; source: string; archived: number; cap: number; remaining: number }
  | { type: "drain.queue_jammed"; source: string; unprocessed: number; leftClaimed: number }
  | { type: "drain.all_failed"; source: string; handled: number }
  | { type: "drain.dead_lettered"; source: string; dead: number }
  | { type: "drain.aborted"; source: string; error: unknown }
  | { type: "drain.failed"; source: string; error: unknown }
  | { type: "drain.settle_failed"; source: string; error: unknown }
  | {
      type: "drain.done";
      worker: string;
      status: 0 | 1;
      archived: number;
      drains: readonly SourceDrain[];
    };
