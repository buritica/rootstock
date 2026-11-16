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
import { raceDeadline } from "./deadline.ts";
import {
  className,
  configError,
  isNonNegativeNumber,
  isPositiveInteger,
  safeLog,
} from "./errors.ts";
import { sourceKeyFor } from "./hardening.ts";
import { hostGuard } from "./host-check.ts";
import { type BucketLimiter, createBucketLimiter, type Limits } from "./limits.ts";
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
 * The part of `serve/auth`'s AuthLayer that serve calls, declared here
 * because serve may not import serve/auth (contract §3.1). Not exported under
 * that name; a test pins serve/auth's AuthLayer assignable to it.
 */
interface ServeAuthLayer {
  /** Better Auth's routes, with the layer's own headers and 429 log. */
  handle(req: Request): Promise<Response>;
  page(path: "/login" | "/consent", url: URL): Response;
  asset(path: string): Response | null;
  /** requireMcpAuth: its own 401/403 challenge, or `next` with the verified claims. Throws on a JWKS failure. */
  verify(
    req: Request,
    next: (req: Request, claims: Readonly<Record<string, unknown>>) => Promise<Response>,
  ): Promise<Response>;
  /** Resolves when no send the layer scheduled is pending. */
  idle(): Promise<void>;
}

export interface McpServiceOptions {
  profile: ServeProfile;
  serverInfo: { name: string; version: string };
  registerTools(server: McpServer, ctx: RequestContext): void | Promise<void>;
  auth?: ServeAuthLayer;
  /**
   * Static tokens: a Caller stops auth here, a Response is returned, undefined
   * falls through. A returned Response spends no refusal token, so answer a
   * wrong token with undefined (the bearer 401, charged) unless that is meant.
   */
  credentials?: (req: Request) => Caller | Response | undefined;
  /** Which credentials this request may present; `bearer: false` is a public (OAuth-only) face. */
  acceptCredentials?: (
    req: Request,
    info: { remoteAddress?: string },
  ) => { bearer: boolean; oauth: boolean };
  /** Scopes added to `oauthScopes`; a throw, or an answer that is not a string array, falls back to `oauthScopes`. */
  resolveScopes?: (claims: Readonly<Record<string, unknown>>) => Promise<readonly string[]>;
  toolScopes: ToolScopes;
  limits: Limits;
  usage: UsageWiring | null;
  hooks: ServeHooks;
  clock: Clock;
  timers: Timers;
  randomId: RandomId;
  /**
   * Every line the service writes. Failure lines carry the raw error as
   * `error: err` beside `errorClass`; the logger decides what of it to keep.
   * A throwing logger loses its line, never the request.
   */
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

type Faces = { bearer: boolean; oauth: boolean };
const ALL_FACES: Faces = Object.freeze({ bearer: true, oauth: true });

/** A body that is empty or that JSON.parse refused. */
const UNPARSABLE: unique symbol = Symbol("unparsable");

/** For `finish` on a body serve built itself: the rejection is known, so nothing is read. */
const NO_REJECTION = Object.freeze({ rejection: undefined });

/** `requireMcpAuth`'s JWKS failure texts (@better-auth/core oauth2/verify). */
function isJwksFailure(err: unknown): boolean {
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

/** The JSON-RPC message of a 4xx the SDK produced, read from a clone; never throws. */
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

function parseBody(text: string | undefined): unknown {
  if (text === undefined || text.length === 0) return UNPARSABLE;
  try {
    return JSON.parse(text);
  } catch {
    return UNPARSABLE;
  }
}

/** The streamable transport's Accept rule. */
function acceptOk(r: Request): boolean {
  const accept = r.headers.get("accept");
  return accept?.includes("application/json") === true && accept.includes("text/event-stream");
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
    if (!isNonNegativeNumber(v)) {
      throw configError(
        "createMcpService",
        `profile.shutdown.${k} must be a finite number >= 0`,
        v,
      );
    }
  }
  if (p.delegated !== false) {
    for (const which of ["onBehalfOf", "turnId"] as const) {
      const shape = p.delegated[which].shape;
      // A g or y flag makes test() stateful; an unanchored shape matches a substring.
      if (
        !(shape instanceof RegExp) ||
        /[gy]/.test(shape.flags) ||
        !shape.source.startsWith("^") ||
        !shape.source.endsWith("$")
      ) {
        throw configError(
          "createMcpService",
          `profile.delegated.${which}.shape must be anchored ^…$ with no g or y flag`,
          String(shape),
        );
      }
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

/** The per-request state the entry and the handler entry's factory read. */
interface Exchange {
  ctx: RequestContext;
  timedOut: () => boolean;
  /** The per-request server, once built; closed when the deadline expires. */
  server: McpServer | undefined;
  /** The first error the handler entry reported for this request (factory throws included). */
  failure: { err: unknown } | undefined;
}

/** A refusal the entry would make itself, with the JSON-RPC message its log line carries. */
interface EntryRefusal {
  res: Response;
  rejection: string;
}

/** What differs between the two entries, chosen once when the service is built. */
interface Entry {
  run(req: Request, x: Exchange, parsedBody: unknown, authInfo: AuthInfo): Promise<Response>;
  /** 5.8 before the body is read, in the entry's order. */
  preBody(r: Request): EntryRefusal | undefined;
  /** 5.8 after the parse (the handler's legacy leg checks Accept only now). */
  afterParse(r: Request, parsed: unknown): Promise<EntryRefusal | undefined>;
  tooLarge(limit: number): EntryRefusal;
  /** null: nothing to close at shutdown. */
  close: (() => Promise<unknown>) | null;
}

export function createMcpService(o: McpServiceOptions): McpService {
  validate(o);
  const { profile, clock, timers, toolScopes, hooks } = o;
  // Wrapped once: a throwing logger never changes an answer.
  const log: LogEvent = safeLog((event, fields) =>
    o.log(
      Object.hasOwn(profile.logNames, event) ? (profile.logNames[event] ?? event) : event,
      fields,
    ),
  );
  const limiter = (b: Limits["refusal"]): BucketLimiter | null =>
    b === null ? null : createBucketLimiter({ ...b, clock });
  const refusal = limiter(o.limits.refusal);
  const serving = limiter(o.limits.serving);
  // Built now so a limits tool toolScopes lacks is refused at build; its
  // throttled serve.rate_limited log is shared with the tool buckets.
  const { rateLimited } = seamRuntime(o.limits, toolScopes, clock, log);
  const allScopes = expandScopes(toolScopes, Object.keys(toolScopes.implies));
  const baseScopes = expandScopes(toolScopes, profile.oauthScopes);
  // The JWKS route is unmetered (F2): the server fetches its own JWKS.
  const jwksPaths = new Set(profile.authPrefixes.api.map((p) => `${p.replace(/\/$/, "")}/jwks`));
  const delegated =
    profile.delegated === false
      ? null
      : { ...profile.delegated, clients: new Set(profile.delegated.clients) };
  if (o.auth === undefined && o.credentials === undefined && !profile.requireCaller) {
    // Every HTTP caller is the local caller with every scope: right for a
    // loopback dev server, wrong anywhere else, so it is said once at boot.
    log("serve.unauthenticated_http", { mcpPath: profile.mcpPath });
  }
  const hc = profile.hostCheck;
  const host =
    hc === false
      ? null
      : { guard: hostGuard(hc), privateFirst: hc.appliesTo === "all-but-public-auth" };

  /**
   * The Host/Origin refusal at `step`, or undefined. Under
   * "all-but-public-auth" the private face is checked at step 2, before any
   * route; every other MCP request is checked at 5.1.
   */
  const hostRefusal = (req: Request, faces: Faces, step: 2 | 5): Response | undefined => {
    if (host === null) return undefined;
    const atStep2 = host.privateFirst && faces.bearer;
    return atStep2 === (step === 2) ? host.guard(req) : undefined;
  };

  const methodAnswer = (method: string): MethodAnswer | null =>
    method === "POST" ? null : method === "GET" ? profile.methods.get : profile.methods.other;

  const exchange = new AsyncLocalStorage<Exchange>();

  const buildServer = async (x: Exchange): Promise<McpServer> => {
    const server = new McpServer(o.serverInfo);
    x.server = server;
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

  const entry = buildEntry();

  function buildEntry(): Entry {
    const kind = profile.entry.kind;
    const notAcceptable = (): EntryRefusal => ({
      res: bodies.notAcceptable(),
      rejection: bodies.ACCEPT_TEXT,
    });
    const contentType = (r: Request): EntryRefusal | undefined =>
      isJsonContentType(r.headers.get("content-type"))
        ? undefined
        : { res: bodies.unsupportedMediaType(kind), rejection: bodies.CONTENT_TYPE_TEXT };
    const tooLarge = (limit: number): EntryRefusal => ({
      res: bodies.tooLarge(kind, limit),
      rejection: bodies.tooLargeText(limit),
    });
    const optsOf = (parsedBody: unknown, authInfo: AuthInfo) => ({
      ...(parsedBody === undefined ? {} : { parsedBody }),
      authInfo,
    });

    if (kind === "handler") {
      const limits = Object.values(profile.bodyLimit).filter((v): v is number => v !== null);
      // A factory throw, or any other fault the entry reports, is kept on the
      // exchange: the entry's own 500 then becomes serve's (bodies.internal
      // and serve.request_failed), on the legacy leg as on the modern one.
      const report = (err: unknown) => {
        const x = exchange.getStore();
        if (x !== undefined) x.failure ??= { err };
      };
      const handler = createMcpHandler(
        async () => {
          const x = exchange.getStore();
          if (x === undefined)
            throw new Error("rootstock serve: the MCP handler ran outside a request");
          try {
            return await buildServer(x);
          } catch (err) {
            report(err);
            throw err;
          }
        },
        {
          legacy: "stateless",
          onerror: report,
          ...(limits.length > 0 ? { maxRequestBodySize: Math.max(...limits) } : {}),
        },
      );
      return {
        async run(req, x, parsedBody, authInfo) {
          const res = await exchange.run(x, () => handler.fetch(req, optsOf(parsedBody, authInfo)));
          if (res.status === 500 && x.failure !== undefined) throw x.failure.err;
          return res;
        },
        preBody: contentType,
        // An unparsable or 2025-era body goes to the legacy leg, whose
        // transport checks Accept before anything else.
        afterParse: async (r, parsed) =>
          !acceptOk(r) && (parsed === UNPARSABLE || (await isLegacyRequest(r, parsed)))
            ? notAcceptable()
            : undefined,
        tooLarge,
        close: () => handler.close(),
      };
    }
    return {
      async run(req, x, parsedBody, authInfo) {
        let server: McpServer | undefined;
        try {
          server = await buildServer(x);
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          await server.connect(transport);
          return await transport.handleRequest(req, optsOf(parsedBody, authInfo));
        } finally {
          try {
            server?.close().catch(() => {});
          } catch {
            // A close failure never eats the response.
          }
        }
      },
      preBody: (r) => (acceptOk(r) ? contentType(r) : notAcceptable()),
      afterParse: async () => undefined,
      tooLarge,
      close: null,
    };
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
    auth: ServeAuthLayer,
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
    if (profile.authPrefixes.api.some((p) => pathname.startsWith(p))) {
      return (
        (jwksPaths.has(pathname) ? undefined : refused(req.method, sourceKey)) ??
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
    const d = delegated;
    if (d === null) return { onBehalfOf: null, turnId: null };
    const read = (spec: { header: string; shape: RegExp }): string | null => {
      const value = req.headers.get(spec.header);
      if (value === null) return null;
      // Delegated clients are OAuth clients (their sub): a static token or a
      // local caller with the same name is not one.
      const reason =
        caller.kind !== "oauth" || !d.clients.has(caller.name)
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
    sourceKey: string,
    faces: Faces,
    answer: MethodAnswer | null,
  ): Promise<Response> {
    const method = req.method;
    const started = clock.monotonic();
    let callerName: string | undefined;
    const passedAuth = new WeakSet<Response>();
    // Set by the first serve.request or serve.request_failed line; one per exchange.
    let logged = false;
    const common = (status: number) => ({
      method,
      sourceKey,
      ...(callerName === undefined ? {} : { caller: callerName }),
      status,
      ms: Math.round(clock.monotonic() - started),
    });
    /** Logs serve.request once; `known` skips reading the rejection from the body. */
    const finish = async (
      res: Response,
      extra: Readonly<Record<string, unknown>> = {},
      known?: { rejection: string | undefined },
    ): Promise<Response> => {
      if (logged) return res;
      logged = true;
      const rejection = known === undefined ? await rejectionOf(res) : known.rejection;
      log("serve.request", {
        ...common(res.status),
        ...extra,
        ...(rejection === undefined ? {} : { rejection }),
      });
      return res;
    };
    /** Logs serve.request_failed once and answers bodies.internal. */
    const fail = (
      reason: "threw" | "deadline",
      extra: Readonly<Record<string, unknown>>,
      detail: Readonly<Record<string, unknown>> = {},
    ): Response => {
      if (!logged) {
        logged = true;
        log("serve.request_failed", { ...common(500), ...extra, reason, ...detail });
      }
      return bodies.internal(profile.bodies.internal);
    };
    /** An auth refusal: one refusal token spent, and its line. */
    const chargeRefusal = (event: string, fields: Readonly<Record<string, unknown>>) => {
      refusal?.allow(sourceKey);
      log(event, { method, sourceKey, ...fields });
    };
    /** 429 when the source holds no refusal token, spending none. */
    const peekRefusal = (): Response | undefined => {
      if (refusal === null || refusal.peek(sourceKey)) return undefined;
      rateLimited("refusal", { method, sourceKey });
      return bodies.tooManyRequests();
    };

    if (answer === "405-first") return finish(bodies.methodNotAllowed(), {}, NO_REJECTION);
    const res = await authenticated();
    // rev 3.1: every non-POST exit logs serve.request.
    return answer === null ? res : finish(res);

    async function authenticated(): Promise<Response> {
      // 5.1, 5.2
      const early = hostRefusal(req, faces, 5) ?? peekRefusal();
      if (early) return early;
      // 5.3
      if (o.credentials !== undefined && faces.bearer) {
        const c = o.credentials(req);
        if (c instanceof Response) return c;
        if (c !== undefined) return proceed(req, c);
      }
      if (o.auth !== undefined && faces.oauth) return viaOAuth(o.auth);
      if (o.credentials !== undefined || o.auth !== undefined) {
        chargeRefusal("serve.unauthorized", { status: 401 });
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
    async function viaOAuth(auth: ServeAuthLayer): Promise<Response> {
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
              const got: unknown = await o.resolveScopes(claims);
              if (Array.isArray(got) && got.every((v) => typeof v === "string")) extra = got;
              else
                log("serve.scope_resolve_failed", { caller: sub, errorClass: "NotAStringArray" });
            } catch (err) {
              log("serve.scope_resolve_failed", { caller: sub, errorClass: className(err) });
            }
          }
          const scopes =
            extra.length === 0
              ? baseScopes
              : expandScopes(toolScopes, [...profile.oauthScopes, ...extra]);
          return proceed(verified, { name: sub, kind: "oauth", scopes, claims });
        });
      } catch (err) {
        const jwks = isJwksFailure(err);
        chargeRefusal("serve.auth_threw", {
          errorClass: className(err),
          ...(jwks ? { jwks: true } : {}),
          error: err,
        });
        return jwks
          ? bodies.jwksFailure(profile.bodies.jwksFailure)
          : bodies.internal(profile.bodies.internal);
      }
      // A 401/403 from past authentication (the SDK's scope 403, an
      // aroundRequest answer) is the request's, not an auth refusal.
      if ((res.status === 401 || res.status === 403) && !passedAuth.has(res)) {
        chargeRefusal("serve.unauthorized", { status: res.status });
      }
      return res;
    }

    // 5.7 onward; never throws, and marks what it answers as authenticated.
    async function proceed(r: Request, caller: Caller): Promise<Response> {
      const res = await proceedUnmarked(r, caller);
      passedAuth.add(res);
      return res;
    }

    async function proceedUnmarked(r: Request, caller: Caller): Promise<Response> {
      callerName = caller.name;
      try {
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
        return await (hooks.aroundRequest ? hooks.aroundRequest(r, run) : run());
      } catch (err) {
        return fail("threw", {}, { errorClass: className(err), error: err });
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
      const x: Exchange = { ctx, timedOut: () => timedOut, server: undefined, failure: undefined };
      if (answer === "auth-then-405") return finish(bodies.methodNotAllowed(), {}, NO_REJECTION);
      if (answer === "auth-then-entry") {
        return finish(await entry.run(r, x, undefined, authInfo), fields());
      }
      // 5.8: the entry's own pre-body checks, in its order and with its bytes.
      const refuse = (e: EntryRefusal) => finish(e.res, fields(), { rejection: e.rejection });
      const pre = entry.preBody(r);
      if (pre) return refuse(pre);
      const limit = profile.bodyLimit[caller.kind];
      let text: string | undefined;
      try {
        const read = await readRequestBody(r, limit ?? Number.POSITIVE_INFINITY);
        if (read.tooLarge) return refuse(entry.tooLarge(limit ?? 0));
        text = read.text;
      } catch {
        text = undefined;
      }
      const parsed = parseBody(text);
      const late = await entry.afterParse(r, parsed);
      if (late) return refuse(late);
      if (parsed === UNPARSABLE) {
        log("serve.bad_request", { method, sourceKey, caller: caller.name, status: 400 });
        return bodies.parseError(profile.bodies.parseError);
      }
      // One more serving token per message after the first.
      if (
        Array.isArray(parsed) &&
        parsed.length > 1 &&
        serving !== null &&
        !serving.allowN(caller.name, parsed.length - 1)
      ) {
        rateLimited("serving", { method, sourceKey, caller: caller.name, batch: parsed.length });
        return bodies.tooManyRequests();
      }
      // 5.9–5.10. On expiry the per-request server is closed, but a tool
      // handler cannot be stopped: one that never returns keeps its
      // concurrency slot until it does. raceDeadline keeps the losing
      // dispatch's rejection handled.
      const dispatch = entry.run(r, x, parsed, authInfo);
      let res: Response;
      if (profile.deadlineMs === null) res = await dispatch;
      else {
        const won = await raceDeadline(timers, profile.deadlineMs, dispatch, () => {
          timedOut = true;
          x.server?.close().catch(() => {});
        });
        if (won === "timeout") return fail("deadline", fields());
        res = won.value;
      }
      // 5.11
      return finish(res, fields());
    }
  }

  const service: McpService = {
    async handle(req, info) {
      let sourceKey: string | undefined;
      try {
        sourceKey = sourceKeyFor(req, info, profile.clientIpHeader);
        const url = new URL(req.url);
        // acceptCredentials decides the face: no static bearer is the public one.
        const faces = o.acceptCredentials?.(req, info) ?? ALL_FACES;
        const answer = methodAnswer(req.method);
        const onMcp = url.pathname === profile.mcpPath;
        // 2: the private face checks Host/Origin before anything else, a
        // 405-first answer excepted.
        if (!(onMcp && answer === "405-first")) {
          const r = hostRefusal(req, faces, 2);
          if (r) return r;
        }
        // 1 and 5
        if (onMcp) return await mcp(req, url, sourceKey, faces, answer);
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
          return (await raceDeadline(timers, ms, work())) !== "timeout";
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
      if (entry.close !== null) await bounded(entry.close, s.forceMs);
      // allSettled: one sink that rejects at once must not end the wait (and
      // close the pool) under the others. Flushed means every one fulfilled.
      let flushed = false;
      try {
        const settled = await raceDeadline(
          timers,
          s.flushMs,
          Promise.allSettled([
            ...(o.usage?.sinks ?? []).map((sink) => Promise.resolve().then(() => sink.idle?.())),
            Promise.resolve().then(() => o.auth?.idle()),
          ]),
        );
        flushed = settled !== "timeout" && settled.value.every((r) => r.status === "fulfilled");
      } catch {
        // flushed stays false.
      }
      let poolClosed = false;
      let poolReason = "none";
      let poolMs = 0;
      if (endPool !== undefined) {
        const at = clock.monotonic();
        try {
          const ended = await raceDeadline(
            timers,
            s.poolEndTimeoutS * 1000,
            Promise.resolve().then(() => endPool(s.poolEndTimeoutS)),
          );
          poolMs = Math.round(clock.monotonic() - at);
          poolClosed = ended !== "timeout";
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
