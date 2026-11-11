import {
  type Brand,
  bounded,
  identifier,
  isRecord,
  own,
  sliceBrand,
  sliceRefusals,
  tableRef,
} from "../internal/slice.ts";
import { refusals } from "./errors.ts";
import { parseQuarantine, type QuarantineTable, type QuarantineTableInput } from "./quarantine.ts";

export interface JobDeclInput {
  /** An exact lock name or a "prefix*" family the lock slice admits. */
  lock: string;
  /** Each in the slice's modes; 1–8. */
  modes: readonly string[];
  reconciles: boolean;
  metered: boolean;
  /** null = manual, no staleness. */
  maxAgeHours: number | null;
  /** Required non-null iff maxAgeHours is non-null; ≤ maxAgeHours. */
  interruptedGraceHours: number | null;
  /**
   * A running row whose fencing row has not beaten for longer than this reads
   * interrupted in `verdictFor` (§20 A9); 10–86 400. The config invariant
   * `runs-stale-heartbeat` holds it at ≥ 6 × the lock slice's
   * probeStallSeconds + endTimeoutSeconds + 1 + 2 × heartbeatSeconds (A35);
   * the slice alone cannot see the lock.
   */
  staleHeartbeatSeconds: number;
  /** `heartbeat` is the consumer's paging rule (rootstock does not read it); printed. */
  push?: { maxAgeHours: number; heartbeat: boolean };
  /** rootstock reads `archived` only (the spike); the others are declared for the consumer's own rendering and printed. */
  counters?: { archived?: string; written?: string; coverage?: string; held?: string };
  /** Required iff counters.archived. */
  spike?: { share: number; allowance: number };
}

export interface RunsSliceInput {
  /** Default { <schema>, "runs" }. */
  table?: { schema?: string; name?: string };
  /** Default { <schema>, "run_locks" }: the lock slice's table. */
  lockTable?: { schema?: string; name?: string };
  /** Absent: no quarantine table on the slice (null). Given: both bounds required. */
  quarantine?: QuarantineTableInput;
  /** 1–16 names. */
  modes: readonly string[];
  /** 1–200; an exact job name or a "prefix*" family; no overlaps. */
  jobs: Readonly<Record<string, JobDeclInput>>;
  /** May be {}; required key. */
  prices: Readonly<Record<string, { inputPerMTok: number; outputPerMTok: number }>>;
  brakes?: Readonly<
    Record<string, { share: number; allowance: number; armAt: number; rounding: "ceil" | "none" }>
  >;
  budgets?: Readonly<Record<string, { limit: number; windowMinutes: number }>>;
  breakers?: Readonly<Record<string, { limit: number }>>;
  retention: { keepDays: number };
  maxCountKeys: number;
  maxReasonChars: number;
  maxScopeBytes: number;
}

/** One job's declaration, as `jobDecl` resolves it. */
export interface JobDecl {
  /** The slice key it was declared under: the job name, or the family ("delta:*"). */
  readonly key: string;
  readonly lock: string;
  readonly modes: readonly string[];
  readonly reconciles: boolean;
  readonly metered: boolean;
  readonly maxAgeHours: number | null;
  readonly interruptedGraceHours: number | null;
  readonly staleHeartbeatSeconds: number;
  readonly push: { readonly maxAgeHours: number; readonly heartbeat: boolean } | null;
  /** {} when omitted; each key present only when declared. */
  readonly counters: {
    readonly archived?: string;
    readonly written?: string;
    readonly coverage?: string;
    readonly held?: string;
  };
  readonly spike: { readonly share: number; readonly allowance: number } | null;
}

export interface BrakeDecl {
  readonly share: number;
  readonly allowance: number;
  readonly armAt: number;
  readonly rounding: "ceil" | "none";
}

declare const runsSliceBrand: unique symbol;
export interface RunsSlice {
  readonly [runsSliceBrand]: true;
  readonly table: { readonly schema: string; readonly name: string };
  readonly lockTable: { readonly schema: string; readonly name: string };
  /** null when the slice has no `quarantine` key (no bound is invented). */
  readonly quarantine: QuarantineTable | null;
  readonly modes: readonly string[];
  /** In declaration order. */
  readonly jobs: Readonly<Record<string, JobDecl>>;
  /** The numbers as given (the micro-dollar values are held beside the slice). */
  readonly prices: Readonly<
    Record<string, { readonly inputPerMTok: number; readonly outputPerMTok: number }>
  >;
  /** {} when omitted, as are budgets and breakers. */
  readonly brakes: Readonly<Record<string, BrakeDecl>>;
  readonly budgets: Readonly<
    Record<string, { readonly limit: number; readonly windowMinutes: number }>
  >;
  readonly breakers: Readonly<Record<string, { readonly limit: number }>>;
  readonly retention: { readonly keepDays: number };
  readonly maxCountKeys: number;
  readonly maxReasonChars: number;
  readonly maxScopeBytes: number;
}

/** A model's price in micro-dollars per million tokens. */
export interface PriceMicros {
  readonly input: bigint;
  readonly output: bigint;
}

const KEYS: ReadonlySet<string> = new Set([
  "table",
  "lockTable",
  "quarantine",
  "modes",
  "jobs",
  "prices",
  "brakes",
  "budgets",
  "breakers",
  "retention",
  "maxCountKeys",
  "maxReasonChars",
  "maxScopeBytes",
]);
const REQUIRED = [
  "modes",
  "jobs",
  "prices",
  "retention",
  "maxCountKeys",
  "maxReasonChars",
  "maxScopeBytes",
] as const;
const JOB_KEYS: ReadonlySet<string> = new Set([
  "lock",
  "modes",
  "reconciles",
  "metered",
  "maxAgeHours",
  "interruptedGraceHours",
  "staleHeartbeatSeconds",
  "push",
  "counters",
  "spike",
]);
const JOB_REQUIRED = [
  "lock",
  "modes",
  "reconciles",
  "metered",
  "maxAgeHours",
  "interruptedGraceHours",
  "staleHeartbeatSeconds",
] as const;
const PUSH_KEYS: ReadonlySet<string> = new Set(["maxAgeHours", "heartbeat"]);
const COUNTER_KEYS = ["archived", "written", "coverage", "held"] as const;
const SPIKE_KEYS: ReadonlySet<string> = new Set(["share", "allowance"]);
const PRICE_KEYS = ["inputPerMTok", "outputPerMTok"] as const;
const BRAKE_KEYS = ["share", "allowance", "armAt", "rounding"] as const;
const BUDGET_KEYS = ["limit", "windowMinutes"] as const;
const BREAKER_KEYS = ["limit"] as const;
const RETENTION_KEYS = ["keepDays"] as const;

/** A job, mode, brake, budget or breaker name. */
export const NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
/** A counter name (`count`, `counters.*`) and an override flag. */
export const COUNTER = /^[a-z0-9_.:-]{1,64}$/;
/** A model key (`prices`, `meter`). */
export const MODEL = /^[A-Za-z0-9_./:-]{1,128}$/;
// The lock slice's entry rule (exact, or one trailing *), ASCII, at most 200 bytes.
const LOCK_ENTRY = /^[a-z0-9][a-z0-9:._-]*\*?$/;
const MAX_LOCK_BYTES = 200;

const E_NAME = "a unique name matching [a-z0-9][a-z0-9_.:-]{0,63}";
const E_JOB_KEY = "a job name matching [a-z0-9][a-z0-9_.:-]{0,63}, optionally followed by one *";
const E_HOURS = "a finite number above 0 and at most 8760";
const E_SHARE = "a number above 0 and at most 0.5 with at most 4 decimal places";
const E_PRICE = "a finite number from 0 to 10000";
const E_PRICE_DECIMALS = "a number with at most 6 decimal places";
const E_BOOL = "true or false";

const PARSER = "runsSlice";
const refuse = sliceRefusals(PARSER);
const brand: Brand<RunsSlice> = sliceBrand("RunsSlice", PARSER);
const micros = new WeakMap<RunsSlice, ReadonlyMap<string, PriceMicros>>();

type Fields = Record<string, unknown>;

/** The record at `path`, its unknown keys refused, then its required keys. */
function fields(
  path: string,
  raw: unknown,
  known: ReadonlySet<string>,
  required: readonly string[],
): Fields {
  const out = refuse.record(path, raw);
  refuse.refuseUnknownKeys(out, known, `${path}.`);
  for (const key of required) {
    if (own(out, key) === undefined) throw refuse.required(`${path}.${key}`);
  }
  return out;
}

/** A map of named entries (`brakes`, `budgets`, …) each parsed by `entry`. */
function namedMap<T>(
  path: string,
  raw: unknown,
  keys: readonly string[],
  entry: (at: string, f: Fields) => T,
): Readonly<Record<string, T>> {
  if (raw === undefined) return Object.freeze({});
  const map = refuse.record(path, raw);
  const known = new Set(keys);
  return Object.freeze(
    Object.fromEntries(
      Object.keys(map).map((name) => {
        const at = `${path}.${name}`;
        if (!NAME.test(name)) throw refuse.invalid(at, E_NAME, name);
        return [name, Object.freeze(entry(at, fields(at, map[name], known, keys)))];
      }),
    ),
  );
}

/** True when `v` is a finite number from `min` to `max`, as stated by `above`. */
function finiteIn(v: unknown, min: number, max: number, above = false): v is number {
  return typeof v === "number" && Number.isFinite(v) && (above ? v > min : v >= min) && v <= max;
}

/** True when `v` carries at most `decimals` fractional digits (contract §3.6's tolerance). */
function decimalsAtMost(v: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  return Math.abs(v * scale - Math.round(v * scale)) <= 1e-6;
}

function share(path: string, v: unknown): number {
  if (!finiteIn(v, 0, 0.5, true) || !decimalsAtMost(v, 4)) throw refuse.invalid(path, E_SHARE, v);
  return v;
}

function hours(path: string, v: unknown): number {
  if (!finiteIn(v, 0, 8_760, true)) throw refuse.invalid(path, E_HOURS, v);
  return v;
}

function bool(path: string, v: unknown): boolean {
  if (typeof v !== "boolean") throw refuse.invalid(path, E_BOOL, v);
  return v;
}

/** 1–`max` unique names; each must be in `allowed` when given. */
function nameList(
  path: string,
  raw: unknown,
  max: number,
  allowed?: readonly string[],
): readonly string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) {
    throw refuse.invalid(path, `an array of 1 to ${max} names`, raw);
  }
  const out: string[] = [];
  raw.forEach((entry: unknown, i) => {
    const ok =
      typeof entry === "string" &&
      NAME.test(entry) &&
      !out.includes(entry) &&
      (allowed === undefined || allowed.includes(entry));
    if (!ok) {
      throw refuse.invalid(
        `${path}[${i}]`,
        allowed === undefined ? E_NAME : "a unique mode the slice's modes list",
        entry,
      );
    }
    out.push(entry);
  });
  return Object.freeze(out);
}

/** The prefix of a family key ("delta:*" → "delta:"), or undefined for an exact key. */
function familyPrefix(key: string): string | undefined {
  return key.endsWith("*") ? key.slice(0, -1) : undefined;
}

/** True when the key `key` (exact, or a family) declares the concrete job `job`. */
function keyDeclares(key: string, job: string): boolean {
  const prefix = familyPrefix(key);
  if (prefix === undefined) return key === job;
  return job.length > prefix.length && job.startsWith(prefix) && NAME.test(job);
}

/** True when keys `a` and `b` declare a job in common (§2). */
function overlaps(a: string, b: string): boolean {
  const pa = familyPrefix(a);
  const pb = familyPrefix(b);
  if (pa === undefined && pb === undefined) return a === b;
  if (pa !== undefined && pb !== undefined) return pa.startsWith(pb) || pb.startsWith(pa);
  return pa === undefined ? keyDeclares(b, a) : keyDeclares(a, b);
}

function parseJob(key: string, raw: unknown, modes: readonly string[]): JobDecl {
  const at = `jobs.${key}`;
  const f = fields(at, raw, JOB_KEYS, JOB_REQUIRED);
  const lock = own(f, "lock");
  if (typeof lock !== "string" || !LOCK_ENTRY.test(lock) || lock.length > MAX_LOCK_BYTES) {
    throw refuse.invalid(
      `${at}.lock`,
      "a lock name matching [a-z0-9][a-z0-9:._-]* (optionally ending in one *) of at most 200 bytes",
      lock,
    );
  }
  if (familyPrefix(lock) !== undefined && familyPrefix(key) === undefined) {
    // A family lock names its run's lock by the job family's prefix (§2): an exact job has none.
    throw refuse.invalid(`${at}.lock`, "an exact lock name for an exact job", lock);
  }
  const jobModes = nameList(`${at}.modes`, own(f, "modes"), 8, modes);
  const reconciles = bool(`${at}.reconciles`, own(f, "reconciles"));
  const metered = bool(`${at}.metered`, own(f, "metered"));
  const rawMax = own(f, "maxAgeHours");
  const maxAgeHours = rawMax === null ? null : hours(`${at}.maxAgeHours`, rawMax);
  const rawGrace = own(f, "interruptedGraceHours");
  let interruptedGraceHours: number | null = null;
  if (maxAgeHours === null) {
    if (rawGrace !== null) {
      throw refuse.invalid(
        `${at}.interruptedGraceHours`,
        "null when maxAgeHours is null",
        rawGrace,
      );
    }
  } else {
    if (!finiteIn(rawGrace, 0, maxAgeHours)) {
      throw refuse.invalid(
        `${at}.interruptedGraceHours`,
        `a finite number from 0 to maxAgeHours (${maxAgeHours})`,
        rawGrace,
      );
    }
    interruptedGraceHours = rawGrace;
  }
  const staleHeartbeatSeconds = bounded(
    refuse,
    `${at}.staleHeartbeatSeconds`,
    own(f, "staleHeartbeatSeconds"),
    10,
    86_400,
  );
  const rawPush = own(f, "push");
  let push: JobDecl["push"] = null;
  if (rawPush !== undefined) {
    const p = fields(`${at}.push`, rawPush, PUSH_KEYS, [...PUSH_KEYS]);
    push = Object.freeze({
      maxAgeHours: hours(`${at}.push.maxAgeHours`, own(p, "maxAgeHours")),
      heartbeat: bool(`${at}.push.heartbeat`, own(p, "heartbeat")),
    });
  }
  const rawCounters = own(f, "counters");
  const counters: Record<string, string> = {};
  if (rawCounters !== undefined) {
    const c = fields(`${at}.counters`, rawCounters, new Set(COUNTER_KEYS), []);
    for (const name of COUNTER_KEYS) {
      const v = own(c, name);
      if (v === undefined) continue;
      if (typeof v !== "string" || !COUNTER.test(v)) {
        throw refuse.invalid(
          `${at}.counters.${name}`,
          "a counter name matching [a-z0-9_.:-]{1,64}",
          v,
        );
      }
      counters[name] = v;
    }
  }
  const rawSpike = own(f, "spike");
  let spike: JobDecl["spike"] = null;
  if (rawSpike === undefined) {
    if (counters.archived !== undefined) throw refuse.required(`${at}.spike`);
  } else {
    if (counters.archived === undefined) {
      throw refuse.invalid(`${at}.spike`, "absent unless counters.archived is declared", rawSpike);
    }
    const s = fields(`${at}.spike`, rawSpike, SPIKE_KEYS, [...SPIKE_KEYS]);
    spike = Object.freeze({
      share: share(`${at}.spike.share`, own(s, "share")),
      allowance: bounded(refuse, `${at}.spike.allowance`, own(s, "allowance"), 0, 1_000_000),
    });
  }
  return Object.freeze({
    key,
    lock,
    modes: jobModes,
    reconciles,
    metered,
    maxAgeHours,
    interruptedGraceHours,
    staleHeartbeatSeconds,
    push,
    counters: Object.freeze(counters),
    spike,
  });
}

function parseJobs(raw: unknown, modes: readonly string[]): Readonly<Record<string, JobDecl>> {
  const jobs = refuse.record("jobs", raw);
  const keys = Object.keys(jobs);
  if (keys.length < 1 || keys.length > 200) {
    throw refuse.invalid("jobs", "an object of 1 to 200 jobs", keys.length);
  }
  const seen: string[] = [];
  const out: [string, JobDecl][] = [];
  for (const key of keys) {
    const prefix = familyPrefix(key);
    const name = prefix ?? key;
    if (!NAME.test(name) || name.includes("*")) throw refuse.invalid(`jobs.${key}`, E_JOB_KEY, key);
    const earlier = seen.find((k) => overlaps(k, key));
    if (earlier !== undefined) throw new Error(`${PARSER}: jobs: ${key} overlaps ${earlier}`);
    seen.push(key);
    out.push([key, parseJob(key, jobs[key], modes)]);
  }
  return Object.freeze(Object.fromEntries(out));
}

function parsePrices(raw: unknown): {
  prices: RunsSlice["prices"];
  micro: ReadonlyMap<string, PriceMicros>;
} {
  const map = refuse.record("prices", raw);
  const micro = new Map<string, PriceMicros>();
  const known = new Set(PRICE_KEYS);
  const entries = Object.keys(map).map((model) => {
    const at = `prices.${model}`;
    if (!MODEL.test(model)) {
      throw refuse.invalid(at, "a model key matching [A-Za-z0-9_./:-]{1,128}", model);
    }
    const f = fields(at, map[model], known, PRICE_KEYS);
    const toMicro = (key: (typeof PRICE_KEYS)[number]): bigint => {
      const p = own(f, key);
      if (!finiteIn(p, 0, 10_000)) throw refuse.invalid(`${at}.${key}`, E_PRICE, p);
      const m = Math.round(p * 1_000_000);
      if (Math.abs(p * 1_000_000 - m) > 1e-6) {
        throw refuse.invalid(`${at}.${key}`, E_PRICE_DECIMALS, p);
      }
      return BigInt(m);
    };
    micro.set(
      model,
      Object.freeze({ input: toMicro("inputPerMTok"), output: toMicro("outputPerMTok") }),
    );
    return [
      model,
      Object.freeze({
        inputPerMTok: own(f, "inputPerMTok") as number,
        outputPerMTok: own(f, "outputPerMTok") as number,
      }),
    ] as const;
  });
  return { prices: Object.freeze(Object.fromEntries(entries)), micro };
}

/** `lockTable: { schema?, name? }`, as tableRef does for `table`. */
function lockTableRef(raw: unknown, schema: string): RunsSlice["lockTable"] {
  const t = raw === undefined ? {} : refuse.record("lockTable", raw);
  refuse.refuseUnknownKeys(t, new Set(["schema", "name"]), "lockTable.");
  const s = own(t, "schema");
  const n = own(t, "name");
  return Object.freeze({
    schema: identifier(refuse, "lockTable.schema", s === undefined ? schema : s),
    name: identifier(refuse, "lockTable.name", n === undefined ? "run_locks" : n),
  });
}

/**
 * Parses the runs slice into a frozen, branded object. Every policy number is
 * required; only identifiers default (`table`, `lockTable`, and the
 * columns of a given `quarantine`); an absent `quarantine` is null. Refuses in the shared order: unknown keys, then required fields,
 * then values, at every level. Job keys are exact names or `prefix*`
 * families that never overlap (§2).
 */
export function runsSlice(input: RunsSliceInput, defaults?: { schema?: string }): RunsSlice {
  const f: Fields = isRecord(input) ? input : {};
  refuse.refuseUnknownKeys(f, KEYS, "");
  for (const key of REQUIRED) {
    if (own(f, key) === undefined) throw refuse.required(key);
  }
  const schema = defaults?.schema ?? "rootstock";
  const table = tableRef(refuse, own(f, "table"), "", schema, "runs");
  const lockTable = lockTableRef(own(f, "lockTable"), schema);
  const rawQuarantine = own(f, "quarantine");
  const quarantine =
    rawQuarantine === undefined
      ? null
      : parseQuarantine(refuse, rawQuarantine, "quarantine.", schema);
  const modes = nameList("modes", own(f, "modes"), 16);
  const jobs = parseJobs(own(f, "jobs"), modes);
  const { prices, micro } = parsePrices(own(f, "prices"));
  const brakes = namedMap("brakes", own(f, "brakes"), BRAKE_KEYS, (at, b) => {
    const rounding = own(b, "rounding");
    const out: BrakeDecl = {
      share: share(`${at}.share`, own(b, "share")),
      allowance: bounded(refuse, `${at}.allowance`, own(b, "allowance"), 0, 1_000_000),
      armAt: bounded(refuse, `${at}.armAt`, own(b, "armAt"), 0, 1_000_000),
      rounding: rounding as BrakeDecl["rounding"],
    };
    if (rounding !== "ceil" && rounding !== "none") {
      throw refuse.invalid(`${at}.rounding`, '"ceil" or "none"', rounding);
    }
    return out;
  });
  const budgets = namedMap("budgets", own(f, "budgets"), BUDGET_KEYS, (at, b) => ({
    limit: bounded(refuse, `${at}.limit`, own(b, "limit"), 1, 1_000_000),
    windowMinutes: bounded(refuse, `${at}.windowMinutes`, own(b, "windowMinutes"), 1, 10_080),
  }));
  const breakers = namedMap("breakers", own(f, "breakers"), BREAKER_KEYS, (at, b) => ({
    limit: bounded(refuse, `${at}.limit`, own(b, "limit"), 1, 100),
  }));
  const r = fields("retention", own(f, "retention"), new Set(RETENTION_KEYS), RETENTION_KEYS);
  const retention = Object.freeze({
    keepDays: bounded(refuse, "retention.keepDays", own(r, "keepDays"), 7, 3_650),
  });
  const maxCountKeys = bounded(refuse, "maxCountKeys", own(f, "maxCountKeys"), 1, 500);
  const maxReasonChars = bounded(refuse, "maxReasonChars", own(f, "maxReasonChars"), 64, 10_000);
  const maxScopeBytes = bounded(refuse, "maxScopeBytes", own(f, "maxScopeBytes"), 1_024, 4_194_304);
  const slice = brand.mark(
    Object.freeze({
      table,
      lockTable,
      quarantine,
      modes,
      jobs,
      prices,
      brakes,
      budgets,
      breakers,
      retention,
      maxCountKeys,
      maxReasonChars,
      maxScopeBytes,
    }) as unknown as RunsSlice,
  );
  micros.set(slice, micro);
  return slice;
}

/** Refuses any slice `runsSlice` did not return, naming the caller. */
export function assertRunsSlice(fn: string, value: unknown): asserts value is RunsSlice {
  brand.assert(fn, value);
}

/** The slice's prices in micro-dollars per million tokens, parsed once by `runsSlice`. */
export function priceMicros(slice: RunsSlice): ReadonlyMap<string, PriceMicros> {
  assertRunsSlice("priceMicros", slice);
  return micros.get(slice) as ReadonlyMap<string, PriceMicros>;
}

/**
 * The declaration of the concrete job `job`: the exact key first, then the
 * one family whose prefix it starts with (§2). Throws JOB otherwise.
 */
export function jobDecl(slice: RunsSlice, job: string): JobDecl {
  assertRunsSlice("jobDecl", slice);
  if (typeof job === "string") {
    const exact = own(slice.jobs, job);
    if (exact !== undefined && familyPrefix(job) === undefined) return exact;
    for (const key of Object.keys(slice.jobs)) {
      if (familyPrefix(key) !== undefined && keyDeclares(key, job)) {
        return slice.jobs[key] as JobDecl;
      }
    }
  }
  throw refusals.job(job, Object.keys(slice.jobs));
}

/**
 * The lock name the concrete job `job` runs under: the declared lock, or for
 * a family lock, the job name with the job family's prefix replaced by the
 * lock family's (§2).
 */
export function lockNameFor(decl: JobDecl, job: string): string {
  const lockPrefix = familyPrefix(decl.lock);
  const jobPrefix = familyPrefix(decl.key);
  if (lockPrefix === undefined || jobPrefix === undefined) return decl.lock;
  return lockPrefix + job.slice(jobPrefix.length);
}
