// Synthetic profiles, a fake auth layer and request helpers for the service tests.

import {
  createMcpHandler,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { currentCall } from "./call.ts";
import { captureLog, fakeTime } from "./fakes.test-support.ts";
import type { Limits } from "./limits.ts";
import { createMcpService, type McpServiceOptions } from "./service.ts";
import {
  type CallRecord,
  type CallSink,
  defineToolScopes,
  type ServeProfile,
  type UsageWiring,
} from "./types.ts";

export const ORIGIN = "http://app.example.test";

export const TOOL_SCOPES = defineToolScopes({
  id: "test",
  tools: { echo: "mcp:tools", slow: "mcp:tools", boom: "mcp:tools", spend: "mcp:tools" },
  implies: { "mcp:tools": ["mcp:tools"], profile: ["profile", "mcp:tools"] },
});

/**
 * Stands in for §9's transport (JSON) column with GET 405-first, a deadline,
 * delegated headers, empty bodies and renamed log lines. Deviations from §9:
 * deadline 1,000 (not 30,000) so tests run fast; delegated header names and
 * shapes are synthetic; clientIpHeader is `x-client-ip`; limits are per test.
 */
export const TRANSPORT_EMPTY: ServeProfile = {
  id: "test.transport-empty",
  mcpPath: "/mcp",
  methods: { get: "405-first", other: "auth-then-entry" },
  passUnknown: false,
  authPrefixes: { api: ["/api/auth/"], wellKnown: ["/.well-known/"] },
  entry: { kind: "transport", json: true },
  bodyLimit: { oauth: null, bearer: null, local: null, none: null },
  deadlineMs: 1_000,
  unknownTool: "isError",
  toolThrow: "message",
  requireCaller: true,
  oauthScopes: ["mcp:tools"],
  hostCheck: false,
  delegated: {
    clients: ["agent"],
    onBehalfOf: { header: "x-on-behalf-of", shape: /^user:[a-z0-9]{1,20}$/ },
    turnId: { header: "x-turn-id", shape: /^[A-Za-z0-9_.:-]{1,200}$/ },
  },
  clientIpHeader: "x-client-ip",
  bodies: {
    unauthorizedNoSub: "empty-401",
    jwksFailure: "500-empty",
    notFound: "empty-no-store",
    internal: "empty-500",
    tooLarge: "jsonrpc-413",
    parseError: "empty-400",
  },
  logNames: { "serve.request": "app.request" },
  shutdown: { drainMs: 200, forceMs: 50, poolEndTimeoutS: 1, flushMs: 50 },
};

/**
 * Stands in for §9's transport (JSON) column with GET auth-then-405, exact
 * host matching and text bodies. Deviations from §9: bodyLimit 4,096 (not
 * 4,194,304) so a 413 is cheap to provoke; host and origin lists are
 * synthetic; clientIpHeader is `x-client-ip` (not cf-connecting-ip); limits
 * are per test.
 */
export const TRANSPORT_TEXT: ServeProfile = {
  ...TRANSPORT_EMPTY,
  id: "test.transport-text",
  methods: { get: "auth-then-405", other: "auth-then-entry" },
  authPrefixes: { api: ["/api/auth"], wellKnown: ["/.well-known"] },
  bodyLimit: { oauth: 4_096, bearer: 4_096, local: 4_096, none: 4_096 },
  deadlineMs: null,
  unknownTool: "protocolError",
  hostCheck: {
    hosts: { list: ["app.example.test"], whenEmpty: "allow-all", match: "exact", loopback: "none" },
    origins: { list: ["https://app.example.test"], whenEmpty: "allow-all", absent: "allow" },
    refusal: "404-text",
    appliesTo: "mcp",
  },
  delegated: false,
  clientIpHeader: "x-client-ip",
  bodies: {
    unauthorizedNoSub: "jsonrpc-401",
    jwksFailure: "503-retry",
    notFound: "text-not-found",
    internal: "text-500",
    tooLarge: "jsonrpc-413",
    parseError: "jsonrpc-400",
  },
  logNames: {},
};

/**
 * Stands in for §9's handler-entry column: stateless legacy, passUnknown,
 * hostname matching with the SDK's 403s on all but the public auth face,
 * JSON bodies. Deviations from §9: bodyLimit oauth/none 2,048 and
 * bearer/local 8,192 (not 4,194,304 and 9,437,184); authPrefixes keep the
 * transport columns' prefix lists (§9's exact `/api/auth` route is not
 * expressible with prefixes); clientIpHeader null (not cf-connecting-ip);
 * logNames identity (not the consumer's texts); limits are per test.
 */
export const HANDLER_JSON: ServeProfile = {
  ...TRANSPORT_EMPTY,
  id: "test.handler",
  methods: { get: "auth-then-entry", other: "auth-then-entry" },
  passUnknown: true,
  entry: { kind: "handler", legacy: "stateless" },
  bodyLimit: { oauth: 2_048, bearer: 8_192, local: 8_192, none: 2_048 },
  deadlineMs: null,
  unknownTool: "protocolError",
  toolThrow: "generic",
  hostCheck: {
    hosts: {
      list: ["app.example.test"],
      whenEmpty: "loopback-only",
      match: "hostname",
      loopback: "union",
    },
    origins: { list: [], whenEmpty: "same-as-hosts", absent: "allow" },
    refusal: "sdk-403",
    appliesTo: "all-but-public-auth",
  },
  delegated: false,
  clientIpHeader: null,
  bodies: {
    unauthorizedNoSub: "jsonrpc-401",
    jwksFailure: "jsonrpc-500",
    notFound: "json-not-found",
    internal: "json-500",
    tooLarge: "jsonrpc-413",
    parseError: "jsonrpc-400",
  },
  logNames: {},
};

export const noLimits = (): Limits => ({
  refusal: null,
  serving: null,
  perTool: {},
  concurrency: {},
  turnBudget: null,
  logIntervalMs: 1_000,
});

/**
 * Bearer tokens: `good:<sub>` → next with that sub, `nosub` → next with no
 * sub, `jwks` / `nojwks` → the two JWKS throws, `jwksnet` → Better Auth's
 * network-error text, `jwksconn` → older Bun's refused fetch (code
 * ConnectionRefused), `dbconn` → a driver's ECONNREFUSED, `jwkstimeout` → jose's JWKSTimeout (`jwkstimeout-min`: its name minified), `throw` → a TypeError, `deny` → a 403; no token → a
 * 401 challenge.
 */
export function fakeAuth(): NonNullable<McpServiceOptions["auth"]> & {
  handled: string[];
  idled: number;
} {
  const handled: string[] = [];
  const layer = {
    handled,
    idled: 0,
    async handle(req: Request) {
      handled.push(new URL(req.url).pathname);
      return new Response("auth", { status: 200 });
    },
    page(path: "/login" | "/consent", url: URL) {
      return new Response(`page ${path}${url.search}`, { status: 200 });
    },
    asset(path: string) {
      return path === "/font.woff2" ? new Response("font", { status: 200 }) : null;
    },
    async verify(
      req: Request,
      next: (req: Request, claims: Readonly<Record<string, unknown>>) => Promise<Response>,
    ) {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
      if (token === undefined) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="x"' },
        });
      }
      if (token.startsWith("good:")) return next(req, { sub: token.slice(5), azp: "client" });
      if (token === "nosub") return next(req, { azp: "client" });
      if (token === "jwks") throw new Error("Jwks failed: fetch refused");
      if (token === "nojwks") throw new Error("No jwks found");
      if (token === "jwksnet") throw new Error("JWKS fetch failed");
      if (token === "jwksconn") {
        // Bun before 1.4: a refused fetch is a plain Error with a code.
        throw Object.assign(
          new Error("Unable to connect. Is the computer able to access the url?"),
          {
            code: "ConnectionRefused",
          },
        );
      }
      if (token === "dbconn") {
        // A database driver's errno code (the DPoP replay store): not the JWKS.
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }
      if (token === "jwkstimeout") {
        // jose's class: the code is the contract, the name is constructor.name.
        throw Object.assign(new Error("request timed out"), {
          name: "JWKSTimeout",
          code: "ERR_JWKS_TIMEOUT",
        });
      }
      if (token === "jwkstimeout-min") {
        // A minified bundle: constructor.name renamed, the code intact.
        throw Object.assign(new Error("request timed out"), {
          name: "a",
          code: "ERR_JWKS_TIMEOUT",
        });
      }
      if (token === "deny") return new Response(null, { status: 403 });
      throw new TypeError("verifier broke");
    },
    async idle() {
      layer.idled++;
    },
  };
  return layer;
}

export function registerSynthetic(server: McpServer, hooks: { slowMs?: () => Promise<void> } = {}) {
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { text: z.string() } },
    async ({ text }) => {
      currentCall().setResultIds([text]);
      return { content: [{ type: "text", text }] };
    },
  );
  server.registerTool("slow", { description: "slow" }, async () => {
    await (hooks.slowMs?.() ?? Promise.resolve());
    currentCall().setResultIds(["late"]);
    return { content: [{ type: "text", text: "slow done" }] };
  });
  server.registerTool("boom", { description: "boom" }, async () => {
    throw new RangeError("kaboom");
  });
}

export function makeService(
  over: Partial<McpServiceOptions> & { slow?: () => Promise<void> } = {},
) {
  const time = fakeTime();
  const log = captureLog();
  const records: CallRecord[] = [];
  const sink: CallSink = { record: (r) => records.push(r), idle: async () => {} };
  const usage: UsageWiring = {
    sinks: [sink],
    keepArgs: true,
    keepOutput: false,
    price: () => ({ costUsd: null, costNote: "unpriced" }),
    errorClassOf: (err, classify) => classify?.(err) ?? (err instanceof Error ? err.name : "x"),
    spend: null,
    serverSha: null,
  };
  let ids = 0;
  const { slow, ...rest } = over;
  const service = createMcpService({
    profile: TRANSPORT_EMPTY,
    serverInfo: { name: "test", version: "0.0.0" },
    registerTools: (server) => registerSynthetic(server, { slowMs: slow }),
    toolScopes: TOOL_SCOPES,
    limits: noLimits(),
    usage,
    hooks: {},
    clock: time,
    timers: time,
    randomId: () => `req-${++ids}`,
    log,
    ...rest,
  });
  return { service, time, log, records };
}

export const CALL_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

export function mcpRequest(
  body: unknown,
  o: { token?: string; headers?: Record<string, string>; method?: string; raw?: boolean } = {},
): Request {
  const method = o.method ?? "POST";
  return new Request(`${ORIGIN}/mcp`, {
    method,
    headers: {
      ...(method === "POST" ? CALL_HEADERS : {}),
      ...(o.token === undefined ? {} : { authorization: `Bearer ${o.token}` }),
      ...o.headers,
    },
    ...(method === "POST" ? { body: o.raw ? (body as string) : JSON.stringify(body) } : {}),
  });
}

export const call = (name: string, args?: unknown, id: number = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
});

/** A JSON-RPC body from a JSON or SSE response. */
export async function rpcOf(res: Response): Promise<unknown> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l.length > 6)
      .map((l) => JSON.parse(l.slice(6)));
    return data.length === 1 ? data[0] : data;
  }
  return text === "" ? null : JSON.parse(text);
}

export async function snapshot(res: Response | null) {
  if (res === null) return null;
  return {
    status: res.status,
    headers: [...res.headers].sort(([a], [b]) => a.localeCompare(b)),
    body: await res.text(),
  };
}

/** The SDK's own answer to `req` under `entry`, with the same body cap. */
export async function sdkAnswer(
  entry: "transport" | "handler",
  req: Request,
  maxRequestBodySize?: number,
): Promise<Response> {
  const build = () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerSynthetic(server);
    return server;
  };
  if (entry === "handler") {
    return createMcpHandler(build, {
      legacy: "stateless",
      ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
    }).fetch(req);
  }
  const server = build();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
