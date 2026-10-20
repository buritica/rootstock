// The parts of the db, migrate and concurrency surfaces that config reads,
// declared from their frozen signatures. Each view leaves out its slice's
// brand: the real branded slice is assignable to the view, so this compiles
// the same before and after those subpaths export their own types.

export type DriverDefault = "driver-default";

export interface ConnectionProfileInput {
  max: number | DriverDefault;
  maxCeiling: number;
  idleTimeoutSeconds: number | DriverDefault;
  maxLifetimeSeconds: number | "never" | DriverDefault;
  connectTimeoutSeconds: number | DriverDefault;
  prepare: boolean | DriverDefault;
  keepAliveSeconds: number | DriverDefault;
  statementTimeoutMs: number;
  readOnly: boolean;
}

export interface ClientSliceInput {
  profiles: Readonly<Record<string, ConnectionProfileInput>>;
}

export interface ClientSlice {
  readonly profiles: Readonly<Record<string, Readonly<ConnectionProfileInput>>>;
}

export interface MigrateSliceInput {
  schema?: string;
  ahead: "refuse" | "allow";
}

export interface MigrateSlice {
  readonly schema: string;
  readonly ahead: "refuse" | "allow";
}

export interface WidthInput {
  default: number;
  max: number;
}

export interface ConcurrencySliceInput {
  widths: Readonly<Record<string, WidthInput>>;
}

export interface ConcurrencySlice {
  readonly widths: Readonly<Record<string, Readonly<WidthInput>>>;
}

/** The three slice parsers config composes, in the order it calls them. */
export interface SliceParsers {
  clientSlice(input: ClientSliceInput): ClientSlice;
  migrateSlice(input: MigrateSliceInput): MigrateSlice;
  concurrencySlice(input: ConcurrencySliceInput): ConcurrencySlice;
}
