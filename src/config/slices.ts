import type * as concurrency from "../concurrency/index.ts";
import type * as db from "../db/index.ts";
import type * as migrate from "../migrate/index.ts";

// The parts of the db, migrate and concurrency surfaces that config reads,
// declared from their frozen signatures. While a subpath exports nothing,
// config uses these views; once it exports its parser, `Parser` below picks
// up the real signature, so both the input and the branded slice types come
// from that subpath and the views here go unused.

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

export interface ClientSliceView {
  readonly profiles: Readonly<Record<string, Readonly<ConnectionProfileInput>>>;
}

export interface MigrateSliceInput {
  schema?: string;
  ahead: "refuse" | "allow";
}

export interface MigrateSliceView {
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

export interface ConcurrencySliceView {
  readonly widths: Readonly<Record<string, Readonly<WidthInput>>>;
}

type Parser<NS, K extends string, Fallback> = K extends keyof NS ? NS[K] : Fallback;

/** The three slice parsers config composes, in the order it calls them. */
export interface SliceParsers {
  clientSlice: Parser<typeof db, "clientSlice", (input: ClientSliceInput) => ClientSliceView>;
  migrateSlice: Parser<
    typeof migrate,
    "migrateSlice",
    (input: MigrateSliceInput) => MigrateSliceView
  >;
  concurrencySlice: Parser<
    typeof concurrency,
    "concurrencySlice",
    (input: ConcurrencySliceInput) => ConcurrencySliceView
  >;
}

type Slice<K extends keyof SliceParsers> = SliceParsers[K] extends (input: never) => infer S
  ? S
  : never;

type Input<K extends keyof SliceParsers> = SliceParsers[K] extends (input: infer I) => unknown
  ? I
  : never;

export type ClientInput = Input<"clientSlice">;
export type MigrateInput = Input<"migrateSlice">;
export type ConcurrencyInput = Input<"concurrencySlice">;

export type ClientSlice = Slice<"clientSlice">;
export type MigrateSlice = Slice<"migrateSlice">;
export type ConcurrencySlice = Slice<"concurrencySlice">;
