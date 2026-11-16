// The serve config slice (W5 contract §8): the numbers of one serving
// profile, its limits and its probe timing, for defineRootstockConfig to
// check and print. Config and print only: createMcpService keeps its own
// options, and a consumer passes these values into them. This file loads
// nothing beyond the shared slice pieces, so `config` composes it without
// the MCP SDK peer.

import { type Brand, intIn, isRecord, own, sliceBrand, sliceRefusals } from "../internal/slice.ts";
import type { BucketLimits, TurnBudgetLimits } from "./limits.ts";
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
    concurrency: Readonly<Record<string, { tools: readonly string[]; max: number }>>;
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

const refuse = sliceRefusals(PARSER);
const brand: Brand<ServeSlice> = sliceBrand("ServeSlice", PARSER);

/** `raw` as an object holding exactly `keys`, each present, or the refusal. */
function exact(path: string, raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = refuse.record(path, raw);
  refuse.refuseUnknownKeys(r, new Set(keys), `${path}.`);
  for (const k of keys) if (own(r, k) === undefined) throw refuse.required(`${path}.${k}`);
  return r;
}

const E_POS_INT = "an integer > 0";
const E_POS_NUM = "a finite number > 0";
const E_NON_NEG = "a finite number >= 0";

function posInt(path: string, v: unknown): number {
  if (!intIn(v, 1, Number.MAX_SAFE_INTEGER)) throw refuse.invalid(path, E_POS_INT, v);
  return v;
}
function posNum(path: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw refuse.invalid(path, E_POS_NUM, v);
  }
  return v;
}
function nonNeg(path: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw refuse.invalid(path, E_NON_NEG, v);
  }
  return v;
}
function orNull<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === null ? null : parse(v);
}

/** The bucket numbers createRateLimiter accepts. */
function bucket(path: string, raw: unknown): BucketLimits {
  const b = exact(path, raw, BUCKET);
  return Object.freeze({
    capacity: posNum(`${path}.capacity`, own(b, "capacity")),
    refillPerSecond: posNum(`${path}.refillPerSecond`, own(b, "refillPerSecond")),
    maxKeys: posNum(`${path}.maxKeys`, own(b, "maxKeys")),
  });
}

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

function group(path: string, raw: unknown) {
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
  const warnAt = own(t, "warnAt");
  if (!intIn(warnAt, 0, Number.MAX_SAFE_INTEGER)) {
    throw refuse.invalid("limits.turnBudget.warnAt", "an integer >= 0", warnAt);
  }
  return Object.freeze({
    cap: posInt("limits.turnBudget.cap", own(t, "cap")),
    warnAt,
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
  const raw: Record<string, unknown> = isRecord(input) ? input : {};
  refuse.refuseUnknownKeys(raw, new Set(REQUIRED), "");
  for (const k of REQUIRED) if (own(raw, k) === undefined) throw refuse.required(k);
  const id = own(raw, "id");
  if (typeof id !== "string" || !ID.test(id)) {
    throw refuse.invalid("id", "a string matching [a-z0-9][a-z0-9.-]*", id);
  }
  const b = exact("bodyLimit", own(raw, "bodyLimit"), KINDS);
  const bodyLimit = Object.freeze(
    Object.fromEntries(
      KINDS.map((k) => [k, orNull(own(b, k), (v) => posInt(`bodyLimit.${k}`, v))]),
    ) as Record<Kind, number | null>,
  );
  const s = exact("shutdown", own(raw, "shutdown"), SHUTDOWN);
  const shutdown = Object.freeze(
    Object.fromEntries(SHUTDOWN.map((k) => [k, nonNeg(`shutdown.${k}`, own(s, k))])) as Record<
      (typeof SHUTDOWN)[number],
      number
    >,
  );
  const p = exact("probes", own(raw, "probes"), PROBES);
  const probes = Object.freeze(
    Object.fromEntries(PROBES.map((k) => [k, nonNeg(`probes.${k}`, own(p, k))])) as Record<
      (typeof PROBES)[number],
      number
    >,
  );
  const slice = Object.freeze({
    id,
    bodyLimit,
    deadlineMs: orNull(own(raw, "deadlineMs"), (v) => posInt("deadlineMs", v)),
    idleTimeout: orNull(own(raw, "idleTimeout"), (v) => posNum("idleTimeout", v)),
    shutdown,
    limits: limits(own(raw, "limits")),
    probes,
  }) as ServeSlice;
  return brand.mark(slice);
}
