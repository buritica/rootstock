// The review-gate failure paths of createMcpService: entry faults, JWKS texts,
// faults past authentication, scope resolution, delegated headers, logging.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Limits } from "./limits.ts";
import {
  call,
  fakeAuth,
  HANDLER_JSON,
  makeService,
  mcpRequest,
  noLimits,
  registerSynthetic,
  rpcOf,
  snapshot,
  TRANSPORT_EMPTY,
  TRANSPORT_TEXT,
} from "./service.test-support.ts";
import type { McpServiceOptions } from "./service.ts";
import type { Caller, ServeProfile } from "./types.ts";

const HOST = { host: "app.example.test" };
const both = { bearer: true, oauth: true };
const withAuth = (profile: ServeProfile, over: Partial<McpServiceOptions> = {}) => {
  const auth = fakeAuth();
  return { auth, ...makeService({ profile, auth, acceptCredentials: () => both, ...over }) };
};
const limits = (over: Partial<Limits>): Limits => ({ ...noLimits(), ...over });
const bucket = (capacity: number) => ({ capacity, refillPerSecond: 1, maxKeys: 100 });
const echo = (token: string, headers: Record<string, string> = HOST) =>
  mcpRequest(call("echo", { text: "x" }), { token, headers });

describe("the handler entry's legacy leg", () => {
  const JSON_500 = {
    status: 500,
    headers: [["content-type", "application/json"]] as [string, string][],
    body: '{"error":"internal server error"}',
  };

  test("a registerTools throw on a 2025-era request is bodies.internal and serve.request_failed", async () => {
    const { service, log } = withAuth(HANDLER_JSON, {
      registerTools: () => {
        throw new RangeError("tools failed to load");
      },
    });
    const res = await service.handle(echo("good:u"), {});
    expect(await snapshot(res)).toEqual(JSON_500);
    expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
      reason: "threw",
      errorClass: "RangeError",
      caller: "u",
      status: 500,
    });
    expect(log.names()).not.toContain("serve.request");
  });

  test("an onRegister throw answers the same way", async () => {
    const { service, log } = withAuth(HANDLER_JSON, {
      hooks: {
        onRegister: () => {
          throw new SyntaxError("hook failed");
        },
      },
    });
    expect(await snapshot(await service.handle(echo("good:u"), {}))).toEqual(JSON_500);
    expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
      errorClass: "SyntaxError",
    });
  });
});

describe("JWKS failure texts", () => {
  // Better Auth's verify throws these three. The contract classifies the first
  // two as JWKS failures; the network-error text is not one, because a
  // consumer answers it with its generic 500 today.
  test('"Jwks failed: …" and "No jwks found" are jwks; "JWKS fetch failed" is bodies.internal', async () => {
    const { service, log } = withAuth(TRANSPORT_TEXT);
    const statuses: number[] = [];
    for (const token of ["jwks", "nojwks", "jwksnet"]) {
      statuses.push((await service.handle(echo(token), {}))?.status ?? 0);
    }
    expect(statuses).toEqual([503, 503, 500]);
    expect(
      log.lines.filter(([e]) => e === "serve.auth_threw").map(([, f]) => f.jwks ?? false),
    ).toEqual([true, true, false]);
  });
});

describe("faults past authentication", () => {
  test("a randomId throw is serve.request_failed, not auth_threw, and spends no refusal token", async () => {
    const { service, log } = withAuth(TRANSPORT_TEXT, {
      limits: limits({ refusal: bucket(1) }),
      randomId: () => {
        throw new TypeError("no entropy");
      },
    });
    expect((await service.handle(echo("good:u"), {}))?.status).toBe(500);
    expect(log.names()).not.toContain("serve.auth_threw");
    expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
      reason: "threw",
      errorClass: "TypeError",
    });
    // The bucket of one still holds its token: a refusal now spends it, the next is 429.
    expect((await service.handle(echo("deny"), {}))?.status).toBe(403);
    expect((await service.handle(echo("good:u"), {}))?.status).toBe(429);
  });

  test("a 403 from aroundRequest is the request's answer, not an auth refusal", async () => {
    const { service, log } = withAuth(TRANSPORT_TEXT, {
      limits: limits({ refusal: bucket(1) }),
      hooks: { aroundRequest: async () => new Response(null, { status: 403 }) as never },
    });
    expect((await service.handle(echo("good:u"), {}))?.status).toBe(403);
    expect((await service.handle(echo("good:u"), {}))?.status).toBe(403);
    expect(log.names()).not.toContain("serve.unauthorized");
  });
});

describe("resolveScopes", () => {
  for (const [what, answer] of [
    ["not an array", "profile"],
    ["an array with a non-string", ["profile", 7]],
    ["undefined", undefined],
  ] as const) {
    test(`an answer that is ${what} falls back to oauthScopes and logs`, async () => {
      const seen: string[][] = [];
      const { service, log } = withAuth(TRANSPORT_EMPTY, {
        resolveScopes: async () => answer as never,
        registerTools: (server: McpServer, ctx: { caller: Caller }) => {
          seen.push([...ctx.caller.scopes].sort());
          registerSynthetic(server);
        },
      });
      expect((await service.handle(echo("good:u", {}), {}))?.status).toBe(200);
      expect(seen).toEqual([["mcp:tools"]]);
      expect(log.lines.find(([e]) => e === "serve.scope_resolve_failed")?.[1]).toEqual({
        caller: "u",
        errorClass: "NotAStringArray",
      });
    });
  }
});

describe("delegated headers", () => {
  const delegated = TRANSPORT_EMPTY.delegated as Exclude<ServeProfile["delegated"], false>;
  for (const [what, shape] of [
    ["a g flag", /^user:[a-z]+$/g],
    ["a y flag", /^user:[a-z]+$/y],
    ["no ^ anchor", /user:[a-z]+$/],
    ["no $ anchor", /^user:[a-z]+/],
  ] as const) {
    test(`a shape with ${what} is refused at build`, () => {
      expect(() =>
        makeService({
          profile: {
            ...TRANSPORT_EMPTY,
            delegated: { ...delegated, onBehalfOf: { ...delegated.onBehalfOf, shape } },
          },
        }),
      ).toThrow(/must be anchored/);
    });
  }

  test("x-on-behalf-of is ignored from a client not listed, and from a static token named like one", async () => {
    const agent: Caller = { name: "agent", kind: "bearer", scopes: new Set(["mcp:tools"]) };
    const { service, records, log } = withAuth(TRANSPORT_EMPTY, {
      credentials: (r) => (r.headers.get("authorization") === "Bearer static" ? agent : undefined),
    });
    const spoof = { "x-on-behalf-of": "user:victim" };
    await service.handle(echo("good:other", spoof), {});
    await service.handle(echo("static", spoof), {});
    await service.handle(echo("good:agent", spoof), {});
    expect(records.map((r) => [r.caller, r.onBehalfOf])).toEqual([
      ["other", null],
      ["agent", null],
      ["agent", "user:victim"],
    ]);
    expect(
      log.lines.filter(([e]) => e === "serve.delegated_header_ignored").map(([, f]) => f),
    ).toEqual([
      { caller: "other", header: "x-on-behalf-of", reason: "not-delegating-client" },
      { caller: "agent", header: "x-on-behalf-of", reason: "not-delegating-client" },
    ]);
  });
});

describe("a throwing logger", () => {
  test("every answer is unchanged and every sink still records", async () => {
    const { service, records } = withAuth(TRANSPORT_EMPTY, {
      limits: limits({ refusal: bucket(5) }),
      log: () => {
        throw new Error("log down");
      },
    });
    expect((await service.handle(echo("good:u", {}), {}))?.status).toBe(200);
    expect((await service.handle(echo("deny", {}), {}))?.status).toBe(403);
    expect((await service.handle(echo("jwks", {}), {}))?.status).toBe(500);
    expect(records.map((r) => r.tool)).toEqual(["echo"]);
  });
});

describe("the public face of the auth layer", () => {
  test("a credentials Response is returned as is and spends no refusal token", async () => {
    const { service } = withAuth(TRANSPORT_TEXT, {
      limits: limits({ refusal: bucket(1) }),
      credentials: (r) =>
        r.headers.get("authorization") === "Bearer wrong"
          ? new Response(null, { status: 401 })
          : undefined,
    });
    for (let i = 0; i < 3; i++) expect((await service.handle(echo("wrong"), {}))?.status).toBe(401);
    expect(await rpcOf((await service.handle(echo("good:u"), {})) as Response)).toMatchObject({
      result: { content: [{ text: "x" }] },
    });
  });
});
