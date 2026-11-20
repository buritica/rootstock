import {
  type Brand,
  bounded,
  identifier,
  isRecord,
  KEEP_DAYS_MAX,
  KEEP_DAYS_MIN,
  own,
  sliceBrand,
  sliceRefusals,
  tableRef,
} from "../internal/slice.ts";
import type { SpendStoreShape, SpendUnit } from "./spend.ts";

type DayUserTokens = Extract<SpendStoreShape, { kind: "day-user-tokens" }>;

export interface UsageSliceInput {
  /** The Postgres call log, or null for none. */
  callLog: {
    /** Default: { schema: <default schema>, name: "mcp_calls" }. */
    table?: { schema?: string; name?: string };
    maxBuffered: number;
    maxBatch: number;
    /**
     * Rows older than `keepDays` (7 to 3650) are deleted by
     * `postgresCallLog`'s writer when the app passes this to it; null keeps
     * every row. Required, so each consumer decides.
     */
    retention: { keepDays: number } | null;
  } | null;
  /** Keep each call's arguments in its record. */
  keepArgs: boolean;
  /** Keep the first text block of each result in its record. */
  keepOutput: boolean;
  /** The daily per-caller ceiling, or null for none. */
  spend: {
    unit: SpendUnit;
    ceiling: number;
    store: { kind: "rootstock"; schema?: string } | DayUserTokens;
  } | null;
}

declare const usageSliceBrand: unique symbol;
export interface UsageSlice {
  readonly [usageSliceBrand]: true;
  readonly callLog: {
    readonly table: { readonly schema: string; readonly name: string };
    readonly maxBuffered: number;
    readonly maxBatch: number;
    readonly retention: { readonly keepDays: number } | null;
  } | null;
  readonly keepArgs: boolean;
  readonly keepOutput: boolean;
  readonly spend: {
    readonly unit: SpendUnit;
    readonly ceiling: number;
    readonly store: Readonly<SpendStoreShape>;
  } | null;
}

const PARSER = "usageSlice";
const REQUIRED = ["callLog", "keepArgs", "keepOutput", "spend"] as const;
const KEYS: ReadonlySet<string> = new Set(REQUIRED);
const CALL_LOG_KEYS: ReadonlySet<string> = new Set([
  "table",
  "maxBuffered",
  "maxBatch",
  "retention",
]);
const RETENTION_KEYS: ReadonlySet<string> = new Set(["keepDays"]);

const SPEND_KEYS: ReadonlySet<string> = new Set(["unit", "ceiling", "store"]);
const ROOTSTOCK_STORE_KEYS: ReadonlySet<string> = new Set(["kind", "schema"]);
const DAY_USER_FIELDS = ["schema", "table", "day", "user", "used"] as const;
const DAY_USER_KEYS: ReadonlySet<string> = new Set(["kind", ...DAY_USER_FIELDS]);
/** The largest call log buffer the slice (and postgresCallLog) accepts. */
export const MAX_BUFFERED = 1_000_000;

const refuse = sliceRefusals(PARSER);
const brand: Brand<UsageSlice> = sliceBrand("UsageSlice", PARSER);

function bool(path: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw refuse.invalid(path, "a boolean", value);
  return value;
}

function parseCallLog(raw: unknown, schema: string): UsageSlice["callLog"] {
  if (raw === null) return null;
  const c = refuse.record("callLog", raw);
  refuse.refuseUnknownKeys(c, CALL_LOG_KEYS, "callLog.");
  for (const k of ["maxBuffered", "maxBatch", "retention"] as const) {
    if (own(c, k) === undefined) throw refuse.required(`callLog.${k}`);
  }
  const table = tableRef(refuse, own(c, "table"), "callLog.", schema, "mcp_calls");
  const maxBuffered = bounded(
    refuse,
    "callLog.maxBuffered",
    own(c, "maxBuffered"),
    1,
    MAX_BUFFERED,
  );
  const maxBatch = bounded(refuse, "callLog.maxBatch", own(c, "maxBatch"), 1, maxBuffered);
  return Object.freeze({
    table,
    maxBuffered,
    maxBatch,
    retention: parseRetention(own(c, "retention")),
  });
}

function parseRetention(raw: unknown): NonNullable<UsageSlice["callLog"]>["retention"] {
  if (raw === null) return null;
  const r = refuse.record("callLog.retention", raw);
  refuse.refuseUnknownKeys(r, RETENTION_KEYS, "callLog.retention.");
  if (own(r, "keepDays") === undefined) throw refuse.required("callLog.retention.keepDays");
  return Object.freeze({
    keepDays: bounded(
      refuse,
      "callLog.retention.keepDays",
      own(r, "keepDays"),
      KEEP_DAYS_MIN,
      KEEP_DAYS_MAX,
    ),
  });
}

function parseStore(raw: unknown, schema: string): NonNullable<UsageSlice["spend"]>["store"] {
  const s = refuse.record("spend.store", raw);
  const kind = own(s, "kind");
  if (kind === "rootstock") {
    refuse.refuseUnknownKeys(s, ROOTSTOCK_STORE_KEYS, "spend.store.");
    const given = own(s, "schema");
    return Object.freeze({
      kind,
      schema: identifier(refuse, "spend.store.schema", given === undefined ? schema : given),
    });
  }
  if (kind === "day-user-tokens") {
    refuse.refuseUnknownKeys(s, DAY_USER_KEYS, "spend.store.");
    for (const k of DAY_USER_FIELDS)
      if (own(s, k) === undefined) throw refuse.required(`spend.store.${k}`);
    const [sc, table, day, user, used] = DAY_USER_FIELDS.map((k) =>
      identifier(refuse, `spend.store.${k}`, own(s, k)),
    ) as [string, string, string, string, string];
    return Object.freeze({ kind, schema: sc, table, day, user, used });
  }
  throw refuse.invalid("spend.store.kind", '"rootstock" or "day-user-tokens"', kind);
}

function parseSpend(raw: unknown, schema: string): UsageSlice["spend"] {
  if (raw === null) return null;
  const s = refuse.record("spend", raw);
  refuse.refuseUnknownKeys(s, SPEND_KEYS, "spend.");
  for (const k of ["unit", "ceiling", "store"] as const) {
    if (own(s, k) === undefined) throw refuse.required(`spend.${k}`);
  }
  const unit = own(s, "unit");
  if (unit !== "tokens" && unit !== "usd")
    throw refuse.invalid("spend.unit", '"tokens" or "usd"', unit);
  const ceiling = own(s, "ceiling");
  if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) {
    throw refuse.invalid("spend.ceiling", "a positive finite number", ceiling);
  }
  const store = parseStore(own(s, "store"), schema);
  if (store.kind === "day-user-tokens" && unit !== "tokens") {
    throw refuse.invalid("spend.unit", '"tokens" for a day-user-tokens store', unit);
  }
  return Object.freeze({ unit, ceiling, store });
}

/**
 * Parses the usage slice: the call log's table and buffer numbers,
 * keepArgs/keepOutput, and the spend ceiling's unit, ceiling and store shape.
 * `defaults.schema` (the schema rootstock's migrations run in; default
 * "rootstock") fills an omitted call log or rootstock-store schema. Config
 * checks that a `unit: "usd"` ceiling has the runs slice's prices.
 */
export function usageSlice(input: UsageSliceInput, defaults?: { schema?: string }): UsageSlice {
  const raw: Record<string, unknown> = isRecord(input) ? input : {};
  refuse.refuseUnknownKeys(raw, KEYS, "");
  for (const k of REQUIRED) if (own(raw, k) === undefined) throw refuse.required(k);
  const schema = defaults?.schema ?? "rootstock";
  const slice = Object.freeze({
    callLog: parseCallLog(own(raw, "callLog"), schema),
    keepArgs: bool("keepArgs", own(raw, "keepArgs")),
    keepOutput: bool("keepOutput", own(raw, "keepOutput")),
    spend: parseSpend(own(raw, "spend"), schema),
  }) as UsageSlice;
  return brand.mark(slice);
}
