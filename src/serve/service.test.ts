import { describe, expect, test } from "bun:test";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { currentCall } from "./call.ts";
import { type FakeTime, signal, until } from "./fakes.test-support.ts";
import type { Limits } from "./limits.ts";
import {
  CALL_HEADERS,
  call,
  fakeAuth,
  HANDLER_JSON,
  makeService,
  mcpRequest,
  noLimits,
  ORIGIN,
  registerSynthetic,
  rpcOf,
  sdkAnswer,
  snapshot,
  TRANSPORT_EMPTY,
  TRANSPORT_TEXT,
} from "./service.test-support.ts";
import type { McpServiceOptions } from "./service.ts";
import type { Caller, CallSink, ServeProfile, UsageWiring } from "./types.ts";

const HOST = { host: "app.example.test" };
const both = { bearer: true, oauth: true };
const withAuth = (
  profile: ServeProfile,
  over: Partial<McpServiceOptions> & { slow?: () => Promise<void> } = {},
) => {
  const auth = fakeAuth();
  return { auth, ...makeService({ profile, auth, acceptCredentials: () => both, ...over }) };
};
const limits = (over: Partial<Limits>): Limits => ({ ...noLimits(), ...over });
const bucket = (capacity: number) => ({ capacity, refillPerSecond: 1, maxKeys: 100 });

describe("step 1: methods other than POST on mcpPath", () => {
  test('"405-first": the 405 before auth, logged, nothing charged', async () => {
    const refusal = bucket(1);
    const { service, log } = withAuth(TRANSPORT_EMPTY, { limits: limits({ refusal }) });
    for (let i = 0; i < 3; i++) {
      expect(await snapshot(await service.handle(mcpRequest(null, { method: "GET" }), {}))).toEqual(
        {
          status: 405,
          headers: [
            ["allow", "POST"],
            ["cache-control", "no-store"],
          ],
          body: "",
        },
      );
    }
    expect(log.names()).toEqual(["app.request", "app.request", "app.request"]);
  });

  test('"auth-then-405": the 401 challenge without a token, the 405 with one; serving charged', async () => {
    const { service, log } = withAuth(TRANSPORT_TEXT, { limits: limits({ serving: bucket(1) }) });
    const get = (token?: string) =>
      service.handle(mcpRequest(null, { method: "GET", token, headers: HOST }), {});
    expect((await get())?.status).toBe(401);
    expect((await get("good:u1"))?.status).toBe(405);
    expect((await get("good:u1"))?.status).toBe(429);
    const requests = log.lines
      .filter(([e]) => e === "serve.request")
      .map(([, f]) => [f.status, f.caller]);
    expect(requests).toEqual([
      [401, undefined],
      [405, "u1"],
      [429, "u1"],
    ]);
  });

  test('"auth-then-entry": the entry answers untouched (transport HEAD/OPTIONS 405, DELETE 200)', async () => {
    const { service } = withAuth(TRANSPORT_EMPTY);
    const head = await service.handle(
      mcpRequest(null, { method: "OPTIONS", token: "good:u1" }),
      {},
    );
    expect(head?.status).toBe(405);
    expect(head?.headers.get("allow")).toBe("GET, POST, DELETE");
    const del = await service.handle(mcpRequest(null, { method: "DELETE", token: "good:u1" }), {});
    expect(await snapshot(del ?? null)).toMatchObject({ status: 200, body: "" });
    expect((await service.handle(mcpRequest(null, { method: "HEAD" }), {}))?.status).toBe(401);
  });

  test('"auth-then-entry" under the handler: its 405 allow: POST, logged with its rejection', async () => {
    const { service, log } = withAuth(HANDLER_JSON);
    const res = await service.handle(
      mcpRequest(null, { method: "GET", token: "good:u1", headers: HOST }),
      {},
    );
    const sdk = await sdkAnswer("handler", new Request(`${ORIGIN}/mcp`, { method: "GET" }));
    expect(await snapshot(res ?? null)).toEqual(await snapshot(sdk));
    expect(log.lines.at(-1)).toMatchObject([
      "serve.request",
      { method: "GET", status: 405, caller: "u1", rejection: "Method not allowed." },
    ]);
  });
});

describe("step 2 and 5.1: host and origin", () => {
  test("private face: checked before the auth routes, with the SDK's 403 bytes", async () => {
    const { service, auth } = withAuth(HANDLER_JSON);
    const bad = new Request(`${ORIGIN}/.well-known/x`, { headers: { host: "evil.test" } });
    const res = await service.handle(bad, {});
    expect(await snapshot(res ?? null)).toEqual({
      status: 403,
      headers: [["content-type", "application/json"]],
      body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid Host: evil.test"},"id":null}',
    });
    expect(auth.handled).toEqual([]);
    const origin = new Request(`${ORIGIN}/mcp`, {
      headers: { host: "localhost:3000", origin: "http://evil.test" },
    });
    expect(await (await service.handle(origin, {}))?.text()).toContain("Invalid Origin: evil.test");
    expect((await service.handle(new Request(`${ORIGIN}/mcp`, {}), {}))?.status).toBe(403);
  });

  test("public face: auth routes skip the check, /mcp keeps it", async () => {
    const { service, auth } = withAuth(HANDLER_JSON, {
      acceptCredentials: () => ({ bearer: false, oauth: true }),
    });
    const wk = await service.handle(
      new Request(`${ORIGIN}/.well-known/x`, { headers: { host: "evil.test" } }),
      {},
    );
    expect(wk?.status).toBe(200);
    expect(auth.handled).toEqual(["/.well-known/x"]);
    const mcp = await service.handle(
      mcpRequest(call("echo", { text: "x" }), { token: "good:u1", headers: { host: "evil.test" } }),
      {},
    );
    expect(mcp?.status).toBe(403);
  });

  test("exact match, 404-text refusal, absent Origin passes, applies to mcpPath only", async () => {
    const { service } = withAuth(TRANSPORT_TEXT);
    // The same construction a consumer uses today; Bun adds its text/plain default when serving.
    const notFound = { status: 404, headers: [], body: "Not Found" };
    const req = (h: Record<string, string>) =>
      mcpRequest(call("echo", { text: "x" }), { token: "good:u1", headers: h });
    expect(
      await snapshot((await service.handle(req({ host: "app.example.test:443" }), {})) ?? null),
    ).toEqual(notFound);
    expect(
      await snapshot(
        (await service.handle(req({ ...HOST, origin: "https://evil.test" }), {})) ?? null,
      ),
    ).toEqual(notFound);
    expect((await service.handle(req(HOST), {}))?.status).toBe(200);
    expect(
      (await service.handle(req({ ...HOST, origin: "https://app.example.test" }), {}))?.status,
    ).toBe(200);
    expect(
      (
        await service.handle(
          new Request(`${ORIGIN}/elsewhere`, { headers: { host: "evil.test" } }),
          {},
        )
      )?.status,
    ).toBe(404);
  });

  test("sdk-403 with exact matching is refused at build", () => {
    const hc = {
      ...(TRANSPORT_TEXT.hostCheck as Exclude<ServeProfile["hostCheck"], false>),
      refusal: "sdk-403" as const,
    };
    expect(() => makeService({ profile: { ...TRANSPORT_TEXT, hostCheck: hc } })).toThrow(
      /needs hosts.match "hostname"/,
    );
  });
});

describe("step 3: auth routes", () => {
  test("well-known unmetered; api charged except the JWKS path; login/consent charged; assets GET only", async () => {
    const { service, auth, log } = withAuth(TRANSPORT_EMPTY, {
      limits: limits({ refusal: bucket(3) }),
    });
    const get = (p: string, method = "GET") =>
      service.handle(new Request(`${ORIGIN}${p}`, { method }), { remoteAddress: "192.0.2.1" });
    for (let i = 0; i < 5; i++)
      expect((await get("/.well-known/oauth-protected-resource"))?.status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await get("/api/auth/jwks"))?.status).toBe(200);
    expect((await get("/api/auth/token", "POST"))?.status).toBe(200);
    expect(await (await get("/consent?client=a"))?.text()).toBe("page /consent?client=a");
    expect(await (await get("/login"))?.text()).toBe("page /login");
    const drained = await get("/api/auth/token", "POST");
    expect(await snapshot(drained ?? null)).toEqual({
      status: 429,
      headers: [
        ["cache-control", "no-store"],
        ["retry-after", "10"],
      ],
      body: "",
    });
    expect(await (await get("/font.woff2"))?.text()).toBe("font");
    expect((await get("/font.woff2", "HEAD"))?.status).toBe(429);
    expect(auth.handled.filter((p) => p === "/api/auth/token")).toHaveLength(1);
    expect(log.lines.find(([e]) => e === "serve.auth_request")?.[1]).toEqual({
      method: "GET",
      sourceKey: "192.0.2.1",
      pathname: "/.well-known/oauth-protected-resource",
      status: 200,
    });
  });
});

describe("step 4: other paths", () => {
  test("passUnknown answers null", async () => {
    const { service } = withAuth(HANDLER_JSON);
    expect(await service.handle(new Request(`${ORIGIN}/health`, { headers: HOST }), {})).toBeNull();
  });
  test("otherwise the refusal bucket is charged and notFound answered, per profile", async () => {
    const { service } = withAuth(TRANSPORT_EMPTY, { limits: limits({ refusal: bucket(1) }) });
    const res = await service.handle(new Request(`${ORIGIN}/nope`), {});
    expect(await snapshot(res ?? null)).toEqual({
      status: 404,
      headers: [["cache-control", "no-store"]],
      body: "",
    });
    expect((await service.handle(new Request(`${ORIGIN}/nope`), {}))?.status).toBe(429);
    const json = withAuth({ ...HANDLER_JSON, passUnknown: false }).service;
    expect(
      await (await json.handle(new Request(`${ORIGIN}/nope`, { headers: HOST }), {}))?.text(),
    ).toBe('{"error":"not found"}');
  });
});

describe("step 5.2–5.7: credentials", () => {
  test("5.2: a drained refusal bucket refuses before any verification", async () => {
    const { service, auth } = withAuth(TRANSPORT_EMPTY, { limits: limits({ refusal: bucket(1) }) });
    let verified = 0;
    const verify = auth.verify;
    auth.verify = (r, n) => {
      verified++;
      return verify(r, n);
    };
    expect((await service.handle(mcpRequest(call("echo", { text: "x" })), {}))?.status).toBe(401);
    expect((await service.handle(mcpRequest(call("echo", { text: "x" })), {}))?.status).toBe(429);
    expect(verified).toBe(1);
  });

  test("5.3: a static credential's Caller skips OAuth, its Response is returned, no match without OAuth is the bearer 401", async () => {
    const bearer: Caller = { name: "tok", kind: "bearer", scopes: new Set(["mcp:tools"]) };
    const credentials = (req: Request) => {
      const a = req.headers.get("authorization");
      if (a === "Bearer static") return bearer;
      if (a === "Bearer revoked") return new Response("gone", { status: 410 });
      return undefined;
    };
    const { service, records, log } = makeService({ profile: TRANSPORT_EMPTY, credentials });
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "static" }), {}))
        ?.status,
    ).toBe(200);
    expect(records[0]?.caller).toBe("tok");
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "revoked" }), {}))
        ?.status,
    ).toBe(410);
    const none = await service.handle(
      mcpRequest(call("echo", { text: "x" }), { token: "other" }),
      {},
    );
    expect(await snapshot(none ?? null)).toEqual({
      status: 401,
      headers: [
        ["content-type", "application/json"],
        ["www-authenticate", "Bearer"],
      ],
      body: '{"error":"unauthorized"}',
    });
    expect(log.names()).toContain("serve.unauthorized");
  });

  test("5.4: a 401/403 from requireMcpAuth is returned, charged and logged", async () => {
    const { service, log } = withAuth(TRANSPORT_EMPTY, { limits: limits({ refusal: bucket(2) }) });
    const res = await service.handle(mcpRequest(call("echo", { text: "x" })), {
      remoteAddress: "198.51.100.9",
    });
    expect(res?.headers.get("www-authenticate")).toBe('Bearer resource_metadata="x"');
    expect(
      (
        await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "deny" }), {
          remoteAddress: "198.51.100.9",
        })
      )?.status,
    ).toBe(403);
    expect(
      (
        await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:u" }), {
          remoteAddress: "198.51.100.9",
        })
      )?.status,
    ).toBe(429);
    expect(log.lines.filter(([e]) => e === "serve.unauthorized").map(([, f]) => f)).toEqual([
      { method: "POST", sourceKey: "198.51.100.9", status: 401 },
      { method: "POST", sourceKey: "198.51.100.9", status: 403 },
    ]);
  });

  for (const [profile, expected] of [
    [
      TRANSPORT_TEXT,
      {
        status: 503,
        headers: [
          ["content-type", "text/plain; charset=utf-8"],
          ["retry-after", "5"],
        ],
        body: "Service Unavailable",
      },
    ],
    [TRANSPORT_EMPTY, { status: 500, headers: [], body: "" }],
    [
      HANDLER_JSON,
      {
        status: 500,
        headers: [["content-type", "application/json;charset=utf-8"]],
        body: '{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":null}',
      },
    ],
  ] as const) {
    test(`5.4: the JWKS throws and an unreachable auth server answer ${profile.bodies.jwksFailure}, charged, logged auth_threw jwks`, async () => {
      const throws = ["jwks", "nojwks", "jwksnet", "jwkstimeout"];
      const { service, log } = withAuth(profile, {
        limits: limits({ refusal: bucket(throws.length) }),
      });
      for (const token of throws) {
        const res = await service.handle(
          mcpRequest(call("echo", { text: "x" }), { token, headers: HOST }),
          {},
        );
        expect(await snapshot(res ?? null)).toEqual(expected as never);
      }
      expect(
        (
          await service.handle(
            mcpRequest(call("echo", { text: "x" }), { token: "good:u", headers: HOST }),
            {},
          )
        )?.status,
      ).toBe(429);
      expect(
        log.lines
          .filter(([e]) => e === "serve.auth_threw")
          .map(([, f]) => [f.errorClass, f.jwks, f.authUnreachable ?? false]),
      ).toEqual([
        ["Error", true, false],
        ["Error", true, false],
        ["Error", true, true],
        ["JWKSTimeout", true, true],
      ]);
    });
  }

  test("5.4: another throw is bodies.internal, charged, auth_threw without jwks", async () => {
    const { service, log } = withAuth(TRANSPORT_TEXT, { limits: limits({ refusal: bucket(1) }) });
    const res = await service.handle(
      mcpRequest(call("echo", { text: "x" }), { token: "throw", headers: HOST }),
      {},
    );
    expect(await snapshot(res ?? null)).toEqual({
      status: 500,
      headers: [["content-type", "text/plain; charset=utf-8"]],
      body: "Internal Server Error",
    });
    expect(log.lines.find(([e]) => e === "serve.auth_threw")?.[1]).toMatchObject({
      errorClass: "TypeError",
    });
    expect(log.lines.find(([e]) => e === "serve.auth_threw")?.[1]).not.toHaveProperty("jwks");
    expect(
      (
        await service.handle(
          mcpRequest(call("echo", { text: "x" }), { token: "good:u", headers: HOST }),
          {},
        )
      )?.status,
    ).toBe(429);
  });

  test("5.5: a missing sub answers unauthorizedNoSub, charged and logged like any 401", async () => {
    const { service, log } = withAuth(TRANSPORT_TEXT, { limits: limits({ refusal: bucket(1) }) });
    const res = await service.handle(
      mcpRequest(call("echo", { text: "x" }), { token: "nosub", headers: HOST }),
      {},
    );
    expect(await snapshot(res ?? null)).toEqual({
      status: 401,
      headers: [["content-type", "application/json"]],
      body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"token missing subject claim"},"id":null}',
    });
    expect(log.names()).toContain("serve.unauthorized");
    const empty = withAuth(TRANSPORT_EMPTY).service;
    expect(
      await snapshot(
        (await empty.handle(mcpRequest(call("echo"), { token: "nosub" }), {})) ?? null,
      ),
    ).toEqual({
      status: 401,
      headers: [["cache-control", "no-store"]],
      body: "",
    });
  });

  test("5.6: resolveScopes adds to oauthScopes; a throw falls back to oauthScopes and logs", async () => {
    const seen: string[][] = [];
    const registerTools = (server: McpServer, ctx: { caller: Caller }) => {
      seen.push([...ctx.caller.scopes].sort());
      registerSynthetic(server);
    };
    const ok = withAuth(TRANSPORT_EMPTY, { registerTools, resolveScopes: async () => ["profile"] });
    await ok.service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:u" }), {});
    const bad = withAuth(TRANSPORT_EMPTY, {
      registerTools,
      resolveScopes: async () => {
        throw new SyntaxError("lookup failed");
      },
    });
    const res = await bad.service.handle(
      mcpRequest(call("echo", { text: "x" }), { token: "good:u" }),
      {},
    );
    expect(res?.status).toBe(200);
    expect(seen).toEqual([["mcp:tools", "profile"], ["mcp:tools"]]);
    expect(bad.log.lines.find(([e]) => e === "serve.scope_resolve_failed")?.[1]).toEqual({
      caller: "u",
      errorClass: "SyntaxError",
    });
  });

  test("5.6: no auth configured: requireCaller gives kind none with no scopes, else the local caller", async () => {
    const callers: Caller[] = [];
    const registerTools = (server: McpServer, ctx: { caller: Caller }) => {
      callers.push(ctx.caller);
      registerSynthetic(server);
    };
    const strict = makeService({ registerTools });
    const res = await strict.service.handle(mcpRequest(call("echo", { text: "x" })), {});
    expect(await rpcOf(res as Response)).toMatchObject({ result: { isError: true } });
    const open = makeService({
      registerTools,
      profile: { ...TRANSPORT_EMPTY, requireCaller: false },
    });
    expect(
      await rpcOf(
        (await open.service.handle(mcpRequest(call("echo", { text: "x" })), {})) as Response,
      ),
    ).toMatchObject({
      result: { content: [{ text: "x" }] },
    });
    expect(callers.map((c) => [c.name, c.kind, [...c.scopes].sort()])).toEqual([
      ["none", "none", []],
      ["local", "local", ["mcp:tools", "profile"]],
    ]);
    // Said once, at build: every HTTP caller is the local caller with every scope.
    expect(open.log.lines.filter(([e]) => e === "serve.unauthenticated_http")).toEqual([
      ["serve.unauthenticated_http", { mcpPath: "/mcp" }],
    ]);
    expect(strict.log.names()).not.toContain("serve.unauthenticated_http");
  });

  test("5.7: the serving bucket by caller name", async () => {
    const { service, log } = withAuth(TRANSPORT_EMPTY, { limits: limits({ serving: bucket(1) }) });
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:a" }), {}))
        ?.status,
    ).toBe(200);
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:a" }), {}))
        ?.status,
    ).toBe(429);
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:b" }), {}))
        ?.status,
    ).toBe(200);
    expect(log.lines.find(([e]) => e === "serve.rate_limited")?.[1]).toMatchObject({
      bucket: "serving",
      caller: "a",
    });
  });
});

describe("step 5.8: the entry's pre-body refusals, byte-checked against the SDK", () => {
  const cases: [string, Record<string, string>][] = [
    ["406 Accept", { ...CALL_HEADERS, accept: "application/json" }],
    ["415 Content-Type", { ...CALL_HEADERS, "content-type": "text/plain" }],
    [
      "406 before 415 (transport) / 415 before 406 (handler)",
      { accept: "text/html", "content-type": "text/plain" },
    ],
  ];
  for (const profile of [TRANSPORT_TEXT, HANDLER_JSON]) {
    for (const [name, headers] of cases) {
      test(`${profile.entry.kind}: ${name}`, async () => {
        const { service, log } = withAuth(profile);
        const body = JSON.stringify(call("echo", { text: "x" }));
        const ours = await service.handle(
          new Request(`${ORIGIN}/mcp`, {
            method: "POST",
            headers: { ...headers, ...HOST, authorization: "Bearer good:u" },
            body,
          }),
          {},
        );
        const sdk = await sdkAnswer(
          profile.entry.kind,
          new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body }),
        );
        expect(await snapshot(ours ?? null)).toEqual(await snapshot(sdk));
        expect(log.lines.at(-1)?.[1]).toHaveProperty("rejection");
      });
    }

    test(`${profile.entry.kind}: 413 per caller kind, the SDK's bytes with the profile's limit`, async () => {
      const bearer: Caller = { name: "tok", kind: "bearer", scopes: new Set(["mcp:tools"]) };
      const { service } = withAuth(profile, {
        credentials: (r) =>
          r.headers.get("authorization") === "Bearer static" ? bearer : undefined,
      });
      const limitOf = (k: Caller["kind"]) => profile.bodyLimit[k] as number;
      const big = (n: number) => JSON.stringify(call("echo", { text: "a".repeat(n) }));
      for (const [token, kind] of [
        ["good:u", "oauth"],
        ["static", "bearer"],
      ] as const) {
        const over = big(limitOf(kind));
        const ours = await service.handle(
          mcpRequest(over, { raw: true, token, headers: HOST }),
          {},
        );
        const sdk = await sdkAnswer(
          profile.entry.kind,
          mcpRequest(over, { raw: true }),
          limitOf(kind),
        );
        expect(ours?.status).toBe(413);
        expect(await snapshot(ours ?? null)).toEqual(await snapshot(sdk));
      }
      if (limitOf("oauth") !== limitOf("bearer")) {
        const between = big(limitOf("oauth"));
        expect(
          (
            await service.handle(
              mcpRequest(between, { raw: true, token: "static", headers: HOST }),
              {},
            )
          )?.status,
        ).toBe(200);
      }
    });

    test(`${profile.entry.kind}: 400 parse error, the SDK's bytes, logged bad_request`, async () => {
      const { service, log } = withAuth(profile);
      for (const raw of ["{nope", ""]) {
        const ours = await service.handle(
          mcpRequest(raw, { raw: true, token: "good:u", headers: HOST }),
          {},
        );
        const sdk = await sdkAnswer(profile.entry.kind, mcpRequest(raw, { raw: true }));
        expect(await snapshot(ours ?? null)).toEqual(await snapshot(sdk));
      }
      expect(log.names().filter((n) => n === "serve.bad_request")).toHaveLength(2);
    });
  }

  test("handler: a bad Accept with an unparsable body is the SDK's 406, not a 400", async () => {
    const { service } = withAuth(HANDLER_JSON);
    const headers = { ...CALL_HEADERS, accept: "application/json" };
    const ours = await service.handle(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { ...headers, ...HOST, authorization: "Bearer good:u" },
        body: "{",
      }),
      {},
    );
    const sdk = await sdkAnswer(
      "handler",
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: "{" }),
    );
    expect(ours?.status).toBe(406);
    expect(await snapshot(ours ?? null)).toEqual(await snapshot(sdk));
  });

  test("empty-400 for a profile that parses itself", async () => {
    const { service } = withAuth(TRANSPORT_EMPTY);
    const res = await service.handle(mcpRequest("{", { raw: true, token: "good:u" }), {});
    expect(await snapshot(res ?? null)).toEqual({
      status: 400,
      headers: [["cache-control", "no-store"]],
      body: "",
    });
  });

  test("a declared Content-Length over the limit is refused unread", async () => {
    const { service } = withAuth(TRANSPORT_TEXT);
    let pulled = false;
    const body = new ReadableStream(
      {
        pull(c) {
          pulled = true;
          c.enqueue(new TextEncoder().encode("{}"));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        ...CALL_HEADERS,
        ...HOST,
        authorization: "Bearer good:u",
        "content-length": "999999",
      },
      body,
      duplex: "half",
    } as RequestInit);
    expect((await service.handle(req, {}))?.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
    expect(pulled).toBe(false);
  });

  test("the cap holds although the entry gets parsedBody, which the SDK never caps", async () => {
    const huge = call("echo", { text: "a".repeat(10_000) });
    // The pin: handed parsedBody, the transport skips its own body cap.
    const server = new McpServer({ name: "t", version: "0" });
    registerSynthetic(server);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 10,
    });
    await server.connect(transport);
    expect((await transport.handleRequest(mcpRequest(huge), { parsedBody: huge })).status).toBe(
      200,
    );
    // rootstock caps a streamed body with no Content-Length before handing it on.
    const { service, records } = withAuth(TRANSPORT_TEXT);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(huge)));
        c.close();
      },
    });
    const req = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { ...CALL_HEADERS, ...HOST, authorization: "Bearer good:u" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    expect((await service.handle(req, {}))?.status).toBe(413);
    expect(records).toEqual([]);
  });
});

describe("step 5.8: batch charge order", () => {
  test("a drained caller with an unparsable body gets 429, not 400", async () => {
    const { service } = withAuth(TRANSPORT_EMPTY, { limits: limits({ serving: bucket(1) }) });
    await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:u" }), {});
    expect(
      (await service.handle(mcpRequest("{", { raw: true, token: "good:u" }), {}))?.status,
    ).toBe(429);
  });

  test("a batch of 10 with capacity 3: 429 before any tool runs", async () => {
    const { service, records } = withAuth(TRANSPORT_EMPTY, {
      limits: limits({ serving: bucket(3) }),
    });
    const batch = Array.from({ length: 10 }, (_, i) => call("echo", { text: `${i}` }, i + 1));
    const res = await service.handle(mcpRequest(batch, { token: "good:u" }), {});
    expect(await snapshot(res)).toEqual({
      status: 429,
      headers: [
        ["cache-control", "no-store"],
        ["retry-after", "10"],
      ],
      body: "",
    });
    expect(records).toEqual([]);
  });

  test("a batch within capacity runs, one token per message", async () => {
    const { service, records } = withAuth(TRANSPORT_EMPTY, {
      limits: limits({ serving: bucket(3) }),
    });
    const batch = [1, 2, 3].map((i) => call("echo", { text: `${i}` }, i));
    const res = await service.handle(mcpRequest(batch, { token: "good:u" }), {});
    expect(((await rpcOf(res as Response)) as unknown[]).length).toBe(3);
    expect(records.map((r) => r.args)).toEqual([{ text: "1" }, { text: "2" }, { text: "3" }]);
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:u" }), {}))
        ?.status,
    ).toBe(429);
  });
});

describe("step 5.9: deadline", () => {
  test("expiry answers bodies.internal; the late tool records DeadlineExceeded, no ids", async () => {
    const gate = signal();
    const started = signal();
    const { service, time, log, records } = withAuth(TRANSPORT_EMPTY, {
      slow: () => {
        started.resolve();
        return gate.promise;
      },
    });
    const pending = service.handle(mcpRequest(call("slow"), { token: "good:u" }), {});
    await started.promise;
    time.advance(1_000);
    const res = await pending;
    expect(await snapshot(res ?? null)).toEqual({ status: 500, headers: [], body: "" });
    expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
      reason: "deadline",
      caller: "u",
      status: 500,
    });
    gate.resolve();
    await until(() => records.length > 0);
    expect(records[0]).toMatchObject({
      tool: "slow",
      stage: "handler",
      ok: false,
      errorClass: "DeadlineExceeded",
      resultIds: null,
    });
    expect(time.pending()).toBe(0);
  });

  test("a handler past the deadline keeps its concurrency slot until it returns", async () => {
    const gate = signal();
    const started = signal();
    const { service, time, records } = withAuth(TRANSPORT_EMPTY, {
      limits: limits({
        concurrency: { one: { tools: ["slow"], max: 1, busy: (t) => `${t} is busy` } },
      }),
      slow: () => {
        started.resolve();
        return gate.promise;
      },
    });
    const post = () => service.handle(mcpRequest(call("slow"), { token: "good:u" }), {});
    const first = post();
    await started.promise;
    time.advance(1_000);
    expect((await first)?.status).toBe(500);
    // Expired, but the handler still runs: the slot is still held.
    expect(await rpcOf((await post()) as Response)).toMatchObject({
      result: { isError: true, content: [{ text: '{"error":"slow is busy"}' }] },
    });
    gate.resolve();
    await until(() => records.some((r) => r.errorClass === "DeadlineExceeded"));
    expect(await rpcOf((await post()) as Response)).toMatchObject({
      result: { content: [{ text: "slow done" }] },
    });
  });

  test("a call that beats the deadline clears its timer", async () => {
    const { service, time } = withAuth(TRANSPORT_EMPTY);
    expect(
      (await service.handle(mcpRequest(call("echo", { text: "x" }), { token: "good:u" }), {}))
        ?.status,
    ).toBe(200);
    expect(time.pending()).toBe(0);
  });
});

describe("step 5.10 and the SDK-detail pin, under both entries over HTTP", () => {
  for (const profile of [
    { ...TRANSPORT_TEXT, unknownTool: "isError" as const },
    TRANSPORT_TEXT,
    { ...TRANSPORT_TEXT, toolThrow: "generic" as const },
    HANDLER_JSON,
    { ...HANDLER_JSON, unknownTool: "isError" as const },
    { ...HANDLER_JSON, toolThrow: "message" as const },
  ]) {
    const label = `${profile.entry.kind}/${profile.unknownTool}/${profile.toolThrow}`;
    const send = async (body: unknown) => {
      const { service, records } = withAuth(profile);
      const res = await service.handle(mcpRequest(body, { token: "good:u", headers: HOST }), {});
      return { rpc: (await rpcOf(res as Response)) as Record<string, unknown>, records };
    };

    test(`${label}: unknown tool`, async () => {
      const { rpc, records } = await send(call("nope", {}));
      if (profile.unknownTool === "protocolError") {
        expect(rpc.error).toEqual({ code: -32602, message: "Tool nope not found" });
      } else {
        expect(rpc.result).toEqual({
          content: [{ type: "text", text: "Tool nope not found" }],
          isError: true,
        });
      }
      expect(records[0]).toMatchObject({ stage: "rejected", errorClass: "UnknownTool" });
    });

    test(`${label}: invalid params`, async () => {
      const { rpc, records } = await send(call("echo", { text: 1 }));
      const result = rpc.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toStartWith(
        "Input validation error: Invalid arguments for tool echo:",
      );
      expect(records[0]).toMatchObject({ stage: "rejected", errorClass: "InvalidParams" });
    });

    test(`${label}: a throwing tool`, async () => {
      const { rpc, records } = await send(call("boom"));
      const text = profile.toolThrow === "generic" ? '{"error":"boom failed"}' : "kaboom";
      expect(JSON.stringify(rpc.result)).toBe(
        JSON.stringify({ content: [{ type: "text", text }], isError: true }),
      );
      expect(records[0]).toMatchObject({
        stage: "handler",
        ok: false,
        errorClass: "RangeError",
        errorMessage: "kaboom",
      });
    });

    test(`${label}: batch calls keep their own handles`, async () => {
      const { rpc, records } = await send([1, 2, 3].map((i) => call("echo", { text: `t${i}` }, i)));
      expect((rpc as unknown as unknown[]).length).toBe(3);
      expect(records.map((r) => r.resultIds).sort()).toEqual([["t1"], ["t2"], ["t3"]]);
    });
  }

  test("handler: a modern 2026-07-28 request is served too", async () => {
    const { service } = withAuth(HANDLER_JSON);
    const res = await service.handle(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        {
          token: "good:u",
          headers: { ...HOST, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
        },
      ),
      {},
    );
    const rpc = (await rpcOf(res as Response)) as {
      result?: { tools?: { name: string }[] };
      error?: unknown;
    };
    expect(rpc.error).toBeUndefined();
    expect(rpc.result?.tools?.map((t) => t.name)).toEqual(["echo", "slow", "boom"]);
  });
});

describe("step 5.11 and 6: request lines and the outer catch", () => {
  test("serve.request carries requestFields and, for an entry 4xx, its rejection", async () => {
    const { service, log } = withAuth(TRANSPORT_EMPTY, {
      hooks: { requestFields: (ctx) => ({ rid: ctx.requestId, ua: ctx.client.ua }) },
    });
    await service.handle(
      mcpRequest(call("echo", { text: "x" }), {
        token: "good:u",
        headers: { "user-agent": "ua\u0001/1" },
      }),
      { remoteAddress: "192.0.2.4" },
    );
    await service.handle(mcpRequest({ jsonrpc: "2.0", id: 1, method: 5 }, { token: "good:u" }), {});
    const lines = log.lines
      .filter(([e]) => e === "app.request")
      .map(([, f]) => ({ ...f, ms: 0 }) as Record<string, unknown>);
    expect(lines).toEqual([
      {
        method: "POST",
        sourceKey: "192.0.2.4",
        caller: "u",
        status: 200,
        ms: 0,
        rid: "req-1",
        ua: "ua /1",
      },
      {
        method: "POST",
        sourceKey: "unknown",
        caller: "u",
        status: 400,
        ms: 0,
        rid: "req-2",
        ua: null,
        rejection: "Parse error: Invalid JSON-RPC message",
      },
    ]);
  });

  test("a throw past auth is bodies.internal and serve.request_failed threw", async () => {
    const { service, log } = withAuth(HANDLER_JSON, {
      registerTools: () => {
        throw new EvalError("registration broke");
      },
      hooks: {
        aroundRequest: async () => {
          throw new EvalError("around broke");
        },
      },
    });
    const res = await service.handle(
      mcpRequest(call("echo", { text: "x" }), { token: "good:u", headers: HOST }),
      {},
    );
    expect(await snapshot(res ?? null)).toEqual({
      status: 500,
      headers: [["content-type", "application/json"]],
      body: '{"error":"internal server error"}',
    });
    expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
      reason: "threw",
      errorClass: "EvalError",
    });
  });

  test("anything else is caught whole: bodies.internal and serve.uncaught", async () => {
    const { service, log } = makeService({
      acceptCredentials: () => {
        throw new URIError("bad");
      },
    });
    const res = await service.handle(mcpRequest(call("echo")), { remoteAddress: "192.0.2.5" });
    expect(res?.status).toBe(500);
    expect(log.lines.at(-1)).toMatchObject([
      "serve.uncaught",
      { method: "POST", sourceKey: "192.0.2.5", errorClass: "URIError" },
    ]);
  });
});

describe("delegated headers", () => {
  test("kept for a listed client with the right shape; otherwise null and logged without the value", async () => {
    const { service, records, log } = withAuth(TRANSPORT_EMPTY);
    const send = (token: string, h: Record<string, string>) =>
      service.handle(mcpRequest(call("echo", { text: "x" }), { token, headers: h }), {});
    await send("good:agent", { "x-on-behalf-of": "user:abc", "x-turn-id": "s:1" });
    await send("good:agent", { "x-on-behalf-of": "User ABC" });
    await send("good:other", { "x-turn-id": "s:1" });
    expect(records.map((r) => [r.onBehalfOf, r.turnId])).toEqual([
      ["user:abc", "s:1"],
      [null, null],
      [null, null],
    ]);
    expect(
      log.lines.filter(([e]) => e === "serve.delegated_header_ignored").map(([, f]) => f),
    ).toEqual([
      { caller: "agent", header: "x-on-behalf-of", reason: "malformed" },
      { caller: "other", header: "x-turn-id", reason: "not-delegating-client" },
    ]);
  });
});

describe("build-time refusals", () => {
  test("a perTool tool toolScopes lacks", () => {
    expect(() => makeService({ limits: limits({ perTool: { ghost: bucket(1) } }) })).toThrow(
      /ghost/,
    );
  });
  test("a bad bodyLimit or a two-face host check without acceptCredentials", () => {
    expect(() =>
      makeService({
        profile: { ...TRANSPORT_EMPTY, bodyLimit: { ...TRANSPORT_EMPTY.bodyLimit, oauth: 0 } },
      }),
    ).toThrow(/bodyLimit.oauth/);
    expect(() => makeService({ profile: HANDLER_JSON })).toThrow(/needs acceptCredentials/);
  });
  test("a profile without toolThrow (pre-0.13)", () => {
    const { toolThrow: _, ...old } = TRANSPORT_EMPTY;
    expect(() => makeService({ profile: old as ServeProfile })).toThrow(
      /profile.toolThrow must be "message" or "generic"/,
    );
  });
});

/** Advances fake time in `stepMs` steps whenever a timer is waiting, until `p` settles (bounded). */
async function settle<T>(p: Promise<T>, time: FakeTime, stepMs = 50, rounds = 400): Promise<T> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < rounds && !done; i++) {
    await until(() => done || time.pending() > 0);
    // One macrotask first, so work already resolving settles before time moves.
    await new Promise<void>((r) => setImmediate(r));
    if (!done) time.advance(stepMs);
  }
  if (!done) throw new Error("settle: still pending");
  return p;
}

const usageWith = (sinks: CallSink[]): UsageWiring => ({
  sinks,
  keepArgs: false,
  keepOutput: false,
  price: () => ({ costUsd: null, costNote: null }),
  errorClassOf: () => "x",
  spend: null,
  serverSha: null,
});

describe("shutdown", () => {
  test("drains, forces, flushes every sink and the auth layer, ends the pool", async () => {
    const { service, auth, log, time } = withAuth(TRANSPORT_EMPTY);
    let pending = 2;
    const stops: (boolean | undefined)[] = [];
    const server = {
      stop: (force?: boolean) => {
        stops.push(force);
      },
      pending: () => pending,
    };
    const done = service.shutdown({
      signal: "SIGTERM",
      server,
      endPool: async (s) => {
        expect(s).toBe(1);
      },
    });
    await until(() => time.pending() > 0); // the first drain poll
    pending = 0;
    time.advance(50);
    const r = await settle(done, time);
    expect(r).toEqual({ drained: true, flushed: true, poolClosed: true });
    expect(stops).toEqual([undefined, true]);
    expect(auth.idled).toBe(1);
    expect(log.lines.at(-1)).toEqual([
      "serve.stopped",
      {
        signal: "SIGTERM",
        drained: true,
        flushed: true,
        poolClosed: true,
        poolReason: "clean",
        poolMs: 0,
        forced: "ok",
        entryClosed: "none",
        flushFailed: [],
      },
    ]);
    expect(time.pending()).toBe(0);
  });

  test("a spend write still in flight settles before the pool ends (rev 3.4)", async () => {
    const order: string[] = [];
    const gate = signal();
    let idleCalled = false;
    const spend = {
      forCaller: () => ({ assertWithin: async () => {}, record: async () => {} }),
      idle: () => {
        idleCalled = true;
        return gate.promise.then(() => {
          order.push("spend settled");
        });
      },
    };
    const { service, time, log } = makeService({ usage: { ...usageWith([]), spend } });
    const done = service.shutdown({
      signal: "SIGTERM",
      server: { stop: () => {}, pending: () => 0 },
      endPool: async () => {
        order.push("pool ended");
      },
    });
    await until(() => idleCalled);
    expect(order).toEqual([]);
    gate.resolve();
    expect(await settle(done, time)).toEqual({ drained: true, flushed: true, poolClosed: true });
    expect(order).toEqual(["spend settled", "pool ended"]);
    expect(log.lines.at(-1)?.[1]).toMatchObject({ flushFailed: [] });
  });

  test("a spend write that outlasts the flush is named in flushFailed", async () => {
    const spend = {
      forCaller: () => ({ assertWithin: async () => {}, record: async () => {} }),
      idle: () => new Promise<void>(() => {}),
    };
    const { service, time, log } = makeService({ usage: { ...usageWith([]), spend } });
    const done = service.shutdown({
      signal: "SIGTERM",
      server: { stop: () => {}, pending: () => 0 },
    });
    expect(await settle(done, time)).toMatchObject({ flushed: false });
    expect(log.lines.at(-1)?.[1]).toMatchObject({ flushFailed: ["spend:timeout"] });
  });

  test("a hanging sink and a rejecting one: the flush waits its window, auth idles, the pool still ends", async () => {
    const auth = fakeAuth();
    const { service, time, log } = makeService({
      auth,
      acceptCredentials: () => both,
      usage: usageWith([
        { record: () => {}, idle: () => new Promise(() => {}) },
        { record: () => {}, idle: () => Promise.reject(new Error("flush failed")) },
      ]),
    });
    const stops: (boolean | undefined)[] = [];
    let ended = 0;
    const done = service.shutdown({
      signal: "SIGINT",
      server: {
        stop: (force) => {
          stops.push(force);
        },
        pending: () => 1,
      },
      endPool: async () => {
        ended++;
      },
    });
    expect(await settle(done, time)).toEqual({
      drained: false,
      flushed: false,
      poolClosed: true,
    });
    expect(stops).toEqual([undefined, true]);
    expect(auth.idled).toBe(1);
    expect(ended).toBe(1);
    expect(log.lines.at(-1)?.[1]).toMatchObject({
      drained: false,
      flushed: false,
      poolReason: "clean",
    });
  });

  test("an endPool that never settles is bounded by poolEndTimeoutS: poolReason timeout", async () => {
    const { service, time, log } = makeService();
    const done = service.shutdown({
      signal: "SIGTERM",
      server: { stop: () => {}, pending: () => 0 },
      endPool: () => new Promise(() => {}),
    });
    expect(await settle(done, time)).toEqual({ drained: true, flushed: true, poolClosed: false });
    expect(log.lines.at(-1)?.[1]).toMatchObject({
      poolClosed: false,
      poolReason: "timeout",
      poolMs: 1_000,
    });
    expect(time.pending()).toBe(0);
  });

  test("a throwing logger: shutdown still resolves", async () => {
    const { service, time } = makeService({
      log: () => {
        throw new Error("log down");
      },
    });
    const done = service.shutdown({
      signal: "SIGTERM",
      server: { stop: () => {}, pending: () => 0 },
    });
    expect(await settle(done, time)).toEqual({ drained: true, flushed: true, poolClosed: false });
  });
});

describe("one end-to-end exchange with real limiters and a stub sink", () => {
  test("refusal, serving, per-tool, turn budget and the sink together", async () => {
    const lim: Limits = {
      refusal: { capacity: 2, refillPerSecond: 1, maxKeys: 100 },
      serving: { capacity: 5, refillPerSecond: 1, maxKeys: 100 },
      perTool: { echo: { capacity: 2, refillPerSecond: 1, maxKeys: 100 } },
      concurrency: {},
      turnBudget: { cap: 3, warnAt: 1, maxTurns: 10, exhausted: (n) => `stop after ${n}` },
      logIntervalMs: 1_000,
    };
    const { service, records, time, log } = withAuth(TRANSPORT_EMPTY, {
      limits: lim,
      registerTools: (server) => {
        registerSynthetic(server);
        server.registerTool("spend", { inputSchema: { n: z.number() } }, async ({ n }) => {
          currentCall().meter({ model: "m", input: n, output: 1 });
          return { content: [{ type: "text", text: `${n}` }] };
        });
      },
    });
    const info = { remoteAddress: "192.0.2.10" };
    const turn = { "x-turn-id": "turn:1" };
    const post = (body: unknown, token?: string) =>
      service.handle(mcpRequest(body, { token, headers: turn }), info);
    expect((await post(call("echo", { text: "a" })))?.status).toBe(401);
    expect(
      await rpcOf((await post(call("echo", { text: "a" }), "good:agent")) as Response),
    ).toMatchObject({ result: { content: [{ text: "a" }] } });
    expect(
      await rpcOf((await post(call("echo", { text: "b" }), "good:agent")) as Response),
    ).toMatchObject({ result: { content: [{ text: "b" }] } });
    expect(
      await rpcOf((await post(call("echo", { text: "c" }), "good:agent")) as Response),
    ).toMatchObject({ result: { isError: true } });
    expect(
      await rpcOf((await post(call("spend", { n: 4 }), "good:agent")) as Response),
    ).toMatchObject({
      result: {
        content: [
          { text: '{"turnBudget":{"remaining":0,"exhausted":true},"message":"stop after 3"}' },
        ],
      },
    });
    expect((await post(call("echo", { text: "d" }), "good:agent"))?.status).toBe(200);
    expect((await post(call("echo", { text: "e" }), "good:agent"))?.status).toBe(429);
    time.advance(10_000);
    expect((await post(call("spend", { n: 2 }), "good:other"))?.status).toBe(200);
    expect(
      records.map((r) => [r.caller, r.tool, r.stage, r.errorClass, r.turnId, r.tokens]),
    ).toEqual([
      ["agent", "echo", "handler", null, "turn:1", null],
      ["agent", "echo", "handler", null, "turn:1", null],
      ["agent", "echo", "refused", "RateLimited", "turn:1", null],
      ["agent", "spend", "refused", "TurnBudgetExhausted", "turn:1", null],
      ["agent", "echo", "refused", "TurnBudgetExhausted", "turn:1", null],
      ["other", "spend", "handler", null, null, { m: { input: 2, output: 1 } }],
    ]);
    expect(log.names()).toContain("serve.unauthorized");
  });
});
