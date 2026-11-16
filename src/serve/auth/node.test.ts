import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "better-auth/node";
import { ANTI_FRAMING, harness, IP_HEADER } from "./auth.test-support.ts";

// A node server that serves Better Auth itself, as the contract's §6.4 has it:
// the helper first, then Better Auth's own `toNodeHandler`.
// authHeaders also names content-type, which Better Auth sets itself and must keep.
const h = harness("owner", (o) => ({
  ...o,
  authHeaders: { ...ANTI_FRAMING, "content-type": "text/plain" },
  rateLimit: {
    ...o.rateLimit,
    rules: { ...o.rateLimit.rules, "/sign-out": { window: 600, max: 1 } },
  },
}));
const authRoutes = toNodeHandler(h.layer.instance);
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://placeholder").pathname;
  const ip = req.headers[IP_HEADER];
  h.layer.wrapNodeAuthResponse(res, path, typeof ip === "string" ? ip : "private");
  void authRoutes(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// node:http's client keeps each Set-Cookie line apart, which fetch would fold.
function signOut(): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/auth/sign-out",
        headers: {
          "content-type": "application/json",
          origin: "https://app.example.test",
          cookie: "__Secure-better-auth.session_token=x",
          [IP_HEADER]: "203.0.113.9",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}

test("wrapNodeAuthResponse keeps several Set-Cookie headers through toNodeHandler and adds authHeaders", async () => {
  const res = await signOut();
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] ?? [];
  expect(cookies.length).toBeGreaterThanOrEqual(3);
  expect(cookies.every((c) => c.includes("Max-Age=0"))).toBe(true);
  for (const [name, value] of Object.entries(ANTI_FRAMING)) expect(res.headers[name]).toBe(value);
  expect(res.headers["content-type"]).toBe("application/json");
});

test("a 429 written by Better Auth is logged once, with the path and client given", async () => {
  const res = await signOut();
  expect(res.status).toBe(429);
  for (const [name, value] of Object.entries(ANTI_FRAMING)) expect(res.headers[name]).toBe(value);
  await signOut();
  expect(h.logs.filter((l) => l.event === "auth.rate_limited")).toEqual([
    {
      event: "auth.rate_limited",
      fields: {
        path: "/api/auth/sign-out",
        client: "203.0.113.9",
        retryAfter: null,
        suppressed: 0,
      },
    },
  ]);
});

test("a 429 response cut short logs on close, and finish plus close log once", () => {
  const fresh = harness("owner");
  const response = () =>
    Object.assign(new EventEmitter(), { statusCode: 429, setHeader: () => undefined });
  const aborted = response();
  fresh.layer.wrapNodeAuthResponse(aborted, "/api/auth/a", "203.0.113.20");
  aborted.emit("close");
  const written = response();
  fresh.layer.wrapNodeAuthResponse(written, "/api/auth/b", "203.0.113.20");
  written.emit("finish");
  written.emit("close");
  expect(fresh.logs.map((l) => l.fields.path)).toEqual(["/api/auth/a", "/api/auth/b"]);
});
