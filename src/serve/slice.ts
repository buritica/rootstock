// The serve config slice (W5 contract §8): the numbers of one serving
// profile, its limits and its probe timing, for defineRootstockConfig to
// check and print. Config and print only: createMcpService keeps its own
// options, and a consumer passes these values into them. This file loads
// nothing beyond the shared slice pieces, so `config` composes it without
// the MCP SDK peer.

import { type Brand, isRecord, own, sliceBrand, sliceRefusals } from "../internal/slice.ts";
import { isNonNegativeNumber, isPositiveInteger, isPositiveNumber } from "./errors.ts";
import type { BucketLimits, ConcurrencyGroup, TurnBudgetLimits } from "./limits.ts";
import type { ProbeTiming } from "./probes.ts";
import type { Caller, ServeProfile } from "./types.ts";

type Kind = Caller["kind"];

export interface ServeSliceInput {
  /** The serving profile's id (`ServeProfile.id`). */
  id: string;
  /** `ServeProfile.bodyLimit`: bytes per caller kind, null for no rootstock cap. */
  bodyLimit: Readonly<Record<Kind, number | null>>;
  /** `ServeProfile.deadlineMs`. */
  deadlineMs: number | null;
  /**
   * The listener's idle timeout in seconds (`SERVE_HARDENING.idleTimeout`
   * when the consumer spreads it into `Bun.serve`), or null when the
   * listener is not one rootstock's numbers describe.
   */
  idleTimeout: number | null;
  /** `ServeProfile.shutdown`. */
  shutdown: ServeProfile["shutdown"];
  /** The numbers of `Limits`; the consumer's wording (`busy`, `exhausted`) stays in its code. */
  limits: {
    refusal: BucketLimits | null;
    serving: BucketLimits | null;
    perTool: Readonly<Record<string, BucketLimits>>;
    concurrency: Readonly<Record<string, Omit<ConcurrencyGroup, "busy">>>;
    turnBudget: Omit<TurnBudgetLimits, "exhausted"> | null;
    logIntervalMs: number;
  };
  /** The readiness probes' `ProbeTiming`. */
  probes: ProbeTiming;
}

type Frozen<T> = { readonly [K in keyof T]: T[K] extends object ? Frozen<T[K]> : T[K] };

declare const serveSliceBrand: unique symbol;
export interface ServeSlice extends Frozen<ServeSliceInput> {
  readonly [serveSliceBrand]: true;
}

const PARSER = "serveSlice";
const REQUIRED = [
  "id",
  "bodyLimit",
  "deadlineMs",
  "idleTimeout",
  "shutdown",
  "limits",
  "probes",
] as const;
const KINDS = ["oauth", "bearer", "local", "none"] as const satisfies readonly Kind[];
const SHUTDOWN = ["drainMs", "forceMs", "poolEndTimeoutS", "flushMs"] as const;
const LIMITS = [
  "refusal",
  "serving",
  "perTool",
  "concurrency",
  "turnBudget",
  "logIntervalMs",
] as const;
const BUCKET = ["capacity", "refillPerSecond", "maxKeys"] as const;
const GROUP = ["tools", "max"] as const;
const TURN = ["cap", "warnAt", "maxTurns"] as const;
const PROBES = ["timeoutMs", "cacheTtlMs", "pendingMaxMs"] as const;
const ID = /^[a-z0-9][a-z0-9.-]*$/;

/** Each key list above as a Set, for the unknown-key check. */
const KEY_SETS: ReadonlyMap<readonly string[], ReadonlySet<string>> = new Map(
  [REQUIRED, KINDS, SHUTDOWN, LIMITS, BUCKET, GROUP, TURN, PROBES].map((keys) => [
    keys,
    new Set(keys),
  ]),
);

const refuse = sliceRefusals(PARSER);
const brand: Brand<ServeSlice> = sliceBrand("ServeSlice", PARSER);

/** `path.` for a nested object, nothing at the top level. */
const at = (path: string): string => (path === "" ? "" : `${path}.`);

/** `raw` as an object holding exactly `keys`, each present, or the refusal. */
function exact(path: string, raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = path === "" && !isRecord(raw) ? {} : refuse.record(path, raw);
  refuse.refuseUnknownKeys(r, KEY_SETS.get(keys) ?? new Set(keys), at(path));
  for (const k of keys) if (own(r, k) === undefined) throw refuse.required(`${at(path)}${k}`);
  return r;
}

/** `v` when `test` holds (the rule serve applies at runtime), else the refusal. */
function num(path: string, v: unknown, test: (v: unknown) => v is number, expected: string) {
  if (!test(v)) throw refuse.invalid(path, expected, v);
  return v;
}
const posInt = (path: string, v: unknown) => num(path, v, isPositiveInteger, "an integer > 0");
const posNum = (path: string, v: unknown) => num(path, v, isPositiveNumber, "a finite number > 0");
const nonNeg = (path: string, v: unknown) =>
  num(path, v, isNonNegativeNumber, "a finite number >= 0");
const isNonNegativeInteger = (v: unknown): v is number =>
  isNonNegativeNumber(v) && Number.isInteger(v);

function orNull<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === null ? null : parse(v);
}

/** An object of exactly `keys`, each value through `parse`, frozen. */
function numbers<K extends string, T>(
  path: string,
  raw: unknown,
  keys: readonly K[],
  parse: (path: string, v: unknown) => T,
): Readonly<Record<K, T>> {
  const r = exact(path, raw, keys);
  const out = {} as Record<K, T>;
  for (const k of keys) out[k] = parse(`${path}.${k}`, own(r, k));
  return Object.freeze(out);
}

/** The bucket numbers createRateLimiter accepts. */
const bucket = (path: string, raw: unknown): BucketLimits => numbers(path, raw, BUCKET, posNum);

/** A map keyed by tool or group name, each entry through `entry`. */
function named<T>(path: string, raw: unknown, entry: (p: string, v: unknown) => T) {
  const m = refuse.record(path, raw);
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === "") throw refuse.invalid(path, "keyed by non-empty names", m);
    out[k] = entry(`${path}.${k}`, v);
  }
  return Object.freeze(out);
}

function group(path: string, raw: unknown): Omit<ConcurrencyGroup, "busy"> {
  const g = exact(path, raw, GROUP);
  const tools = own(g, "tools");
  if (
    !Array.isArray(tools) ||
    tools.length === 0 ||
    !tools.every((t) => typeof t === "string" && t !== "")
  ) {
    throw refuse.invalid(`${path}.tools`, "a non-empty array of tool names", tools);
  }
  return Object.freeze({
    tools: Object.freeze([...(tools as string[])]),
    max: posInt(`${path}.max`, own(g, "max")),
  });
}

function turnBudget(raw: unknown): Omit<TurnBudgetLimits, "exhausted"> {
  const t = exact("limits.turnBudget", raw, TURN);
  return Object.freeze({
    cap: posInt("limits.turnBudget.cap", own(t, "cap")),
    warnAt: num(
      "limits.turnBudget.warnAt",
      own(t, "warnAt"),
      isNonNegativeInteger,
      "an integer >= 0",
    ),
    maxTurns: posInt("limits.turnBudget.maxTurns", own(t, "maxTurns")),
  });
}

function limits(raw: unknown): ServeSlice["limits"] {
  const l = exact("limits", raw, LIMITS);
  return Object.freeze({
    refusal: orNull(own(l, "refusal"), (v) => bucket("limits.refusal", v)),
    serving: orNull(own(l, "serving"), (v) => bucket("limits.serving", v)),
    perTool: named("limits.perTool", own(l, "perTool"), bucket),
    concurrency: named("limits.concurrency", own(l, "concurrency"), group),
    turnBudget: orNull(own(l, "turnBudget"), turnBudget),
    logIntervalMs: nonNeg("limits.logIntervalMs", own(l, "logIntervalMs")),
  });
}

/**
 * Parses the serve slice: one serving profile's body limits, deadline and
 * shutdown numbers, the listener's idle timeout, the limits' numbers and the
 * probe timing, each held to the rule createMcpService, createRateLimiter,
 * the limiters and readiness apply. Every key is required (null where the
 * profile has none). Config checks `deadlineMs` against `idleTimeout`, and
 * the probe timeout against `pendingMaxMs`; that every `perTool` and
 * `concurrency` tool exists is checked when the service is built.
 */
export function serveSlice(input: ServeSliceInput): ServeSlice {
  const raw = exact("", input, REQUIRED);
  const id = own(raw, "id");
  if (typeof id !== "string" || !ID.test(id)) {
    throw refuse.invalid("id", "a string matching [a-z0-9][a-z0-9.-]*", id);
  }
  const slice = Object.freeze({
    id,
    bodyLimit: numbers("bodyLimit", own(raw, "bodyLimit"), KINDS, (p, v) =>
      orNull(v, (n) => posInt(p, n)),
    ),
    deadlineMs: orNull(own(raw, "deadlineMs"), (v) => posInt("deadlineMs", v)),
    idleTimeout: orNull(own(raw, "idleTimeout"), (v) => posNum("idleTimeout", v)),
    shutdown: numbers("shutdown", own(raw, "shutdown"), SHUTDOWN, nonNeg),
    limits: limits(own(raw, "limits")),
    probes: numbers("probes", own(raw, "probes"), PROBES, nonNeg),
  }) as ServeSlice;
  return brand.mark(slice);
}
