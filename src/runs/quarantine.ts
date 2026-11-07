import {
  type Brand,
  bounded,
  identifier,
  isRecord,
  own,
  type SliceRefusals,
  sliceBrand,
  sliceRefusals,
  tableRef,
} from "../internal/slice.ts";

export interface QuarantineTableInput {
  /** Default { <default schema>, "quarantine" }. */
  table?: { schema?: string; name?: string };
  /** Column names; defaults are rootstock's. `runId: null` = the table has no run column. */
  columns?: {
    job?: string;
    externalId?: string;
    payload?: string;
    reason?: string;
    status?: string;
    failedAt?: string;
    resolvedAt?: string;
    runId?: string | null;
  };
  /** 1 024 – 16 777 216. */
  maxPayloadBytes: number;
  /** 16 – 10 000. */
  maxReasonChars: number;
}

declare const quarantineTableBrand: unique symbol;
export interface QuarantineTable {
  readonly [quarantineTableBrand]: true;
  readonly table: { readonly schema: string; readonly name: string };
  readonly columns: {
    readonly job: string;
    readonly externalId: string;
    readonly payload: string;
    readonly reason: string;
    readonly status: string;
    readonly failedAt: string;
    readonly resolvedAt: string;
    /** null: the table has no run column (QU1′). */
    readonly runId: string | null;
  };
  readonly maxPayloadBytes: number;
  readonly maxReasonChars: number;
}

const KEYS: ReadonlySet<string> = new Set([
  "table",
  "columns",
  "maxPayloadBytes",
  "maxReasonChars",
]);
const REQUIRED = ["maxPayloadBytes", "maxReasonChars"] as const;
const COLUMN_DEFAULTS = {
  job: "job",
  externalId: "external_id",
  payload: "payload",
  reason: "reason",
  status: "status",
  failedAt: "failed_at",
  resolvedAt: "resolved_at",
  runId: "run_id",
} as const;
const COLUMN_KEYS: ReadonlySet<string> = new Set(Object.keys(COLUMN_DEFAULTS));

const quarantineRefuse = sliceRefusals("quarantineTable");
const brand: Brand<QuarantineTable> = sliceBrand("QuarantineTable", "quarantineTable");

/**
 * The quarantine table's fields, refused under `refuse` at path prefix `at`
 * (`""` standalone, `"quarantine."` inside the runs slice).
 */
export function parseQuarantine(
  refuse: SliceRefusals,
  input: unknown,
  at: string,
  schema: string,
): QuarantineTable {
  const fields = at === "" ? (isRecord(input) ? input : {}) : refuse.record(at.slice(0, -1), input);
  refuse.refuseUnknownKeys(fields, KEYS, at);
  for (const key of REQUIRED) {
    if (own(fields, key) === undefined) throw refuse.required(`${at}${key}`);
  }
  const table = tableRef(refuse, own(fields, "table"), at, schema, "quarantine");
  const rawColumns = own(fields, "columns");
  const given = rawColumns === undefined ? {} : refuse.record(`${at}columns`, rawColumns);
  refuse.refuseUnknownKeys(given, COLUMN_KEYS, `${at}columns.`);
  const column = (key: keyof typeof COLUMN_DEFAULTS): string => {
    const v = own(given, key);
    return identifier(refuse, `${at}columns.${key}`, v === undefined ? COLUMN_DEFAULTS[key] : v);
  };
  const rawRunId = own(given, "runId");
  const columns = Object.freeze({
    job: column("job"),
    externalId: column("externalId"),
    payload: column("payload"),
    reason: column("reason"),
    status: column("status"),
    failedAt: column("failedAt"),
    resolvedAt: column("resolvedAt"),
    runId: rawRunId === null ? null : column("runId"),
  });
  const maxPayloadBytes = bounded(
    refuse,
    `${at}maxPayloadBytes`,
    own(fields, "maxPayloadBytes"),
    1_024,
    16_777_216,
  );
  const maxReasonChars = bounded(
    refuse,
    `${at}maxReasonChars`,
    own(fields, "maxReasonChars"),
    16,
    10_000,
  );
  return brand.mark(
    Object.freeze({
      table,
      columns,
      maxPayloadBytes,
      maxReasonChars,
    }) as unknown as QuarantineTable,
  );
}

/**
 * Parses a quarantine table into a frozen, branded object: where a job's
 * unloadable records live and what its columns are called. The table must
 * have a unique index on (job, externalId) and a status column taking
 * 'pending' / 'resolved'; that is not checked here.
 */
export function quarantineTable(
  input: QuarantineTableInput,
  defaults?: { schema?: string },
): QuarantineTable {
  return parseQuarantine(quarantineRefuse, input, "", defaults?.schema ?? "rootstock");
}

export function assertQuarantineTable(
  fn: string,
  value: unknown,
): asserts value is QuarantineTable {
  brand.assert(fn, value);
}
