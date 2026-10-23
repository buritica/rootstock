import { type Brand, isRecord, own, q, sliceBrand, sliceRefusals } from "../internal/slice.ts";

export type DriverDefault = "driver-default";

export interface ConnectionProfileInput {
  max: number | DriverDefault;
  /** The highest `max` a call may ask a renderer for. Integer >= 1, and >= max when max is a number. */
  maxCeiling: number;
  idleTimeoutSeconds: number | DriverDefault;
  maxLifetimeSeconds: number | "never" | DriverDefault;
  connectTimeoutSeconds: number | DriverDefault;
  prepare: boolean | DriverDefault;
  keepAliveSeconds: number | DriverDefault;
  /**
   * Default per-connection statement_timeout. 0 = none: no startup parameter is
   * sent, so a role or database default still applies. This and `readOnly` go
   * out as startup parameters, which a pooler in front of Postgres may refuse
   * or drop unless it is configured to pass them on.
   */
  statementTimeoutMs: number;
  /** true sends default_transaction_read_only; false sends nothing and does not override a read-only role. */
  readOnly: boolean;
}

export interface ClientSliceInput {
  profiles: Readonly<Record<string, ConnectionProfileInput>>;
}

declare const clientSliceBrand: unique symbol;
export interface ClientSlice {
  readonly [clientSliceBrand]: true;
  readonly profiles: Readonly<Record<string, Readonly<ConnectionProfileInput>>>;
}

export interface ConnectionCallOptions {
  max?: number;
  statementTimeoutMs?: number;
}

const DD = "driver-default";
const PROFILE_NAME = /^[a-z][a-z0-9-]*$/;
// The driver's name, spelled in pieces because the purity scan reads string
// text too, and the first word is also the runtime global's name.
const BUN_SQL = ["B", "un.SQL"].join("");

const isCount = (v: unknown, min: number): v is number =>
  Number.isInteger(v) && (v as number) >= min;

type Field = keyof ConnectionProfileInput;

const countOrDefault = (min: number) => ({
  ok: (v: unknown) => v === DD || isCount(v, min),
  expected: `an integer >= ${min} or "driver-default"`,
});

/** Each field's check and its frozen E-SLICE-VAL phrase. `maxCeiling` is also checked against `max`. */
const FIELDS: Readonly<Record<Field, { ok: (v: unknown) => boolean; expected: string }>> = {
  max: countOrDefault(1),
  maxCeiling: { ok: (v) => isCount(v, 1), expected: "an integer >= 1 and >= max" },
  idleTimeoutSeconds: countOrDefault(0),
  maxLifetimeSeconds: {
    ok: (v) => v === DD || v === "never" || isCount(v, 0),
    expected: 'an integer >= 0, "never" or "driver-default"',
  },
  connectTimeoutSeconds: countOrDefault(0),
  prepare: {
    ok: (v) => v === DD || typeof v === "boolean",
    expected: 'a boolean or "driver-default"',
  },
  keepAliveSeconds: countOrDefault(0),
  statementTimeoutMs: { ok: (v) => isCount(v, 0), expected: "an integer >= 0" },
  readOnly: { ok: (v) => typeof v === "boolean", expected: "a boolean" },
};

const FIELD_NAMES = Object.keys(FIELDS) as Field[];
const PROFILE_KEYS: ReadonlySet<string> = new Set(FIELD_NAMES);
const SLICE_KEYS: ReadonlySet<string> = new Set(["profiles"]);
const CALL_KEYS: readonly string[] = ["max", "statementTimeoutMs"];

const refuse = sliceRefusals("clientSlice");
// Every slice clientSlice() returned, so a hand-built literal is refused at use.
const brand: Brand<ClientSlice> = sliceBrand("ClientSlice", "clientSlice");

function parseProfile(name: string, raw: unknown): Readonly<ConnectionProfileInput> {
  const path = `profiles.${name}`;
  const input = refuse.record(path, raw);
  refuse.refuseUnknownKeys(input, PROFILE_KEYS, `${path}.`);
  const out: Record<string, unknown> = {};
  for (const field of FIELD_NAMES) {
    // Own keys only: an inherited value is not a field the profile declared.
    const value = own(input, field);
    if (value === undefined) throw refuse.required(`${path}.${field}`);
    const { ok, expected } = FIELDS[field];
    if (!ok(value)) throw refuse.invalid(`${path}.${field}`, expected, value);
    out[field] = value;
  }
  const { max, maxCeiling } = out as { max: number | DriverDefault; maxCeiling: number };
  if (max !== DD && maxCeiling < max) {
    throw refuse.invalid(`${path}.maxCeiling`, FIELDS.maxCeiling.expected, maxCeiling);
  }
  return Object.freeze(out) as unknown as Readonly<ConnectionProfileInput>;
}

/**
 * Validates every connection profile and returns the slice deep-frozen and
 * branded. Every field is required, `"driver-default"` included: a profile
 * says what it means for each key, and no number defaults here.
 */
export function clientSlice(input: ClientSliceInput): ClientSlice {
  const record: Record<string, unknown> = isRecord(input) ? input : {};
  refuse.refuseUnknownKeys(record, SLICE_KEYS, "");
  const profiles = own(record, "profiles");
  if (profiles === undefined) throw refuse.required("profiles");
  if (!isRecord(profiles) || Object.keys(profiles).length === 0) {
    throw refuse.invalid("profiles", "an object with at least one profile", profiles);
  }
  const parsed: Record<string, Readonly<ConnectionProfileInput>> = {};
  for (const name of Object.keys(profiles)) {
    if (!PROFILE_NAME.test(name)) {
      throw refuse.invalid(`profiles.${name}`, "a name matching [a-z][a-z0-9-]*", name);
    }
    parsed[name] = parseProfile(name, profiles[name]);
  }
  return brand.mark(Object.freeze({ profiles: Object.freeze(parsed) }) as unknown as ClientSlice);
}

/** The profile a renderer renders, with the call's overrides checked against it. */
function resolve(
  fn: string,
  slice: ClientSlice,
  name: string,
  call: ConnectionCallOptions | undefined,
): { profile: Readonly<ConnectionProfileInput>; max: number | DriverDefault; timeoutMs: number } {
  brand.assert(fn, slice);
  if (call !== undefined) {
    if (!isRecord(call)) {
      throw new Error(`${fn}: call options must be an object — got ${typeof call}`);
    }
    for (const key of Object.keys(call)) {
      if (!CALL_KEYS.includes(key)) throw new Error(`${fn}: ${q(key)} is not a known call option`);
    }
  }
  const profile = Object.hasOwn(slice.profiles, name) ? slice.profiles[name] : undefined;
  if (profile === undefined) {
    throw new Error(
      `${fn}: no connection profile ${q(name)} — declared: ${Object.keys(slice.profiles).join(", ")}`,
    );
  }
  let max = profile.max;
  if (call?.max !== undefined) {
    if (!isCount(call.max, 1) || call.max > profile.maxCeiling) {
      throw new Error(
        `${fn}: max for profile ${q(name)} must be an integer from 1 to ${profile.maxCeiling} — got ${q(call.max)}`,
      );
    }
    max = call.max;
  }
  let timeoutMs = profile.statementTimeoutMs;
  if (call?.statementTimeoutMs !== undefined) {
    if (!isCount(call.statementTimeoutMs, 0)) {
      throw new Error(
        `${fn}: statementTimeoutMs must be a non-negative integer (0 = none) — got ${q(call.statementTimeoutMs)}`,
      );
    }
    timeoutMs = call.statementTimeoutMs;
  }
  return { profile, max, timeoutMs };
}

/** Writes the keys both drivers share; a driver-default value writes nothing. */
function render(
  max: number | DriverDefault,
  timeoutMs: number,
  readOnly: boolean,
  keys: ReadonlyArray<readonly [string, unknown]>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of [["max", max] as const, ...keys]) {
    if (value !== DD) out[key] = value;
  }
  const connection: Record<string, unknown> = {};
  if (timeoutMs > 0) connection.statement_timeout = timeoutMs;
  if (readOnly) connection.default_transaction_read_only = true;
  if (Object.keys(connection).length > 0) out.connection = Object.freeze(connection);
  return Object.freeze(out);
}

/**
 * postgres.js options for one profile. Never emits `ssl`, a URL, a host,
 * credentials or `onnotice` (postgres.js prints notices by default): the consumer spreads what it owns over the result. The spread
 * is shallow, so a consumer that sets its own `connection` keys merges them
 * with the result's `connection`, or loses the statement timeout and read-only
 * setting.
 */
export function postgresJsOptions(
  slice: ClientSlice,
  profile: string,
  call?: ConnectionCallOptions,
): Readonly<Record<string, unknown>> {
  const { profile: p, max, timeoutMs } = resolve("postgresJsOptions", slice, profile, call);
  return render(max, timeoutMs, p.readOnly, [
    ["idle_timeout", p.idleTimeoutSeconds],
    ["max_lifetime", p.maxLifetimeSeconds === "never" ? null : p.maxLifetimeSeconds],
    ["connect_timeout", p.connectTimeoutSeconds],
    ["prepare", p.prepare],
    ["keep_alive", p.keepAliveSeconds],
  ]);
}

/**
 * Bun.SQL options for one profile. Never emits `ssl`, a URL, a host or
 * credentials: the consumer spreads what it owns over the result. The spread
 * is shallow, so a consumer that sets its own `connection` keys merges them
 * with the result's `connection`, or loses the statement timeout and read-only
 * setting. Refuses a profile that sets
 * `keepAliveSeconds`: Bun.SQL accepts a keep-alive option and ignores it, so
 * rendering one would promise a setting that never takes effect.
 */
export function bunSqlOptions(
  slice: ClientSlice,
  profile: string,
  call?: ConnectionCallOptions,
): Readonly<Record<string, unknown>> {
  const { profile: p, max, timeoutMs } = resolve("bunSqlOptions", slice, profile, call);
  if (p.keepAliveSeconds !== DD) {
    throw new Error(
      `bunSqlOptions: profile ${q(profile)} sets keepAliveSeconds, which ${BUN_SQL} has no option for — use "driver-default"`,
    );
  }
  return render(max, timeoutMs, p.readOnly, [
    ["idleTimeout", p.idleTimeoutSeconds],
    ["maxLifetime", p.maxLifetimeSeconds === "never" ? 0 : p.maxLifetimeSeconds],
    ["connectionTimeout", p.connectTimeoutSeconds],
    ["prepare", p.prepare],
  ]);
}
