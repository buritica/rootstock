// F4: a request with no Host header reaches `fetch` with a bare path for its
// URL (Bun and node:http both hand one over for HTTP/1.0). It used to throw in
// `new URL(req.url)` and answer the profile's 500.

import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import type { Limits } from "./limits.ts";
import {
  fakeAuth,
  HANDLER_JSON,
  makeService,
  noLimits,
  ORIGIN,
  snapshot,
  TRANSPORT_EMPTY,
  TRANSPORT_TEXT,
} from "./service.test-support.ts";
import type { McpServiceOptions } from "./service.ts";
import type { ServeProfile } from "./types.ts";

const withAuth = (profile: ServeProfile, over: Partial<McpServiceOptions> = {}) =>
  makeService({
    profile,
    auth: fakeAuth(),
    acceptCredentials: () => ({ bearer: true, oauth: true }),
    ...over,
  });

/** A request as Bun hands one over without a Host header: `url` is the bare path. */
function hostless(path: string, init: RequestInit = {}): Request {
  const req = new Request(`${ORIGIN}${path}`, init);
  Object.defineProperty(req, "url", { value: path });
  return req;
}

const PATHS = ["/mcp", "/api/auth/token", "/.well-known/x", "/login", "/elsewhere"];
const SOURCE = { remoteAddress: "192.0.2.7" };

describe("F4: a request whose URL cannot be parsed", () => {
  test("the stand-in is what the service sees: an unparsable URL", () => {
    expect(URL.parse(hostless("/mcp").url)).toBeNull();
  });

  test("TRANSPORT_TEXT (exact, 404-text): the host check's 404 on every path, logged throttled", async () => {
    const { service, log, records } = withAuth(TRANSPORT_TEXT);
    for (const path of PATHS) {
      for (const method of ["GET", "POST", "HEAD"]) {
        const res = await service.handle(hostless(path, { method }), SOURCE);
        expect(await snapshot(res)).toEqual({ status: 404, headers: [], body: "Not Found" });
      }
    }
    expect(log.lines.filter(([e]) => e === "serve.host_refused")).toEqual([
      ["serve.host_refused", { sourceKey: "192.0.2.7", host: "", origin: "" }],
    ]);
    expect(log.names()).not.toContain("serve.uncaught");
    expect(records).toEqual([]);
  });

  test("HANDLER_JSON (hostname, sdk-403, two faces): the SDK's 403 on either face", async () => {
    for (const bearer of [true, false]) {
      const { service, log } = withAuth(HANDLER_JSON, {
        acceptCredentials: () => ({ bearer, oauth: true }),
      });
      for (const path of PATHS) {
        const res = await service.handle(hostless(path, { method: "POST" }), SOURCE);
        expect(await snapshot(res)).toEqual({
          status: 403,
          headers: [["content-type", "application/json"]],
          body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Missing Host header"},"id":null}',
        });
      }
      expect(log.names().filter((e) => e === "serve.host_refused")).toHaveLength(1);
      expect(log.names()).not.toContain("serve.uncaught");
    }
  });

  test("sdk-403 keeps the SDK's text for the Host header it was given", async () => {
    const { service } = withAuth(HANDLER_JSON);
    const req = hostless("/mcp", { headers: { host: "bad host" } });
    expect(await (await service.handle(req, SOURCE))?.text()).toContain(
      "Invalid Host header: bad host",
    );
  });

  test("TRANSPORT_EMPTY (no host check): the profile's 404, refusal bucket charged as step 4", async () => {
    const limits: Limits = {
      ...noLimits(),
      refusal: { capacity: 1, refillPerSecond: 1, maxKeys: 10 },
    };
    const { service, log } = withAuth(TRANSPORT_EMPTY, { limits });
    expect(
      await snapshot(await service.handle(hostless("/mcp", { method: "POST" }), SOURCE)),
    ).toEqual({ status: 404, headers: [["cache-control", "no-store"]], body: "" });
    expect((await service.handle(hostless("/mcp"), SOURCE))?.status).toBe(429);
    expect(log.names()).not.toContain("serve.uncaught");
    expect(log.names()).not.toContain("serve.host_refused");
  });

  test("no host check and passUnknown: still the 404, never handed on", async () => {
    const { service } = withAuth({ ...HANDLER_JSON, hostCheck: false });
    const res = await service.handle(hostless("/mcp"), SOURCE);
    expect(await snapshot(res)).toEqual({
      status: 404,
      headers: [["content-type", "application/json"]],
      body: '{"error":"not found"}',
    });
  });

  test("over a real Bun listener: HTTP/1.0 with no Host answers the host check's 404", async () => {
    const { service } = withAuth(TRANSPORT_TEXT);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => (await service.handle(req, {})) ?? new Response(null, { status: 418 }),
    });
    const port = server.port;
    if (port === undefined) throw new Error("the listener has no port");
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        let out = "";
        const sock = connect(port, "127.0.0.1", () => {
          sock.write("POST /mcp HTTP/1.0\r\ncontent-length: 0\r\n\r\n");
        });
        sock.on("data", (d) => {
          out += String(d);
        });
        sock.on("end", () => resolve(out));
        sock.on("error", reject);
      });
      expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
      expect(raw.endsWith("\r\n\r\nNot Found")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
