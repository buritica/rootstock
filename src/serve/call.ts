// The two seams on an McpServer and the per-call handle (contract §3.3).
//
// Registration seam: `server.registerTool` is overridden, so every tool runs
// `hooks.onRegister`, is wrapped (scope guard, per-tool bucket, concurrency
// group), and is removed at once when the caller may not call it.
//
// Call seam: `server.server.setRequestHandler` is overridden before the first
// `registerTool`, which is when McpServer installs its `tools/call` handler
// through that public method. The wrapper opens the call's handle in
// AsyncLocalStorage, charges the turn budget, runs `hooks.aroundCall` and the
// SDK handler, classifies a refusal the SDK made before any handler ran, and
// hands one CallRecord to every sink.

import { AsyncLocalStorage } from "node:async_hooks";
import { type McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { isRecord, safeHook } from "../internal/slice.ts";
import { className, configError, safeLog } from "./errors.ts";
import {
  type BucketLimits,
  createConcurrencyLimiter,
  createRateLimiter,
  createTurnBudget,
  exhaustedResult,
  type Limits,
  type RateLimiter,
  rateLimitedLog,
  type TurnBudget,
  type TurnBudgetLimits,
  type TurnCharge,
} from "./limits.ts";
import {
  type Caller,
  type CallRecord,
  type CallStage,
  type Clock,
  canCallTool,
  type LogEvent,
  type ServeProfile,
  type ToolScopes,
  type Usage,
  type UsageWiring,
} from "./types.ts";

export interface RequestContext {
  readonly caller: Caller;
  readonly requestId: string;
  readonly request: { headers: Headers; url: URL };
  readonly delegated: { onBehalfOf: string | null; turnId: string | null };
  readonly client: { ua: string | null; mcpProtocol: string | null };
}

export interface CallHandle {
  readonly tool: string;
  readonly ctx: RequestContext;
  readonly turnCharge: TurnCharge | undefined;
  setArgs(a: Readonly<Record<string, unknown>>): void;
  /** Records the class (and the message, for sinks that read it) of an error the handler caught. */
  fail(err: unknown): void;
  setResultIds(ids: unknown): void;
  setExtra(x: Readonly<Record<string, unknown>>): void;
  /** Kept only when the wiring keeps output. */
  setOutputText(s: string): void;
  phase(name: string, ms: number): void;
  /** Adds to the call's tokens and the spend cache now; the spend write is queued. */
  meter(u: Usage): void;
  /** Resolves at once when there is no spend ceiling. */
  assertWithinSpend(): Promise<void>;
}

export interface ServeHooks {
  onRegister?: (name: string, rest: unknown[]) => void;
  aroundCall?: <T>(call: CallHandle, next: () => Promise<T>) => Promise<T>;
  aroundRequest?: <T>(req: Request, next: () => Promise<T>) => Promise<T>;
  requestFields?: (ctx: RequestContext) => Readonly<Record<string, unknown>>;
  classifyError?: (err: unknown) => string | undefined;
}

export interface InstallSeamsOptions {
  profile: Pick<ServeProfile, "unknownTool" | "toolThrow">;
  caller: Caller;
  toolScopes: ToolScopes;
  /** Bucket and group state lives with this object: pass the same one to every server that shares limits. */
  limits: Limits | null;
  usage: UsageWiring | null;
  ctx: RequestContext;
  hooks: ServeHooks;
  clock: Clock;
  log: LogEvent;
}

/** A caller with `scopes`, named "local", kind "local" (stdio and in-process use). */
export const LOCAL_CALLER = (scopes: ReadonlySet<string>): Caller =>
  Object.freeze({ name: "local", kind: "local", scopes });

/** Empty headers, no delegation, no client details. */
export function localRequestContext(caller: Caller): RequestContext {
  return Object.freeze({
    caller,
    requestId: "local",
    request: { headers: new Headers(), url: new URL("stdio://local/") },
    delegated: { onBehalfOf: null, turnId: null },
    client: { ua: null, mcpProtocol: null },
  });
}

// ---------------------------------------------------------------- the handle

interface CallState {
  readonly tool: string;
  readonly ctx: RequestContext;
  turnCharge: TurnCharge | undefined;
  /** Set by the tool wrapper the moment a handler is entered. */
  ran: boolean;
  /** rootstock refused inside the wrapper (scope guard, bucket, group). */
  refused: string | undefined;
  thrown: { err: unknown } | undefined;
  failed: { err: unknown } | undefined;
  args: Readonly<Record<string, unknown>> | undefined;
  resultIds: unknown;
  extra: Readonly<Record<string, unknown>> | undefined;
  outputText: string | undefined;
  phases: Record<string, number>;
  tokens: Record<string, { input: number; output: number }>;
  metered: boolean;
  estimated: boolean;
}

const calls = new AsyncLocalStorage<{ state: CallState; handle: CallHandle }>();

/** The handle of the tool call running now; throws ERR_ROOTSTOCK_SERVE_NO_CALL outside one. */
export function currentCall(): CallHandle {
  const store = calls.getStore();
  if (store === undefined) {
    throw Object.assign(
      new Error("rootstock serve: currentCall(): no tool call is running in this context"),
      { code: "ERR_ROOTSTOCK_SERVE_NO_CALL" },
    );
  }
  return store.handle;
}

function makeHandle(state: CallState, usage: UsageWiring | null, caller: Caller): CallHandle {
  let charger: ReturnType<NonNullable<UsageWiring["spend"]>["forCaller"]> | undefined;
  const spend = () => {
    if (usage?.spend == null) return undefined;
    charger ??= usage.spend.forCaller(caller.name);
    return charger;
  };
  return Object.freeze({
    tool: state.tool,
    ctx: state.ctx,
    get turnCharge() {
      return state.turnCharge;
    },
    setArgs(a: Readonly<Record<string, unknown>>) {
      state.args = a;
    },
    fail(err: unknown) {
      state.failed = { err };
    },
    setResultIds(ids: unknown) {
      state.resultIds = ids;
    },
    setExtra(x: Readonly<Record<string, unknown>>) {
      state.extra = x;
    },
    setOutputText(s: string) {
      if (usage?.keepOutput) state.outputText = s;
    },
    phase(name: string, ms: number) {
      state.phases[name] = (state.phases[name] ?? 0) + ms;
    },
    meter(u: Usage) {
      const t = state.tokens[u.model] ?? { input: 0, output: 0 };
      t.input += u.input;
      t.output += u.output;
      state.tokens[u.model] = t;
      state.metered = true;
      if (u.estimated) state.estimated = true;
      // The charger logs its own write failures; safeHook keeps the rejection
      // handled, and a charger that throws synchronously never fails the call.
      safeHook((x: Usage) => spend()?.record(x), u);
    },
    async assertWithinSpend() {
      await spend()?.assertWithin();
    },
  });
}

// ---------------------------------------------------------- shared runtime

/** A tool's concurrency group: the shared limiter and the group's busy text. */
interface ToolGroup {
  tryAcquire(k: string): (() => void) | undefined;
  busy: (t: string) => string;
}

interface Runtime {
  perTool: ReadonlyMap<string, RateLimiter>;
  groups: ReadonlyMap<string, ToolGroup>;
  turn: { budget: TurnBudget; limits: TurnBudgetLimits } | null;
  rateLimited: (bucket: string, fields: Readonly<Record<string, unknown>>) => void;
  /** True the first time a caller+turn is past its budget (the line is logged once). */
  firstExhaustion: (key: string) => boolean;
}

/** Per Limits object, one runtime per (toolScopes, clock, log) it was installed with. */
const runtimes = new WeakMap<
  Limits,
  { toolScopes: ToolScopes; clock: Clock; log: LogEvent; rt: Runtime }[]
>();
const NO_LIMITS: Runtime = {
  perTool: new Map(),
  groups: new Map(),
  turn: null,
  rateLimited: () => {},
  firstExhaustion: () => true,
};

/** Runtimes kept per Limits object; past this, the least recently used is rebuilt on next use. */
const RUNTIMES_PER_LIMITS = 8;

/**
 * The bucket, group and budget state for `limits`, built once per Limits
 * object and deps (so every per-request server handed the same `limits`,
 * `toolScopes`, `clock` and `log` shares it; other deps get their own state).
 * Refuses a tool that `toolScopes` does not declare.
 */
export function seamRuntime(
  limits: Limits | null,
  toolScopes: ToolScopes,
  clock: Clock,
  log: LogEvent,
): Runtime {
  if (limits === null) return NO_LIMITS;
  const installs = runtimes.get(limits) ?? [];
  runtimes.set(limits, installs);
  const at = installs.findIndex(
    (i) => i.toolScopes === toolScopes && i.clock === clock && i.log === log,
  );
  if (at >= 0) {
    // LRU: the hit moves to the most recently used end.
    const [hit] = installs.splice(at, 1);
    if (hit !== undefined) {
      installs.push(hit);
      return hit.rt;
    }
  }
  const declared = (where: string, tool: string) => {
    if (!Object.hasOwn(toolScopes.tools, tool)) {
      throw configError(
        "createMcpService",
        `${where} names ${JSON.stringify(tool)}, which toolScopes does not declare`,
        Object.keys(toolScopes.tools),
      );
    }
  };
  const perTool = new Map<string, RateLimiter>();
  for (const [tool, b] of Object.entries(limits.perTool) as [string, BucketLimits][]) {
    declared("limits.perTool", tool);
    perTool.set(tool, createRateLimiter({ ...b, clock }));
  }
  const groups = new Map<string, ToolGroup>();
  for (const [name, g] of Object.entries(limits.concurrency)) {
    if (typeof g?.busy !== "function") {
      throw configError("createMcpService", `limits.concurrency.${name}.busy must be a function`);
    }
    const limiter = createConcurrencyLimiter(g.max);
    for (const tool of g.tools) {
      declared(`limits.concurrency.${name}`, tool);
      if (groups.has(tool)) {
        throw configError(
          "createMcpService",
          `${JSON.stringify(tool)} is in two concurrency groups`,
        );
      }
      groups.set(tool, { tryAcquire: limiter.tryAcquire, busy: g.busy });
    }
  }
  let turn: Runtime["turn"] = null;
  if (limits.turnBudget !== null) {
    const t = limits.turnBudget;
    if (typeof t.exhausted !== "function") {
      throw configError("createMcpService", "limits.turnBudget.exhausted must be a function");
    }
    if (typeof t.warnAt !== "number" || !Number.isInteger(t.warnAt) || t.warnAt < 0) {
      throw configError(
        "createMcpService",
        "limits.turnBudget.warnAt must be an integer >= 0",
        t.warnAt,
      );
    }
    turn = { budget: createTurnBudget(t), limits: t };
  }
  const rt: Runtime = {
    perTool,
    groups,
    turn,
    rateLimited: rateLimitedLog(safeLog(log), clock, limits.logIntervalMs),
    firstExhaustion: onceEach(limits.turnBudget?.maxTurns ?? 1),
  };
  // A second runtime for one Limits object means its buckets start over for
  // these deps (a new toolScopes, clock or log); say so, it resets limits.
  if (installs.length > 0) {
    safeLog(log)("serve.seam_runtime_rebuilt", {
      reason: installs.length >= RUNTIMES_PER_LIMITS ? "evicted" : "new-deps",
      runtimes: Math.min(installs.length + 1, RUNTIMES_PER_LIMITS),
    });
  }
  installs.push({ toolScopes, clock, log, rt });
  if (installs.length > RUNTIMES_PER_LIMITS) installs.shift();
  return rt;
}

/** A key's first sighting is true, later ones false; remembers at most `max` keys (oldest dropped). */
function onceEach(max: number): (key: string) => boolean {
  const seen = new Set<string>();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > max) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };
}

// ------------------------------------------------------------------ seams

/** Refuses a `toolThrow` that is not one of its two values (a pre-0.13 profile has none). */
export function checkToolThrow(fn: string, value: unknown): void {
  if (value !== "message" && value !== "generic") {
    throw configError(fn, 'profile.toolThrow must be "message" or "generic"', value);
  }
}

/** rootstock's own refusals thrown from inside a handler (the spend ceiling) carry this mark. */
const CLIENT_FACING = Symbol.for("rootstock.clientFacing");
const clientFacing = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as Record<symbol, unknown>)[CLIENT_FACING] === true;

/** The labeled-error envelope: one JSON text block `{"error": text}`, `isError: true`. */
function labeledError(text: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: text }) }],
    isError: true as const,
  };
}

const INPUT_VALIDATION_PREFIX = "Input validation error:";

function firstText(result: unknown): string | undefined {
  try {
    const content = (result as { content?: unknown } | null | undefined)?.content;
    const first: unknown = Array.isArray(content) ? content[0] : undefined;
    const { type, text } = (first ?? {}) as { type?: unknown; text?: unknown };
    return type === "text" && typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The class of a refusal the SDK made before any handler, by its text. */
function rejectionClass(text: string, tool: string): "UnknownTool" | "RejectedBeforeHandler" {
  return text === `Tool ${tool} not found` ? "UnknownTool" : "RejectedBeforeHandler";
}

function errorMessage(err: unknown): string | null {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return null;
  }
}

/**
 * Installs both seams. Call it before the first `registerTool`: a server that
 * already has a `tools/call` handler throws ERR_ROOTSTOCK_SERVE_CONFIG.
 */
export function installSeams(server: McpServer, o: InstallSeamsOptions): void {
  // createMcpService checks the profile once in validate(); this is the other entry.
  checkToolThrow("installSeams", o.profile.toolThrow);
  installSeamsWith(server, o, { timedOut: () => false });
}

/** The generic answer to a throw out of rootstock's own seam: never its message. */
const seamFault = () => new ProtocolError(ProtocolErrorCode.InternalError, "Internal error");

/** installSeams plus the per-request deadline flag the service owns (internal). */
export function installSeamsWith(
  server: McpServer,
  o: InstallSeamsOptions,
  extra: {
    timedOut: () => boolean;
    /** Sees each tool call's promise as it starts (the service tracks calls past a deadline). */
    onCall?: (call: Promise<unknown>) => void;
  },
): void {
  const { caller, toolScopes, usage, ctx, hooks, clock } = o;
  // Read once per server: a later change to the profile cannot fall back to "message".
  const genericThrow = o.profile.toolThrow === "generic";
  try {
    server.server.assertCanSetRequestHandler("tools/call");
  } catch {
    throw configError(
      "installSeams",
      "the server already has tools (or a tools/call handler); install the seams before the first registerTool",
    );
  }
  const log = safeLog(o.log);
  const rt = seamRuntime(o.limits, toolScopes, clock, o.log);
  const sinks = usage?.sinks ?? [];

  const classOf = (err: unknown): string => {
    try {
      return usage === null ? className(err) : usage.errorClassOf(err, hooks.classifyError);
    } catch {
      return "unreadable error";
    }
  };

  // ---- registration seam
  const register = server.registerTool.bind(server) as (...a: unknown[]) => { remove(): void };
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    hooks.onRegister?.(name, rest);
    const handler = rest.at(-1);
    if (typeof handler === "function") {
      rest[rest.length - 1] = wrapTool(name, handler as (...a: unknown[]) => unknown);
    }
    const tool = register(name, ...rest);
    if (!canCallTool(toolScopes, caller, name)) tool.remove();
    else {
      for (const sink of sinks) {
        try {
          sink.onRegister?.(name);
        } catch (err) {
          log("usage.sink_failed", { tool: name, stage: "register", errorClass: className(err) });
        }
      }
    }
    return tool;
  }) as typeof server.registerTool;

  function wrapTool(name: string, handler: (...a: unknown[]) => unknown) {
    return async (...args: unknown[]): Promise<unknown> => {
      const state = calls.getStore()?.state;
      if (state) state.ran = true;
      const refuse = (errorClass: string) => {
        if (state) state.refused = errorClass;
      };
      if (!canCallTool(toolScopes, caller, name)) {
        refuse("ScopeDenied");
        return labeledError(`${name}: this token's scopes do not allow it`);
      }
      const bucket = rt.perTool.get(name);
      if (bucket && !bucket.allow(caller.name)) {
        refuse("RateLimited");
        rt.rateLimited(`tool:${name}`, { tool: name, caller: caller.name });
        throw new Error(`Rate limit exceeded for ${name} — try again shortly.`);
      }
      const group = rt.groups.get(name);
      const release = group?.tryAcquire(caller.name);
      if (group && release === undefined) {
        refuse("Busy");
        return labeledError(group.busy(name));
      }
      try {
        return await handler(...args);
      } catch (err) {
        if (state) state.thrown = { err };
        // F5: under "generic" an unlabeled throw answers the labeled error, so
        // its message never reaches the client; the record keeps class and
        // message from state.thrown. A ProtocolError is the author's answer.
        if (genericThrow && !(err instanceof ProtocolError) && !clientFacing(err)) {
          // With no sink the record is never built: log it, or nobody sees it.
          if (sinks.length === 0 || usage === null) {
            log("serve.tool_threw", {
              tool: name,
              errorClass: className(err),
              message: errorMessage(err),
            });
          }
          return labeledError(`${name} failed`);
        }
        throw err;
      } finally {
        release?.();
      }
    };
  }

  // ---- call seam
  const sdk = server.server;
  const setRequestHandler = sdk.setRequestHandler.bind(sdk) as (
    method: string,
    ...rest: unknown[]
  ) => unknown;
  sdk.setRequestHandler = ((method: string, ...rest: unknown[]) => {
    if (method !== "tools/call") return setRequestHandler(method, ...rest);
    const sdkHandler = rest[0] as (request: unknown, reqCtx: unknown) => Promise<unknown>;
    return setRequestHandler(method, (request: unknown, reqCtx: unknown) =>
      callTool(request, reqCtx, sdkHandler),
    );
  }) as typeof sdk.setRequestHandler;

  async function callTool(
    request: unknown,
    reqCtx: unknown,
    sdkHandler: (request: unknown, reqCtx: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const started = clock.monotonic();
    const params = (request as { params?: { name?: unknown; arguments?: unknown } }).params;
    const tool = typeof params?.name === "string" ? params.name : "";
    const rawArgs = isRecord(params?.arguments) ? params.arguments : undefined;
    const state: CallState = {
      tool,
      ctx,
      turnCharge: undefined,
      ran: false,
      refused: undefined,
      thrown: undefined,
      failed: undefined,
      args: undefined,
      resultIds: undefined,
      extra: undefined,
      outputText: undefined,
      phases: {},
      tokens: {},
      metered: false,
      estimated: false,
    };
    const handle = makeHandle(state, usage, caller);
    // The SDK handler's own throw (a ProtocolError it means the client to
    // see) passes through; anything else rootstock's seam throws, aroundCall
    // and the turn budget included, is recorded and answered generically.
    let sdkThrow: { err: unknown } | undefined;
    const run = async () => {
      try {
        return await sdkHandler(request, reqCtx);
      } catch (err) {
        sdkThrow = { err };
        throw err;
      }
    };
    const running = calls.run({ state, handle }, async () => {
      try {
        return await dispatch();
      } catch (err) {
        if (sdkThrow !== undefined && err === sdkThrow.err) throw err;
        state.thrown ??= { err };
        record(state.ran ? "handler" : "rejected", undefined);
        throw seamFault();
      }
    });
    safeHook(extra.onCall, running);
    return running;

    async function dispatch(): Promise<unknown> {
      const turnId = ctx.delegated.turnId;
      if (rt.turn && turnId !== null) {
        const charge = rt.turn.budget.forTurn(turnId)();
        state.turnCharge = charge;
        if (charge.exhausted) {
          // Once per caller and turn: a looping client would otherwise log every call.
          if (rt.firstExhaustion(`${caller.name}\u0000${turnId}`)) {
            log("serve.turn_budget_exhausted", {
              tool,
              used: charge.used,
              caller: caller.name,
              turnId,
            });
          }
          const text = JSON.stringify(exhaustedResult(charge, rt.turn.limits.exhausted));
          const result = { content: [{ type: "text", text }] };
          record("refused", result, "TurnBudgetExhausted");
          return result;
        }
      }
      let result: unknown;
      try {
        result = hooks.aroundCall ? await hooks.aroundCall(handle, run) : await run();
      } catch (err) {
        // Not the SDK's: the outer catch records it.
        if (sdkThrow === undefined || err !== sdkThrow.err) throw err;
        if (
          !state.ran &&
          err instanceof ProtocolError &&
          err.code === ProtocolErrorCode.InvalidParams
        ) {
          const errorClass = rejectionClass(err.message, tool);
          if (o.profile.unknownTool === "isError") {
            result = { isError: true, content: [{ type: "text", text: err.message }] };
            record("rejected", result, errorClass);
            return result;
          }
          record("rejected", undefined, errorClass);
          throw err;
        }
        state.thrown ??= { err };
        record(state.ran ? "handler" : "rejected", undefined);
        throw err;
      }
      if (state.refused !== undefined) {
        record("refused", result, state.refused);
      } else if (!state.ran) {
        const text = firstText(result) ?? "";
        const errorClass = text.startsWith(INPUT_VALIDATION_PREFIX)
          ? "InvalidParams"
          : rejectionClass(text, tool);
        record("rejected", result, errorClass);
      } else {
        record("handler", result);
      }
      return result;
    }

    // The row this call hands every sink; closes over the call's state.
    function record(stage: CallStage, result: unknown, fixedClass?: string): void {
      if (sinks.length === 0 || usage === null) return;
      let r: CallRecord;
      try {
        r = buildRecord(stage, result, fixedClass, usage);
      } catch (err) {
        log("usage.sink_failed", { tool: state.tool, stage: "build", errorClass: className(err) });
        return;
      }
      const failed = (err: unknown) =>
        log("usage.sink_failed", { tool: state.tool, stage: "record", errorClass: className(err) });
      for (const sink of sinks) {
        try {
          const out: unknown = sink.record(r);
          // An async sink's rejection is logged like a throw, never left
          // unhandled (safeHook attaches the handler and swallows its faults).
          safeHook((p: unknown) => {
            if (typeof (p as PromiseLike<unknown> | undefined)?.then === "function") {
              (p as PromiseLike<unknown>).then(undefined, failed);
            }
          }, out);
        } catch (err) {
          failed(err);
        }
      }
    }

    function buildRecord(
      stage: CallStage,
      result: unknown,
      fixedClass: string | undefined,
      wiring: UsageWiring,
    ): CallRecord {
      const isError = (result as { isError?: unknown } | undefined)?.isError === true;
      const err = state.failed ?? state.thrown;
      let ok = result !== undefined && !isError && err === undefined && fixedClass === undefined;
      let errorClass: string | null = fixedClass ?? (err !== undefined ? classOf(err.err) : null);
      const message = stage === "handler" && err !== undefined ? errorMessage(err.err) : null;
      let resultIds: unknown = state.resultIds ?? null;
      let outputText: string | null = wiring.keepOutput
        ? (state.outputText ?? (result === undefined ? null : (firstText(result) ?? null)))
        : null;
      if (extra.timedOut()) {
        ok = false;
        errorClass = "DeadlineExceeded";
        resultIds = null;
        outputText = null;
      }
      let costUsd: string | null = null;
      let costNote: string | null = null;
      if (state.metered) {
        try {
          ({ costUsd, costNote } = wiring.price(state.tokens, state.estimated));
        } catch (e) {
          costUsd = null;
          costNote = "price_failed";
          log("usage.price_failed", { tool: state.tool, errorClass: classOf(e) });
        }
      }
      const phases = Object.entries(state.phases);
      return {
        stage,
        caller: caller.name,
        onBehalfOf: ctx.delegated.onBehalfOf,
        turnId: ctx.delegated.turnId,
        tool: state.tool,
        args: wiring.keepArgs ? (state.args ?? rawArgs ?? {}) : {},
        durationMs: Math.round(clock.monotonic() - started),
        ok,
        errorClass,
        errorMessage: message,
        resultIds,
        phases:
          phases.length === 0
            ? null
            : Object.fromEntries(phases.map(([k, ms]) => [k, Math.round(ms)])),
        tokens: state.metered ? structuredClone(state.tokens) : null,
        costUsd,
        costNote,
        outputText,
        extra: state.extra ?? null,
        serverSha: wiring.serverSha,
        clientUa: ctx.client.ua,
        mcpProtocol: ctx.client.mcpProtocol,
      };
    }
  }
}
