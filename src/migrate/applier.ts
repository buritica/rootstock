import { pgCode, quoteIdentifier, type Transactor, type TxSql } from "../db/index.ts";
import { own, q, sliceRefusals } from "../internal/slice.ts";
import { fail, failAs, reason, refusalCode } from "./errors.ts";
import { type MigrationKind, NAME_RULE } from "./marker.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import { acceptanceOf, type SourceState, sourceState } from "./state.ts";
import type { TrackedSource } from "./tracked.ts";
import {
  bootstrapTracker,
  readTracker,
  recordApplied,
  stampHashes,
  trackerName,
  trackerRowsFor,
} from "./tracker-db.ts";

export type Entry = "deploy" | "manual";
export type Backup =
  | { readonly run: (plan: MigrationPlan) => Promise<void> }
  | { readonly skip: string };

export interface ApplyOptions {
  readonly entry: Entry;
  readonly backup: Backup;
  /** manual only; refused with entry "deploy". */
  readonly allowHeavy?: boolean;
  /** The repo's real manual-apply command, named in E-MIG-DEPLOY-HEAVY. */
  readonly fix: string;
  /** Compute the plan and its refusals, write nothing, take no lock. */
  readonly planOnly?: boolean;
  /** A hook that throws is ignored. */
  readonly onEvent?: (e: MigrateEvent) => void;
}

export interface MigrationPlan {
  readonly entry: Entry;
  readonly apply: readonly { source: string; id: string; kind: MigrationKind | null }[];
  readonly ahead: readonly { source: string; id: string }[];
  readonly accepted: readonly { source: string; id: string; reason: string }[];
}

export interface ApplyResult {
  readonly plan: MigrationPlan;
  readonly applied: readonly { source: string; id: string; ms: number }[];
  /** Another applier got there first. */
  readonly skippedConcurrent: readonly { source: string; id: string }[];
  readonly bootstrap: {
    readonly created: readonly string[];
    readonly upgraded: readonly string[];
    readonly stamped: number;
  };
}

export type MigrateEvent =
  | { type: "migrate.plan"; entry: Entry; apply: number; ahead: number; accepted: number }
  | { type: "migrate.tracker_created" | "migrate.tracker_upgraded"; source: string; table: string }
  | { type: "migrate.hash_stamped"; source: string; id: string }
  | { type: "migrate.accepted"; source: string; id: string; reason: string }
  | { type: "migrate.ahead"; source: string; id: string }
  | { type: "migrate.backup_skipped"; reason: string }
  | { type: "migrate.applying"; source: string; id: string; kind: MigrationKind | null }
  | { type: "migrate.applied"; source: string; id: string; ms: number }
  | { type: "migrate.skipped_concurrent"; source: string; id: string }
  | { type: "migrate.refused"; code: string }
  | { type: "migrate.done"; applied: number; skippedConcurrent: number; ahead: number };

/** The bootstrap transaction's own wait for a tracker lock (an old migrator mid-file). */
const BOOTSTRAP_LOCK_TIMEOUT = "30s";
const OPTION_KEYS: ReadonlySet<string> = new Set([
  "entry",
  "backup",
  "allowHeavy",
  "fix",
  "planOnly",
  "onEvent",
]);
const refuseCall = sliceRefusals("applyMigrations");

const BACKUP_KEYS: ReadonlySet<string> = new Set(["run", "skip"]);

/**
 * The refusals whose words differ by entry point. The rootstock-only entry
 * (0.3.0's `applyRootstockMigrations`) keeps Stage A's texts byte-identical.
 */
interface Texts {
  tamper(
    source: string,
    id: string,
    recorded: string,
    current: string,
    acceptedCurrent?: string,
  ): never;
  ahead(source: string, ids: readonly string[]): never;
  heavy(blocked: readonly SourceMigration[]): never;
}

const SOURCE_TEXTS: Texts = {
  tamper: (source, id, recorded, current, acceptedCurrent) =>
    fail(
      `source ${q(source)} recorded ${id} with hash ${recorded}, but the file now hashes to ${current}${acceptedCurrent === undefined ? "" : ` (its acceptance expects ${acceptedCurrent})`} — an applied migration changed after it ran; if that is known and harmless, add it to the migrate slice's accepted list with a reason; re-running will not fix this`,
      "ERR_ROOTSTOCK_MIG_TAMPER_SRC",
    ),
  ahead: (source, ids) =>
    fail(
      `source ${q(source)} has applied ${ids.join(", ")}, which this checkout does not have — the database is ahead of this code; pull, or run from the deployed commit; after a rollback, fix forward with a deploy that carries them`,
      "ERR_ROOTSTOCK_MIG_AHEAD_SRC",
    ),
  heavy: (blocked) =>
    fail(
      `pending migration(s) marked heavy or unmarked: ${blocked.map((m) => label(m.source, m.id)).join(", ")} — re-run with --allow-heavy to apply them deliberately`,
      "ERR_ROOTSTOCK_MIG_HEAVY_SRC",
    ),
};

function stageATexts(schema: string): Texts {
  return {
    tamper: (_source, id, recorded, current) =>
      failAs(
        `applyRootstockMigrations: ${schema}.schema_migrations records ${id} with sha256 ${recorded}, but this package ships ${current} — an applied migration changed after it ran; refusing, and re-running will not fix this`,
        "ERR_ROOTSTOCK_MIG_TAMPER",
      ),
    ahead: (_source, ids) =>
      failAs(
        `applyRootstockMigrations: schema "${schema}" has applied ${ids.join(", ")}, which this package does not ship — the database is ahead of this rootstock version; upgrade rootstock`,
        "ERR_ROOTSTOCK_MIG_AHEAD",
      ),
    heavy: (blocked) =>
      failAs(
        `applyRootstockMigrations: pending migration(s) marked heavy: ${blocked.map((m) => m.id).join(", ")} — apply them deliberately with { allowHeavy: true }, then re-run`,
        "ERR_ROOTSTOCK_MIG_HEAVY",
      ),
  };
}

function trackerRows(source: string, what: string): never {
  fail(
    `source ${q(source)}'s tracker has ${what} — fix those rows by hand (see the census procedure); re-running will not fix this`,
    "ERR_ROOTSTOCK_MIG_TRACKER_ROWS",
  );
}

const label = (source: string, id: string): string => `${source}/${id}`;

async function lock(tx: TxSql, slice: MigrateSlice): Promise<void> {
  // Selected FROM the call so no driver has to decode a void column.
  await tx`select 1::int as locked from pg_advisory_xact_lock(hashtext(${`rootstock-migrate:${slice.schema}`}::text)::bigint)`;
}

function validateOptions(slice: MigrateSlice, opts: unknown): ApplyOptions {
  assertMigrateSlice("applyMigrations", slice);
  const o = refuseCall.record("options", opts);
  refuseCall.refuseUnknownKeys(o, OPTION_KEYS, "options.");
  const entry = own(o, "entry");
  if (entry === undefined) throw refuseCall.required("options.entry");
  if (entry !== "deploy" && entry !== "manual") {
    throw refuseCall.invalid("options.entry", '"deploy" or "manual"', entry);
  }
  const backup = refuseCall.record("options.backup", own(o, "backup"));
  refuseCall.refuseUnknownKeys(backup, BACKUP_KEYS, "options.backup.");
  const run = own(backup, "run");
  const skip = own(backup, "skip");
  if ((run === undefined) === (skip === undefined)) {
    throw refuseCall.invalid(
      "options.backup",
      "exactly one of run or skip",
      run === undefined ? "neither" : "both",
    );
  }
  if (run !== undefined && typeof run !== "function") {
    throw refuseCall.invalid("options.backup.run", "a function", run);
  }
  if (skip !== undefined && (typeof skip !== "string" || skip.trim() === "")) {
    throw refuseCall.invalid("options.backup.skip", "a non-empty reason", skip);
  }
  const fix = own(o, "fix");
  if (typeof fix !== "string" || fix.trim() === "") {
    throw refuseCall.invalid("options.fix", "a non-empty command", fix);
  }
  for (const key of ["allowHeavy", "planOnly"]) {
    const v = own(o, key);
    if (v !== undefined && typeof v !== "boolean") {
      throw refuseCall.invalid(`options.${key}`, "a boolean", v);
    }
  }
  const onEvent = own(o, "onEvent");
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw refuseCall.invalid("options.onEvent", "a function", onEvent);
  }
  return Object.freeze({
    entry,
    backup: Object.freeze(
      run === undefined
        ? { skip: skip as string }
        : { run: run as (plan: MigrationPlan) => Promise<void> },
    ),
    fix,
    ...(own(o, "allowHeavy") === true ? { allowHeavy: true } : {}),
    ...(own(o, "planOnly") === true ? { planOnly: true } : {}),
    ...(onEvent === undefined ? {} : { onEvent: onEvent as ApplyOptions["onEvent"] }),
  }) as ApplyOptions;
}

/**
 * Every refusal here carries a code, so the caller's `migrate.refused` sees it:
 * a shape refusal (not an array, a bad name, a bad tracker) keeps its parser
 * text and gains ERR_ROOTSTOCK_MIG_SRC.
 */
function validateSources(slice: MigrateSlice, sources: unknown, opts: ApplyOptions): void {
  try {
    checkSources(slice, sources, opts);
  } catch (err) {
    if (err instanceof Error && refusalCode(err) === undefined)
      Object.assign(err, { code: "ERR_ROOTSTOCK_MIG_SRC" });
    throw err;
  }
}

function checkSources(slice: MigrateSlice, sources: unknown, opts: ApplyOptions): void {
  if (opts.allowHeavy === true && opts.entry === "deploy") {
    fail(
      'options.allowHeavy is for entry "manual" only — a deploy never applies a heavy migration',
      "ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY",
    );
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw refuseCall.invalid("sources", "a non-empty array", sources);
  }
  const first = sources[0] as Partial<TrackedSource> | undefined;
  if (first?.name !== "rootstock" || first.tracker?.kind !== "rootstock") {
    fail(
      `the first source must be rootstockSource(slice) — got ${q(first?.name)}`,
      "ERR_ROOTSTOCK_MIG_SRC_ORDER",
    );
  }
  const names = new Set<string>();
  const tables = new Set<string>();
  for (const [i, raw] of sources.entries()) {
    const src = refuseCall.record(`sources[${i}]`, raw) as unknown as TrackedSource;
    if (typeof src.name !== "string" || !NAME_RULE.test(src.name)) {
      throw refuseCall.invalid(`sources[${i}].name`, "a name matching [a-z][a-z0-9-]*", src.name);
    }
    if (names.has(src.name))
      fail(
        `source name ${q(src.name)} is used by more than one source`,
        "ERR_ROOTSTOCK_MIG_SRC_DUP",
      );
    names.add(src.name);
    if (i > 0 && src.tracker?.kind === "rootstock") {
      fail(
        `tracker ${q("rootstock")} is used by more than one source`,
        "ERR_ROOTSTOCK_MIG_SRC_DUP",
      );
    }
    const table = trackerName(src.tracker, slice);
    if (tables.has(table))
      fail(
        `tracker table ${q(table)} is used by more than one source`,
        "ERR_ROOTSTOCK_MIG_SRC_DUP",
      );
    tables.add(table);
    if (!Array.isArray(src.migrations)) {
      throw refuseCall.invalid(`sources[${i}].migrations`, "an array", src.migrations);
    }
    const stray = (src.migrations as readonly Partial<SourceMigration>[]).find(
      (m) => m?.source !== src.name,
    );
    if (stray !== undefined) {
      fail(
        `sources[${i}].migrations must all be source ${q(src.name)}'s — got ${q(stray?.id)} of source ${q(stray?.source)}`,
      );
    }
  }
}

/**
 * Refuses unless the transaction's role can use and create in the slice's
 * schema, or can create the schema when it is missing (Stage A's texts).
 */
async function preflight(tx: TxSql, schema: string): Promise<{ exists: boolean }> {
  const [who] = await tx<{ user: string; exists: boolean; dbCreate: boolean }>`
    select current_user::text as "user",
           to_regnamespace(${schema}::text) is not null as "exists",
           has_database_privilege(current_database(), 'CREATE') as "dbCreate"`;
  if (who === undefined)
    throw new Error("applyRootstockMigrations: the preflight query returned no row");
  const { user } = who;
  if (!who.exists) {
    if (who.dbCreate) return { exists: false };
    failAs(
      `applyRootstockMigrations: schema "${schema}" does not exist and role ${JSON.stringify(user)} cannot create it (no CREATE on this database) — have a superuser or a member of that role run CREATE SCHEMA "${schema}" AUTHORIZATION "${user}", then re-run`,
      "ERR_ROOTSTOCK_MIG_NOCREATE",
    );
  }
  const [can] = await tx<{ usage: boolean; create: boolean }>`
    select has_schema_privilege(${schema}::text, 'USAGE') as "usage",
           has_schema_privilege(${schema}::text, 'CREATE') as "create"`;
  if (can === undefined)
    throw new Error("applyRootstockMigrations: the privilege query returned no row");
  const missing = [...(can.usage ? [] : ["USAGE"]), ...(can.create ? [] : ["CREATE"])];
  if (missing.length > 0) {
    failAs(
      `applyRootstockMigrations: role ${JSON.stringify(user)} lacks ${missing.join(" and ")} on schema "${schema}" — run GRANT ${missing.join(", ")} ON SCHEMA "${schema}" TO "${user}" as its owner, then re-run`,
      "ERR_ROOTSTOCK_MIG_NOUSAGE",
    );
  }
  return { exists: true };
}

interface Run {
  readonly slice: MigrateSlice;
  readonly sources: readonly TrackedSource[];
  readonly opts: ApplyOptions;
  readonly texts: Texts;
  readonly emit: (e: MigrateEvent) => void;
}

async function readStates(transactor: Transactor, run: Run): Promise<SourceState[]> {
  const states: SourceState[] = [];
  for (const source of run.sources) {
    const read = await readTracker(transactor.sql, source.tracker, run.slice);
    states.push(sourceState(source, read, run.slice.accepted));
  }
  return states;
}

/** Contract §1.4 step 2's refusals, first match wins. */
function refuseIfBlocked(run: Run, states: readonly SourceState[]): void {
  const { opts, texts, slice } = run;
  for (const s of states) {
    if (s.unknown.length > 0 || s.duplicate.length > 0) {
      trackerRows(
        s.source,
        [
          ...(s.unknown.length > 0
            ? [`unknown rows with id ${s.unknown.map((u) => u.rowId).join(", ")}`]
            : []),
          ...(s.duplicate.length > 0 ? [`duplicate keys ${s.duplicate.join(", ")}`] : []),
        ].join(" and "),
      );
    }
  }
  for (const s of states) {
    const [t] = s.tampered;
    if (t !== undefined) texts.tamper(s.source, t.id, t.recorded, t.current, t.acceptedCurrent);
  }
  // rootstock's own source only (B2; validateSources() pins it first): an app
  // source with rows ahead and files pending is the rollback-then-hotfix
  // deploy, which applies and reports the ahead ids.
  const [mine] = states;
  if (mine !== undefined && mine.ahead.length > 0 && mine.pending.length > 0) {
    failAs(
      `applyRootstockMigrations: schema "${slice.schema}" has applied ${mine.ahead.join(", ")}, which this package does not ship, and is missing ${mine.pending.map((m) => m.id).join(", ")} — the database and this package have diverged; refusing`,
      "ERR_ROOTSTOCK_MIG_DIVERGED",
    );
  }
  if (opts.entry === "manual") {
    for (const s of states) if (s.ahead.length > 0) texts.ahead(s.source, s.ahead);
  }
  const pending = states.flatMap((s) => s.pending);
  if (opts.entry === "deploy") {
    const blocked = pending.filter((m) => m.kind !== "additive");
    if (blocked.length > 0) {
      const list = blocked
        .map(
          (m) =>
            `${label(m.source, m.id)} (${m.kind === "heavy" ? "heavy" : m.baselined ? "unmarked (baselined)" : "unmarked"})`,
        )
        .join(", ");
      fail(
        `deploy refuses pending migration(s) that are heavy or unmarked: ${list} — apply them by hand (${opts.fix}), then redeploy`,
        "ERR_ROOTSTOCK_MIG_DEPLOY_HEAVY",
      );
    }
    return;
  }
  if (opts.allowHeavy === true) return;
  const blocked = pending.filter((m) => m.kind === "heavy" || (m.kind === null && !m.baselined));
  if (blocked.length > 0) texts.heavy(blocked);
}

function planOf(run: Run, states: readonly SourceState[]): MigrationPlan {
  return Object.freeze({
    entry: run.opts.entry,
    apply: Object.freeze(
      states.flatMap((s) =>
        s.pending.map((m) => Object.freeze({ source: m.source, id: m.id, kind: m.kind })),
      ),
    ),
    ahead: Object.freeze(
      states.flatMap((s) => s.ahead.map((id) => Object.freeze({ source: s.source, id }))),
    ),
    accepted: Object.freeze(
      states.flatMap((s) =>
        s.accepted
          .filter((a) => !a.stale)
          .map((a) => Object.freeze({ source: s.source, id: a.id, reason: a.reason })),
      ),
    ),
  });
}

/** Step 1: one transaction, under the lock. */
async function bootstrap(
  transactor: Transactor,
  run: Run,
): Promise<{ schemaCreated: boolean; result: ApplyResult["bootstrap"]; events: MigrateEvent[] }> {
  const { slice, sources } = run;
  return transactor.begin(async (tx) => {
    await lock(tx, slice);
    const [iso] = await tx<{
      level: string;
    }>`select current_setting('transaction_isolation') as level`;
    if (iso?.level !== "read committed") {
      fail(
        `transaction isolation is ${iso?.level}; the migration lock only serializes under read committed — set default_transaction_isolation for this role, or connect with read committed`,
        "ERR_ROOTSTOCK_MIG_ISOLATION",
      );
    }
    const { exists } = await preflight(tx, slice.schema);
    if (!exists) await tx.unsafe(`CREATE SCHEMA ${quoteIdentifier(slice.schema)}`);
    await tx.unsafe(`SET LOCAL lock_timeout = '${BOOTSTRAP_LOCK_TIMEOUT}'`);
    const created: string[] = [];
    const upgraded: string[] = [];
    const events: MigrateEvent[] = [];
    for (const source of sources) {
      let done: Awaited<ReturnType<typeof bootstrapTracker>>;
      try {
        done = await bootstrapTracker(tx, source, slice);
      } catch (err) {
        if (refusalCode(err) !== undefined) throw err;
        // Uncoded on purpose: a driver error, whose SQLSTATE pgCode() finds on the cause.
        const waited = pgCode(err) === "55P03" ? "; another migrator is holding it" : "";
        throw new Error(
          `rootstock migrate: preparing source ${q(source.name)}'s tracker ${trackerName(source.tracker, slice)} failed, so nothing was changed${waited} — ${reason(err)}`,
          { cause: err },
        );
      }
      if (done.created) {
        created.push(done.table);
        events.push({ type: "migrate.tracker_created", source: source.name, table: done.table });
      }
      if (done.upgraded) {
        upgraded.push(done.table);
        events.push({ type: "migrate.tracker_upgraded", source: source.name, table: done.table });
      }
    }
    return {
      schemaCreated: !exists,
      result: Object.freeze({
        created: Object.freeze(created),
        upgraded: Object.freeze(upgraded),
        stamped: 0,
      }),
      events,
    };
  });
}

/**
 * D42's one-time stamp, under the lock, once the run is known not to be
 * refused: a refused run (a manual run from a stale checkout, say) must not
 * write its files' hashes into rows it then leaves alone. Events go out after
 * commit.
 */
async function stamp(transactor: Transactor, run: Run): Promise<number> {
  const { slice, sources, emit } = run;
  const done = await transactor.begin(async (tx) => {
    await lock(tx, slice);
    await tx.unsafe(`SET LOCAL lock_timeout = '${BOOTSTRAP_LOCK_TIMEOUT}'`);
    const out: { source: string; id: string }[] = [];
    for (const source of sources) {
      let ids: readonly string[];
      try {
        ids = await stampHashes(tx, source, slice);
      } catch (err) {
        const waited = pgCode(err) === "55P03" ? "; another migrator is holding it" : "";
        throw new Error(
          `rootstock migrate: stamping source ${q(source.name)}'s hashes in ${trackerName(source.tracker, slice)} failed, so nothing was changed${waited} — ${reason(err)}`,
          { cause: err },
        );
      }
      for (const id of ids) out.push({ source: source.name, id });
    }
    return out;
  });
  for (const d of done) emit({ type: "migrate.hash_stamped", ...d });
  return done.length;
}

/** Step 5 for one file: its own transaction, under the lock, re-reading its row first. */
async function applyOne(
  transactor: Transactor,
  run: Run,
  source: TrackedSource,
  m: SourceMigration,
): Promise<"applied" | "skipped"> {
  const { slice } = run;
  return transactor.begin(async (tx) => {
    await lock(tx, slice);
    const rows = await trackerRowsFor(tx, source.tracker, slice, m.key);
    if (rows.length > 1) trackerRows(source.name, `duplicate keys ${m.key}`);
    const [row] = rows;
    if (row !== undefined) {
      // A NULL hash is a row an older migrator wrote after the bootstrap's
      // stamp: applied, and stamped by the next bootstrap.
      if (row.hash === null || row.hash === m.sha256) return "skipped";
      const { entry, covers } = acceptanceOf(slice.accepted, source.name, m.id, row.hash, m.sha256);
      if (covers) return "skipped";
      run.texts.tamper(source.name, m.id, row.hash, m.sha256, entry?.current);
    }
    if (source.tracker.kind === "rootstock") {
      await tx.unsafe(`SET LOCAL search_path TO ${quoteIdentifier(slice.schema)}`);
    }
    // No parameters: the simple protocol, so a multi-statement chunk runs and
    // a `$1` inside a body is text, as the origin migrators run it.
    try {
      for (const statement of m.statements) await tx.unsafe(statement);
    } catch (err) {
      // Uncoded: the file's own failure, rolled back alone; pgCode() finds its SQLSTATE.
      throw new Error(
        `rootstock migrate: ${label(source.name, m.id)} failed and was rolled back; files before it stay applied — ${reason(err)}`,
        { cause: err },
      );
    }
    await recordApplied(tx, source.tracker, slice, m);
    return "applied";
  });
}

export interface ApplyOutcome extends ApplyResult {
  readonly schemaCreated: boolean;
}

/** The applier behind `applyMigrations` and the rootstock-only wrapper. */
export async function runMigrations(
  transactor: Transactor,
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
  rawOpts: ApplyOptions,
  /** The rootstock-only entry point: Stage A's texts, byte-identical. */
  stageA = false,
): Promise<ApplyOutcome> {
  const opts = validateOptions(slice, rawOpts);
  const hook = opts.onEvent;
  const emit = (e: MigrateEvent): void => {
    // A hook never changes what a run does, and an async one that rejects
    // must not become an unhandled rejection mid-deploy.
    try {
      const out: unknown = hook?.(e);
      if (typeof (out as PromiseLike<unknown> | undefined)?.then === "function") {
        (out as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // ignored, as above
    }
  };
  const texts = stageA ? stageATexts(slice.schema) : SOURCE_TEXTS;
  const run: Run = { slice, sources, opts, texts, emit };
  try {
    validateSources(slice, sources, opts);
    return await steps(transactor, run);
  } catch (err) {
    const code = refusalCode(err);
    if (code !== undefined) emit({ type: "migrate.refused", code });
    throw err;
  }
}

async function steps(transactor: Transactor, run: Run): Promise<ApplyOutcome> {
  const { opts, emit } = run;
  let schemaCreated = false;
  let boot: ApplyResult["bootstrap"] = Object.freeze({
    created: Object.freeze([]),
    upgraded: Object.freeze([]),
    stamped: 0,
  });
  if (opts.planOnly !== true) {
    const done = await bootstrap(transactor, run);
    schemaCreated = done.schemaCreated;
    boot = done.result;
    for (const e of done.events) emit(e);
  }

  const states = await readStates(transactor, run);
  refuseIfBlocked(run, states);
  const plan = planOf(run, states);
  emit({
    type: "migrate.plan",
    entry: plan.entry,
    apply: plan.apply.length,
    ahead: plan.ahead.length,
    accepted: plan.accepted.length,
  });
  for (const a of plan.accepted) emit({ type: "migrate.accepted", ...a });
  for (const a of plan.ahead) emit({ type: "migrate.ahead", ...a });
  const result = (
    applied: ApplyResult["applied"],
    skippedConcurrent: ApplyResult["skippedConcurrent"],
  ): ApplyOutcome =>
    Object.freeze({ plan, applied, skippedConcurrent, bootstrap: boot, schemaCreated });
  if (opts.planOnly === true) return result(Object.freeze([]), Object.freeze([]));

  const stamped = await stamp(transactor, run);
  if (stamped > 0) boot = Object.freeze({ ...boot, stamped });

  if (plan.apply.length > 0) {
    if ("run" in opts.backup) {
      try {
        await opts.backup.run(plan);
      } catch (err) {
        fail(
          `the backup step failed, so nothing was applied — fix the backup or pass backup: { skip: "<reason>" } deliberately`,
          "ERR_ROOTSTOCK_MIG_BACKUP",
          err,
        );
      }
    } else {
      emit({ type: "migrate.backup_skipped", reason: opts.backup.skip });
    }
  }

  const applied: { source: string; id: string; ms: number }[] = [];
  const skipped: { source: string; id: string }[] = [];
  for (const [i, source] of run.sources.entries()) {
    const state = states[i];
    if (state === undefined)
      throw new Error(`rootstock migrate: no state read for ${q(source.name)}`);
    for (const m of state.pending) {
      emit({ type: "migrate.applying", source: m.source, id: m.id, kind: m.kind });
      const started = performance.now();
      const outcome = await applyOne(transactor, run, source, m);
      if (outcome === "skipped") {
        skipped.push(Object.freeze({ source: m.source, id: m.id }));
        emit({ type: "migrate.skipped_concurrent", source: m.source, id: m.id });
      } else {
        const ms = Math.round(performance.now() - started);
        applied.push(Object.freeze({ source: m.source, id: m.id, ms }));
        emit({ type: "migrate.applied", source: m.source, id: m.id, ms });
      }
    }
  }

  // Step 6: what was planned must now read as applied, and nothing tampered.
  if (plan.apply.length > 0) await verify(transactor, run, plan);
  emit({
    type: "migrate.done",
    applied: applied.length,
    skippedConcurrent: skipped.length,
    ahead: plan.ahead.length,
  });
  return result(Object.freeze(applied), Object.freeze(skipped));
}

async function verify(transactor: Transactor, run: Run, plan: MigrationPlan): Promise<void> {
  const after = await readStates(transactor, run);
  const planned = new Set(plan.apply.map((a) => label(a.source, a.id)));
  const stillPending = after
    .flatMap((s) => s.pending.map((m) => label(m.source, m.id)))
    .filter((x) => planned.has(x));
  // Every file, not only the planned ones: a planned file can rewrite an
  // earlier run's row, and that must fail this run, not the next one.
  const tampered = after.flatMap((s) => s.tampered.map((t) => label(s.source, t.id)));
  if (stillPending.length > 0 || tampered.length > 0) {
    const parts = [
      ...(stillPending.length > 0 ? [`${stillPending.join(", ")} still read as pending`] : []),
      ...(tampered.length > 0 ? [`${tampered.join(", ")} still read as tampered`] : []),
    ];
    fail(
      `after applying, ${parts.join(" and ")} — the tracker and the database disagree; do not re-run until this is understood`,
      "ERR_ROOTSTOCK_MIG_VERIFY",
    );
  }
}

/**
 * Applies every pending migration of every source (contract §1.4): validate,
 * bootstrap the trackers, plan and refuse, back up, then one transaction per
 * file under the database's migration lock, and verify.
 */
export async function applyMigrations(
  transactor: Transactor,
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const { schemaCreated: _created, ...result } = await runMigrations(
    transactor,
    slice,
    sources,
    opts,
  );
  return Object.freeze(result);
}
