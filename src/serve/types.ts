// The types every W5 subpath shares (`serve`, `serve/auth`, `usage`) and the
// three pure scope functions. This file imports nothing: `serve/auth` and
// `usage` load it directly, so it must load without any peer installed.

/** Wall clock (`now`, epoch ms) and a monotonic one (`monotonic`, ms) for durations. */
export interface Clock {
  now(): number;
  monotonic(): number;
}
/** Schedules `fn` after `ms`; returns its cancel. */
export interface Timers {
  set(ms: number, fn: () => void): () => void;
}
/** uuid v4 text. */
export type RandomId = () => string;
export type LogEvent = (event: string, fields: Readonly<Record<string, unknown>>) => void;

export interface Caller {
  /** At most 64 characters. */
  readonly name: string;
  readonly kind: "oauth" | "bearer" | "local" | "none";
  /** Already expanded through `expandScopes`. */
  readonly scopes: ReadonlySet<string>;
  readonly claims?: Readonly<Record<string, unknown>>;
}

export interface ToolScopes {
  readonly id: string;
  /** tool → the scope it requires. */
  readonly tools: Readonly<Record<string, string>>;
  /** scope → the scopes it grants, itself included. */
  readonly implies: Readonly<Record<string, readonly string[]>>;
}

export interface Usage {
  model: string;
  input: number;
  output: number;
  estimated?: boolean;
}

/**
 * handler: a tool handler ran. rejected: the SDK refused before any handler
 * (unknown tool, invalid params). refused: rootstock refused before the SDK
 * (turn budget, per-tool bucket, concurrency, scope guard).
 */
export type CallStage = "handler" | "rejected" | "refused";

export interface CallRecord {
  stage: CallStage;
  caller: string;
  onBehalfOf: string | null;
  turnId: string | null;
  tool: string;
  /** The handler's setArgs value, else the raw arguments, else {}. */
  args: Readonly<Record<string, unknown>>;
  durationMs: number;
  ok: boolean;
  errorClass: string | null;
  /** Only for sinks that ask for it; never stored by the Postgres call log. */
  errorMessage: string | null;
  resultIds: unknown | null;
  phases: Readonly<Record<string, number>> | null;
  tokens: Readonly<Record<string, { input: number; output: number }>> | null;
  costUsd: string | null;
  costNote: string | null;
  outputText: string | null;
  extra: Readonly<Record<string, unknown>> | null;
  serverSha: string | null;
  clientUa: string | null;
  mcpProtocol: string | null;
}

export interface CallSink {
  record(r: CallRecord): void;
  onRegister?(tool: string): void;
  idle?(): Promise<void>;
}

export interface UsageWiring {
  sinks: readonly CallSink[];
  keepArgs: boolean;
  keepOutput: boolean;
  /** A RunsSlice, typed in `usage`; null → costNote "unpriced:<models>". */
  prices: unknown | null;
  spend: SpendCharger | null;
  serverSha: string | null;
}

export interface SpendCharger {
  forCaller(key: string): { assertWithin(): Promise<void>; record(u: Usage): Promise<void> };
}

export interface StoppableServer {
  stop(force?: boolean): Promise<void> | void;
  pending(): number;
}

/** How `mcpPath` answers a method other than POST. "auth-then-entry" hands the bodiless request to the SDK entry and returns its answer untouched. */
export type MethodAnswer = "405-first" | "auth-then-405" | "auth-then-entry";

/** Every field is required: a profile states each consumer's behaviour, never a default. */
export interface ServeProfile {
  id: string;
  /** "/mcp" */
  mcpPath: string;
  /** "other" = every method but GET and POST. */
  methods: { get: MethodAnswer; other: MethodAnswer };
  /** true: return null for paths the service does not own. */
  passUnknown: boolean;
  /** Matched with startsWith. */
  authPrefixes: { api: readonly string[]; wellKnown: readonly string[] };
  /** Which SDK entry serves `mcpPath`. */
  entry:
    | { kind: "transport"; json: true } // WebStandardStreamableHTTPServerTransport, enableJsonResponse
    | { kind: "handler"; legacy: "stateless" }; // createMcpHandler, SSE responses, also serves 2026-07-28 requests
  /** Bytes; over → bodies.tooLarge. null: no rootstock cap (the server's own cap is the only one). */
  bodyLimit: Readonly<Record<Caller["kind"], number | null>>;
  deadlineMs: number | null;
  unknownTool: "isError" | "protocolError";
  requireCaller: boolean;
  /** Base scopes for every OAuth caller. */
  oauthScopes: readonly string[];
  hostCheck:
    | false
    | {
        hosts: {
          list: readonly string[];
          whenEmpty: "allow-all" | "loopback-only";
          match: "hostname" | "exact";
          loopback: "union" | "none";
        };
        origins: {
          list: readonly string[];
          whenEmpty: "allow-all" | "same-as-hosts";
          absent: "allow";
        };
        refusal: "sdk-403" | "404-text";
        appliesTo: "mcp" | "all-but-public-auth";
      };
  delegated:
    | false
    | {
        clients: readonly string[];
        onBehalfOf: { header: string; shape: RegExp };
        turnId: { header: string; shape: RegExp };
      };
  /** null: socket address only. */
  clientIpHeader: string | null;
  /** Response bytes that differ per consumer. */
  bodies: {
    unauthorizedNoSub: "jsonrpc-401" | "empty-401";
    jwksFailure: "503-retry" | "500-empty" | "jsonrpc-500";
    notFound: "empty-no-store" | "text-not-found" | "json-not-found";
    internal: "empty-500" | "json-500" | "text-500";
    /** The SDK's text with the profile's limit. */
    tooLarge: "jsonrpc-413";
    parseError: "empty-400" | "jsonrpc-400";
  };
  /** serve.* event → the consumer's name; identity when absent. */
  logNames: Readonly<Record<string, string>>;
  shutdown: { drainMs: number; forceMs: number; poolEndTimeoutS: number; flushMs: number };
}

const ID = /^[a-z0-9][a-z0-9.-]*$/;

// Deliberately local: types.ts imports nothing (contract §1.3). The value
// printing matches internal/slice.ts's q(); isPlainRecord is stricter than its
// isRecord (plain objects only, so a Map or class instance is refused).
function configError(fn: string, detail: string, value: unknown): Error {
  let got: string;
  if (typeof value === "number" && !Number.isFinite(value)) got = String(value);
  else {
    try {
      got = JSON.stringify(value);
    } catch {
      got = typeof value === "bigint" ? `${value}n` : "an unserializable value";
    }
  }
  return Object.assign(new Error(`rootstock serve: ${fn}(): ${detail} — got ${got}`), {
    code: "ERR_ROOTSTOCK_SERVE_CONFIG",
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const isScope = (s: unknown): s is string => typeof s === "string" && s.length > 0;

/**
 * A frozen copy of `t`. Refuses (ERR_ROOTSTOCK_SERVE_CONFIG) an id outside
 * `/^[a-z0-9][a-z0-9.-]*$/`, a tool without a scope, an `implies` entry that
 * does not list its own scope, and an implied scope that is not itself a key
 * of `implies`. Every key, `__proto__` included, is kept as an own data
 * property (Object.fromEntries), and the checks run against the copy returned.
 */
export function defineToolScopes(t: ToolScopes): ToolScopes {
  const fail = (detail: string, value: unknown) => configError("defineToolScopes", detail, value);
  if (!isPlainRecord(t)) throw fail("the registry must be an object", t);
  if (typeof t.id !== "string" || !ID.test(t.id)) throw fail(`id must match ${ID}`, t.id);
  if (!isPlainRecord(t.tools)) throw fail("tools must be an object", t.tools);
  if (!isPlainRecord(t.implies)) throw fail("implies must be an object", t.implies);
  const tools: Record<string, string> = Object.fromEntries(
    Object.entries(t.tools).map(([tool, scope]) => {
      if (!isScope(scope))
        throw fail(`tools[${JSON.stringify(tool)}] must be a non-empty string`, scope);
      return [tool, scope];
    }),
  );
  const implies: Record<string, readonly string[]> = Object.fromEntries(
    Object.entries(t.implies).map(([scope, granted]) => {
      if (!Array.isArray(granted) || !granted.every(isScope)) {
        throw fail(
          `implies[${JSON.stringify(scope)}] must be an array of non-empty strings`,
          granted,
        );
      }
      return [scope, Object.freeze([...granted])];
    }),
  );
  for (const [scope, granted] of Object.entries(implies)) {
    if (!granted.includes(scope)) {
      throw fail(
        `implies[${JSON.stringify(scope)}] must include ${JSON.stringify(scope)} itself`,
        granted,
      );
    }
    for (const g of granted) {
      if (!Object.hasOwn(implies, g)) {
        throw fail(
          `implies[${JSON.stringify(scope)}] grants ${JSON.stringify(g)}, which implies does not declare`,
          Object.keys(implies),
        );
      }
    }
  }
  // A tool's scope must be declared, or a typo leaves the tool callable by nobody, silently.
  for (const [tool, scope] of Object.entries(tools)) {
    if (!Object.hasOwn(implies, scope)) {
      throw fail(
        `tools[${JSON.stringify(tool)}] needs ${JSON.stringify(scope)}, which implies does not declare`,
        Object.keys(implies),
      );
    }
  }
  return Object.freeze({
    id: t.id,
    tools: Object.freeze(tools),
    implies: Object.freeze(implies),
  });
}

/**
 * Every scope in `scopes` plus everything it grants, followed transitively.
 * A scope `implies` does not declare is kept as given and grants nothing more.
 */
export function expandScopes(reg: ToolScopes, scopes: Iterable<string>): ReadonlySet<string> {
  if (
    typeof scopes === "string" ||
    typeof (scopes as { [Symbol.iterator]?: unknown })?.[Symbol.iterator] !== "function"
  ) {
    throw configError(
      "expandScopes",
      "scopes must be an iterable of strings, not one string",
      scopes,
    );
  }
  const out = new Set<string>();
  const pending = [...scopes];
  for (let s = pending.pop(); s !== undefined; s = pending.pop()) {
    if (out.has(s)) continue;
    out.add(s);
    if (Object.hasOwn(reg.implies, s)) pending.push(...(reg.implies[s] ?? []));
  }
  return out;
}

/** True when `tool` is in the registry (own key) and the caller holds its scope. */
export function canCallTool(reg: ToolScopes, caller: Caller, tool: string): boolean {
  if (!Object.hasOwn(reg.tools, tool)) return false;
  const scope = reg.tools[tool];
  return scope !== undefined && caller.scopes.has(scope);
}
