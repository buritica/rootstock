// serve's JWKS classifier against the real verifier: defineAuth's verify
// (Better Auth's requireMcpAuth) fetching its own <baseURL>/jwks from a server
// that refuses the connection, answers an HTTP error, or never answers. The
// classifier matches Better Auth's error texts, jose's error code and Bun 1.3's
// fetch connection codes; the fake
// auth layer throws hand-made copies, so only these tests see an upstream
// patch change them (the peer range admits every 1.7.x).

import { afterAll, describe, expect, test } from "bun:test";
import { harness } from "./auth/auth.test-support.ts";
import { call, makeService, mcpRequest, TRANSPORT_TEXT } from "./service.test-support.ts";

const both = { bearer: true, oauth: true };

// Better Auth also logs each refused fetch through its own global logger
// (stderr, outside serve's log): the noise in this file's output is expected.
const quiet = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const badGateway = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
});
// Accepts the connection and never answers: jose's 5 s JWKSTimeout.
const stalled = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {}, open() {} },
});
// Accepts, then closes on the request: a reset.
const resets = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(s) {
      s.end();
    },
    open() {},
  },
});
// Bound, then closed: a refused connection. Refused and reset are Better
// Auth's "JWKS fetch failed" on Bun 1.4+, Bun's own codes on 1.3; both log the
// same line.
const refusedPort = quiet.port;
quiet.stop(true);
afterAll(() => {
  badGateway.stop(true);
  stalled.stop(true);
  resets.stop(true);
});

async function answerFor(baseURL: string) {
  const h = harness("invited", (o) => ({ ...o, baseURL }));
  const ctx = await h.layer.instance.$context;
  const api = h.layer.instance.api as unknown as {
    signJWT(o: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }>;
  };
  const { token } = await api.signJWT({
    body: {
      payload: {
        sub: "user-1",
        aud: h.layer.resource,
        azp: "client-1",
        scope: "openid mcp:tools",
        iss: ctx.baseURL,
      },
    },
  });
  const { service, log } = makeService({
    profile: TRANSPORT_TEXT,
    auth: h.layer,
    acceptCredentials: () => both,
  });
  const res = await service.handle(
    mcpRequest(call("echo", { text: "x" }), { token, headers: { host: "app.example.test" } }),
    {},
  );
  const threw = log.lines.filter(([e]) => e === "serve.auth_threw").map(([, f]) => f);
  return {
    status: res?.status,
    retryAfter: res?.headers.get("retry-after"),
    threw: threw.map((f) => [f.errorClass, f.jwks ?? false, f.authUnreachable ?? false]),
  };
}

describe("the real verifier's JWKS throws (Better Auth 1.7.17, jose 6)", () => {
  test("a refused connection is unreachable: bodies.jwksFailure", async () => {
    expect(await answerFor(`http://127.0.0.1:${refusedPort}`)).toEqual({
      status: 503,
      retryAfter: "5",
      threw: [["Error", true, true]],
    });
  });

  test("a connection reset is unreachable: bodies.jwksFailure", async () => {
    expect(await answerFor(`http://127.0.0.1:${resets.port}`)).toEqual({
      status: 503,
      retryAfter: "5",
      threw: [["Error", true, true]],
    });
  });

  test("an HTTP error from /jwks is a JWKS failure, not unreachable", async () => {
    expect(await answerFor(`http://127.0.0.1:${badGateway.port}`)).toEqual({
      status: 503,
      retryAfter: "5",
      threw: [["Error", true, false]],
    });
  });

  test("a /jwks that never answers times out at 5 s as unreachable", async () => {
    expect(await answerFor(`http://127.0.0.1:${stalled.port}`)).toEqual({
      status: 503,
      retryAfter: "5",
      threw: [["JWKSTimeout", true, true]],
    });
  }, 15_000);
});
