// createMcpService: the request pipeline of contract §3.2, in order, and the
// shutdown of §3.7. Every answer a profile can vary is a profile value; the
// bytes that mimic the SDK are built in bodies.ts and checked against it.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AuthInfo,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  McpServer,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as bodies from "./bodies.ts";
import {
  installSeamsWith,
  LOCAL_CALLER,
  type RequestContext,
  type ServeHooks,
  seamRuntime,
} from "./call.ts";
import { className, configError, isPositiveInteger } from "./errors.ts";
import { sourceKeyFor } from "./hardening.ts";
import { type HostGuard, hostGuard } from "./host-check.ts";
import { createRateLimiter, type Limits, type RateLimiter, rateLimitedLog } from "./limits.ts";
import {
  type Caller,
  type Clock,
  expandScopes,
  type LogEvent,
  type MethodAnswer,
  type RandomId,
  type ServeProfile,
  type StoppableServer,
  type Timers,
  type ToolScopes,
  type UsageWiring,
} from "./types.ts";

/**
 * The part of `serve/auth`'s AuthLayer that serve uses, declared here
 * because serve may not import serve/auth (contract §3.1).
 */
export interface AuthLayer {
  /** Better Auth's routes, with the layer's own headers and 429 log. */
  handle(req: Request): Promise<Response>;
  page(path: "/login" | "/consent", url: URL): Response;
  asset(path: string): Response | null;
  /** requireMcpAuth: its own 401/403 challenge, or `next` with the verified claims. Throws on a JWKS failure. */
  verify(
    req: Request,
    next: (req: Request, claims: Readonly<Record<string, unknown>>) => Promise<Response>,
  ): Promise<Response>;
  assertStoreReady(): Promise<void>;
  wrapNodeAuthResponse(
    res: {
      setHeader(n: string, v: string): void;
      on(e: "finish", f: () => void): void;
      statusCode: number;
    },
    path: string,
    client: string,
  ): void;
  /** Resolves when no send the layer scheduled is pending. */
  idle(): Promise<void>;
}

export interface McpServiceOptions {
  profile: ServeProfile;
  serverInfo: { name: string; version: string };
  registerTools(server: McpServer, ctx: RequestContext): void | Promise<void>;
  auth?: AuthLayer;
  /** Static tokens: a Caller stops auth here, a Response is returned, undefined falls through. */
  credentials?: (req: Request) => Caller | Response | undefined;
  /** Which credentials this request may present; `bearer: false` is a public (OAuth-only) face. */
  acceptCredentials?: (
    req: Request,
    info: { remoteAddress?: string },
  ) => { bearer: boolean; oauth: boolean };
  /** Scopes added to `oauthScopes`; a throw falls back to `oauthScopes`. */
  resolveScopes?: (claims: Readonly<Record<string, unknown>>) => Promise<readonly string[]>;
  toolScopes: ToolScopes;
  limits: Limits;
  usage: UsageWiring | null;
  hooks: ServeHooks;
  clock: Clock;
  timers: Timers;
  randomId: RandomId;
  log: LogEvent;
}

export interface McpService {
  /** null: a path the service does not own (`passUnknown`). */
  handle(req: Request, info: { remoteAddress?: string }): Promise<Response | null>;
  shutdown(o: {
    signal: string;
    server: StoppableServer;
    endPool?: (timeoutS: number) => Promise<unknown>;
  }): Promise<{ drained: boolean; flushed: boolean; poolClosed: boolean }>;
}

const POLL_MS = 50;
const UA_MAX = 200;
const MCP_PROTOCOL_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** `requireMcpAuth`'s JWKS failure texts (@better-auth/core oauth2/verify). */
export function isJwksFailure(err: unknown): boolean {
  try {
    return (
      err instanceof Error &&
      (err.message.startsWith("Jwks failed: ") || err.message === "No jwks found")
    );
  } catch {
    return false;
  }
}

function clientOf(headers: Headers): RequestContext["client"] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const ua = (headers.get("user-agent") ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const protocol = headers.get("mcp-protocol-version");
  return {
    ua: ua === "" ? null : ua.slice(0, UA_MAX),
    mcpProtocol: protocol && MCP_PROTOCOL_SHAPE.test(protocol) ? protocol : null,
  };
}

/** The JSON-RPC message of an SDK 4xx, read from a clone; never throws. */
async function rejectionOf(res: Response): Promise<string | undefined> {
  if (res.status < 400 || res.status >= 500) return undefined;
  try {
    const body = (await res.clone().json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    return typeof message === "string" ? message.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function validate(o: McpServiceOptions): void {
  const p = o.profile;
  if (typeof p?.mcpPath !== "string" || !p.mcpPath.startsWith("/")) {
    throw configError("createMcpService", "profile.mcpPath must start with /", p?.mcpPath);
  }
  for (const [kind, limit] of Object.entries(p.bodyLimit)) {
    if (limit !== null && !isPositiveInteger(limit)) {
      throw configError(
        "createMcpService",
        `profile.bodyLimit.${kind} must be null or an integer > 0`,
        limit,
      );
    }
  }
  if (p.deadlineMs !== null && !isPositiveInteger(p.deadlineMs)) {
    throw configError(
      "createMcpService",
      "profile.deadlineMs must be null or an integer > 0",
      p.deadlineMs,
    );
  }
  for (const [k, v] of Object.entries(p.shutdown)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw configError(
        "createMcpService",
        `profile.shutdown.${k} must be a finite number >= 0`,
        v,
      );
    }
  }
  if (
    p.hostCheck !== false &&
    p.hostCheck.appliesTo === "all-but-public-auth" &&
    o.acceptCredentials === undefined
  ) {
    throw configError(
      "createMcpService",
      'hostCheck.appliesTo "all-but-public-auth" needs acceptCredentials, which decides the face',
    );
  }
}

export function createMcpService(o: McpServiceOptions): McpService {
  validate(o);
  const { profile, clock, timers, toolScopes, hooks } = o;
  const log: LogEvent = (event, fields) =>
    o.log(
      Object.hasOwn(profile.logNames, event) ? (profile.logNames[event] ?? event) : event,
      fields,
    );
  const limiter = (b: Limits["refusal"]): RateLimiter | null =>
    b === null ? null : createRateLimiter({ ...b, clock });
  const refusal = limiter(o.limits.refusal);
  const serving = limiter(o.limits.serving);
  const rateLimited = rateLimitedLog(log, clock, o.limits.logIntervalMs);
  // Built now so a limits tool toolScopes lacks is refused at build.
  seamRuntime(o.limits, toolScopes, clock, log);
  const guard: HostGuard | null = profile.hostCheck === false ? null : hostGuard(profile.hostCheck);
  const allScopes = expandScopes(toolScopes, Object.keys(toolScopes.implies));
  const entryKind = profile.entry.kind;

  /** The per-request state the handler entry's factory reads. */
  interface Exchange {
    ctx: RequestContext;
    timedOut: () => boolean;
  }
  const exchange = new AsyncLocalStorage<Exchange>();

  const buildServer = async (x: Exchange): Promise<McpServer> => {
    const server = new McpServer(o.serverInfo);
    installSeamsWith(
      server,
      {
        profile,
        caller: x.ctx.caller,
        toolScopes,
        limits: o.limits,
        usage: o.usage,
        ctx: x.ctx,
        hooks,
        clock,
        log,
      },
      { timedOut: x.timedOut },
    );
    await o.registerTools(server, x.ctx);
    return server;
  };

  const limitsList = Object.values(profile.bodyLimit).filter((v): v is number => v !== null);
  const handler =
    profile.entry.kind === "handler"
      ? createMcpHandler(
          async () => {
            const x = exchange.getStore();
            if (x === undefined)
              throw new Error("rootstock serve: the MCP handler ran outside a request");
            return buildServer(x);
          },
          {
            legacy: "stateless",
            ...(limitsList.length > 0 ? { maxRequestBodySize: Math.max(...limitsList) } : {}),
          },
        )
      : null;

  async function runEntry(
    req: Request,
    x: Exchange,
    parsedBody: unknown,
    authInfo: AuthInfo,
  ): Promise<Response> {
    const opts = { ...(parsedBody === undefined ? {} : { parsedBody }), authInfo };
    if (handler !== null) return exchange.run(x, () => handler.fetch(req, opts));
    let server: McpServer | undefined;
    try {
      server = await buildServer(x);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return await transport.handleRequest(req, opts);
    } finally {
      try {
        server?.close().catch(() => {});
      } catch {
        // A close failure never eats the response.
      }
    }
  }

  const refused = (method: string, sourceKey: string): Response | undefined => {
    if (refusal === null || refusal.allow(sourceKey)) return undefined;
    rateLimited("refusal", { method, sourceKey });
    return bodies.tooManyRequests();
  };

  const authRequest = async (
    req: Request,
    sourceKey: string,
    pathname: string,
    auth: AuthLayer,
  ) => {
    const res = await auth.handle(req);
    log("serve.auth_request", { method: req.method, sourceKey, pathname, status: res.status });
    return res;
  };

  /** Step 3: the auth routes the service owns, or undefined. */
  async function authRoute(
    req: Request,
    url: URL,
    sourceKey: string,
  ): Promise<Response | undefined> {
    const auth = o.auth;
    if (auth === undefined) return undefined;
    const { pathname } = url;
    if (profile.authPrefixes.wellKnown.some((p) => pathname.startsWith(p))) {
      return authRequest(req, sourceKey, pathname, auth);
    }
    const api = profile.authPrefixes.api.find((p) => pathname.startsWith(p));
    if (api !== undefined) {
      // The JWKS route is unmetered (F2): the server fetches its own JWKS.
      const jwks = pathname === `${api.replace(/\/$/, "")}/jwks`;
      return (
        (jwks ? undefined : refused(req.method, sourceKey)) ??
        authRequest(req, sourceKey, pathname, auth)
      );
    }
    if (req.method !== "GET") return undefined;
    if (pathname === "/login" || pathname === "/consent") {
      return refused(req.method, sourceKey) ?? auth.page(pathname, url);
    }
    return auth.asset(pathname) ?? undefined;
  }

  function delegatedOf(req: Request, caller: Caller): RequestContext["delegated"] {
    const d = profile.delegated;
    if (d === false) return { onBehalfOf: null, turnId: null };
    const read = (spec: { header: string; shape: RegExp }): string | null => {
      const value = req.headers.get(spec.header);
      if (value === null) return null;
      const reason = !d.clients.includes(caller.name)
        ? "not-delegating-client"
        : !spec.shape.test(value)
          ? "malformed"
          : null;
      if (reason === null) return value;
      log("serve.delegated_header_ignored", { caller: caller.name, header: spec.header, reason });
      return null;
    };
    return { onBehalfOf: read(d.onBehalfOf), turnId: read(d.turnId) };
  }

  /** Step 5 and the auth half of step 1 for a non-POST. */
  async function mcp(
    req: Request,
    url: URL,
    info: { remoteAddress?: string },
    sourceKey: string,
    publicFace: boolean,
  ): Promise<Response> {
    const method = req.method;
    const started = clock.monotonic();
    const answer: MethodAnswer | null =
      method === "POST" ? null : method === "GET" ? profile.methods.get : profile.methods.other;
    let callerName: string | undefined;
    // Set once a serve.request (or request_failed) line for this exchange is written.
    let loggedByEntry = false;
    const logRequest = async (res: Response, extra: Readonly<Record<string, unknown>> = {}) => {
      const rejection = await rejectionOf(res);
      log("serve.request", {
        method,
        sourceKey,
        ...(callerName === undefined ? {} : { caller: callerName }),
        status: res.status,
        ms: Math.round(clock.monotonic() - started),
        ...extra,
        ...(rejection === undefined ? {} : { rejection }),
      });
    };
    if (answer === "405-first") {
      const res = bodies.methodNotAllowed();
      await logRequest(res);
      return res;
    }
    const res = await authenticated();
    // rev 3.1: every non-POST exit logs serve.request.
    if (answer !== null && !loggedByEntry) await logRequest(res);
    return res;

    async function authenticated(): Promise<Response> {
      // 5.1
      if (guard !== null && profile.hostCheck !== false) {
        const applies = profile.hostCheck.appliesTo === "mcp" || publicFace;
        const refusedHost = applies ? guard(req) : undefined;
        if (refusedHost) return refusedHost;
      }
      // 5.2
      if (refusal !== null && !refusal.peek(sourceKey)) {
        rateLimited("refusal", { method, sourceKey });
        return bodies.tooManyRequests();
      }
      // 5.3
      const accepts = o.acceptCredentials?.(req, info) ?? { bearer: true, oauth: true };
      if (o.credentials !== undefined && accepts.bearer) {
        const c = o.credentials(req);
        if (c instanceof Response) return c;
        if (c !== undefined) return proceed(req, c);
      }
      if (o.auth !== undefined && accepts.oauth) return viaOAuth(o.auth);
      if (o.credentials !== undefined || o.auth !== undefined) {
        refusal?.allow(sourceKey);
        log("serve.unauthorized", { method, sourceKey, status: 401 });
        return bodies.bearerUnauthorized();
      }
      // 5.6: nobody to authenticate against.
      return proceed(
        req,
        profile.requireCaller
          ? { name: "none", kind: "none", scopes: new Set() }
          : LOCAL_CALLER(allScopes),
      );
    }

    // 5.4–5.6
    async function viaOAuth(auth: AuthLayer): Promise<Response> {
      let res: Response;
      try {
        res = await auth.verify(req, async (verified, claims) => {
          const sub = claims.sub;
          if (typeof sub !== "string" || sub.length === 0) {
            return bodies.unauthorizedNoSub(profile.bodies.unauthorizedNoSub);
          }
          let extra: readonly string[] = [];
          if (o.resolveScopes !== undefined) {
            try {
              extra = await o.resolveScopes(claims);
            } catch (err) {
              log("serve.scope_resolve_failed", { caller: sub, errorClass: className(err) });
            }
          }
          const scopes = expandScopes(toolScopes, [...profile.oauthScopes, ...extra]);
          return proceed(verified, { name: sub, kind: "oauth", scopes, claims });
        });
      } catch (err) {
        refusal?.allow(sourceKey);
        const jwks = isJwksFailure(err);
        log("serve.auth_threw", {
          method,
          sourceKey,
          errorClass: className(err),
          ...(jwks ? { jwks: true } : {}),
          error: err,
        });
        return jwks
          ? bodies.jwksFailure(profile.bodies.jwksFailure)
          : bodies.internal(profile.bodies.internal);
      }
      if (res.status === 401 || res.status === 403) {
        refusal?.allow(sourceKey);
        log("serve.unauthorized", { method, sourceKey, status: res.status });
      }
      return res;
    }

    // 5.7 onward; never throws.
    async function proceed(r: Request, caller: Caller): Promise<Response> {
      callerName = caller.name;
      if (serving !== null && !serving.allow(caller.name)) {
        rateLimited("serving", { method, sourceKey, caller: caller.name });
        return bodies.tooManyRequests();
      }
      const ctx: RequestContext = Object.freeze({
        caller,
        requestId: o.randomId(),
        request: { headers: r.headers, url },
        delegated: delegatedOf(r, caller),
        client: clientOf(r.headers),
      });
      const fields = (): Readonly<Record<string, unknown>> => {
        try {
          return hooks.requestFields?.(ctx) ?? {};
        } catch {
          return {};
        }
      };
      const run = () => afterAuth(r, ctx, fields);
      try {
        return await (hooks.aroundRequest ? hooks.aroundRequest(r, run) : run());
      } catch (err) {
        log("serve.request_failed", {
          method,
          sourceKey,
          caller: caller.name,
          status: 500,
          ms: Math.round(clock.monotonic() - started),
          reason: "threw",
          errorClass: className(err),
          error: err,
        });
        loggedByEntry = true;
        return bodies.internal(profile.bodies.internal);
      }
    }

    async function afterAuth(
      r: Request,
      ctx: RequestContext,
      fields: () => Readonly<Record<string, unknown>>,
    ): Promise<Response> {
      const caller = ctx.caller;
      const authInfo: AuthInfo = { token: "", clientId: caller.name, scopes: [...caller.scopes] };
      let timedOut = false;
      const x: Exchange = { ctx, timedOut: () => timedOut };
      if (answer === "auth-then-405") return bodies.methodNotAllowed();
      if (answer === "auth-then-entry") {
        const res = await runEntry(r, x, undefined, authInfo);
        await logRequest(res, fields());
        loggedByEntry = true;
        return res;
      }
      // 5.8: the entry's own pre-body checks, in its order and with its bytes.
      const sdkRefusal = async (res: Response) => {
        await logRequest(res, fields());
        loggedByEntry = true;
        return res;
      };
      const acceptOk = () => {
        const accept = r.headers.get("accept");
        return (
          accept?.includes("application/json") === true && accept.includes("text/event-stream")
        );
      };
      if (entryKind === "transport" && !acceptOk()) return sdkRefusal(bodies.notAcceptable());
      if (!isJsonContentType(r.headers.get("content-type"))) {
        return sdkRefusal(bodies.unsupportedMediaType(entryKind));
      }
      const limit = profile.bodyLimit[caller.kind];
      let text: string | undefined;
      try {
        const read = await readRequestBody(r, limit ?? Number.POSITIVE_INFINITY);
        if (read.tooLarge) return sdkRefusal(bodies.tooLarge(entryKind, limit ?? 0));
        text = read.text;
      } catch {
        text = undefined;
      }
      let parsed: unknown;
      let parseOk = false;
      if (text !== undefined && text.length > 0) {
        try {
          parsed = JSON.parse(text);
          parseOk = true;
        } catch {
          parseOk = false;
        }
      }
      // The handler entry routes an unparsable or 2025-era body to its legacy
      // leg, whose transport checks Accept before anything else.
      if (
        entryKind === "handler" &&
        !acceptOk() &&
        (!parseOk || (await isLegacyRequest(r, parsed)))
      ) {
        return sdkRefusal(bodies.notAcceptable());
      }
      if (!parseOk) {
        log("serve.bad_request", { method, sourceKey, caller: caller.name, status: 400 });
        return bodies.parseError(profile.bodies.parseError);
      }
      if (Array.isArray(parsed) && serving !== null) {
        for (let i = 1; i < parsed.length; i++) {
          if (!serving.allow(caller.name)) {
            rateLimited("serving", {
              method,
              sourceKey,
              caller: caller.name,
              batch: parsed.length,
            });
            return bodies.tooManyRequests();
          }
        }
      }
      // 5.9–5.10
      const dispatch = runEntry(r, x, parsed, authInfo);
      let res: Response;
      if (profile.deadlineMs === null) res = await dispatch;
      else {
        let cancel: (() => void) | undefined;
        const deadline = profile.deadlineMs;
        const expired = new Promise<"deadline">((resolve) => {
          cancel = timers.set(deadline, () => resolve("deadline"));
        });
        // The losing dispatch runs on; its rejection stays handled.
        dispatch.catch(() => {});
        try {
          const won = await Promise.race([dispatch, expired]);
          if (won === "deadline") {
            timedOut = true;
            log("serve.request_failed", {
              method,
              sourceKey,
              caller: caller.name,
              status: 500,
              ms: Math.round(clock.monotonic() - started),
              ...fields(),
              reason: "deadline",
            });
            loggedByEntry = true;
            return bodies.internal(profile.bodies.internal);
          }
          res = won;
        } finally {
          cancel?.();
        }
      }
      // 5.11
      await logRequest(res, fields());
      loggedByEntry = true;
      return res;
    }
  }

  const service: McpService = {
    async handle(req, info) {
      let sourceKey: string | undefined;
      try {
        sourceKey = sourceKeyFor(req, info, profile.clientIpHeader);
        const url = new URL(req.url);
        const hc = profile.hostCheck;
        const publicFace =
          o.acceptCredentials !== undefined && o.acceptCredentials(req, info).bearer === false;
        const early405 =
          url.pathname === profile.mcpPath &&
          req.method !== "POST" &&
          (req.method === "GET" ? profile.methods.get : profile.methods.other) === "405-first";
        // 2: the private face checks Host/Origin before anything else.
        if (
          !early405 &&
          guard !== null &&
          hc !== false &&
          hc.appliesTo === "all-but-public-auth" &&
          !publicFace
        ) {
          const r = guard(req);
          if (r) return r;
        }
        // 1 and 5
        if (url.pathname === profile.mcpPath)
          return await mcp(req, url, info, sourceKey, publicFace);
        // 3
        const auth = await authRoute(req, url, sourceKey);
        if (auth !== undefined) return auth;
        // 4
        if (profile.passUnknown) return null;
        return refused(req.method, sourceKey) ?? bodies.notFound(profile.bodies.notFound);
      } catch (err) {
        try {
          log("serve.uncaught", {
            method: req.method,
            ...(sourceKey === undefined ? {} : { sourceKey }),
            errorClass: className(err),
            error: err,
          });
        } catch {
          // The 500 is the point.
        }
        return bodies.internal(profile.bodies.internal);
      }
    },

    async shutdown({ signal, server, endPool }) {
      const s = profile.shutdown;
      const sleep = (ms: number) => new Promise<void>((resolve) => timers.set(ms, resolve));
      const bounded = async (work: () => Promise<unknown>, ms: number): Promise<boolean> => {
        try {
          return await Promise.race([work().then(() => true), sleep(ms).then(() => false)]);
        } catch {
          return false;
        }
      };
      log("serve.stopping", { signal });
      let drained = false;
      try {
        void Promise.resolve(server.stop()).catch(() => {});
        const until = clock.monotonic() + s.drainMs;
        while (server.pending() > 0 && clock.monotonic() < until) await sleep(POLL_MS);
        drained = server.pending() === 0;
      } catch {
        // drained stays false.
      }
      await bounded(async () => server.stop(true), s.forceMs);
      if (handler !== null) await bounded(() => handler.close(), s.forceMs);
      const flushed = await bounded(
        () => Promise.all([...(o.usage?.sinks ?? []).map((sink) => sink.idle?.()), o.auth?.idle()]),
        s.flushMs,
      );
      let poolClosed = false;
      let poolReason = "none";
      let poolMs = 0;
      if (endPool !== undefined) {
        const at = clock.monotonic();
        try {
          await endPool(s.poolEndTimeoutS);
          poolMs = Math.round(clock.monotonic() - at);
          poolClosed = poolMs < s.poolEndTimeoutS * 1000;
          poolReason = poolClosed ? "clean" : "timeout";
        } catch {
          poolReason = "threw";
        }
      }
      log("serve.stopped", { signal, drained, flushed, poolClosed, poolReason, poolMs });
      return { drained, flushed, poolClosed };
    },
  };
  return Object.freeze(service);
}
