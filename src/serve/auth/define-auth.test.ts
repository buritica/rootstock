import { afterAll, describe, expect, test } from "bun:test";
import {
  ANTI_FRAMING,
  authRequest,
  BASE,
  harness,
  IP_HEADER,
  jsonPost,
  type Shape,
} from "./auth.test-support.ts";
import type { AuthLayer } from "./types.ts";

type Plugin = { id: string; options?: Record<string, unknown> };
const pluginsOf = (layer: AuthLayer): Plugin[] =>
  (layer.instance.options.plugins ?? []) as unknown as Plugin[];
const providerOptions = (layer: AuthLayer): Record<string, unknown> => {
  const p = pluginsOf(layer).find((x) => x.id === "oauth-provider");
  if (p?.options === undefined) throw new Error("no oauth-provider plugin");
  return p.options;
};
const OIDC = ["openid", "profile", "email", "offline_access", "mcp:tools"];

describe("the instance's options read back per profile shape (§6.2)", () => {
  test("owner: origin base, owner magic link, no DCR, privileges unset, listed redirects", () => {
    const { layer } = harness("owner");
    const o = layer.instance.options;
    expect(o.baseURL).toBe(BASE);
    expect(layer.resource).toBe(`${BASE}/mcp`);
    expect(layer.publicHostname).toBe("app.example.test");
    expect(pluginsOf(layer).map((p) => p.id)).toEqual([
      "jwt",
      "oauth-provider",
      "cimd",
      "magic-link",
    ]);
    expect(o.rateLimit).toEqual({
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/magic-link": { window: 600, max: 5 },
        "/oauth2/register": { window: 3600, max: 10 },
        "/jwks": false,
      },
    });
    expect(o.advanced).toEqual({ ipAddress: { ipAddressHeaders: [IP_HEADER] } });
    expect(o.socialProviders).toBeUndefined();
    const p = providerOptions(layer);
    expect(p.scopes).toEqual(OIDC);
    expect(p.loginPage).toBe("/login");
    expect(p.consentPage).toBe("/consent");
    expect(p.resources).toEqual([`${BASE}/mcp`]);
    expect(p.allowDynamicClientRegistration).toBe(false);
    expect(p.allowUnauthenticatedClientRegistration).toBe(false);
    expect(p.clientPrivileges).toBeUndefined();
    expect(typeof p.validateRedirectUri).toBe("function");
    const magic = pluginsOf(layer).find((x) => x.id === "magic-link")?.options;
    expect(magic?.disableSignUp).toBe(true);
    expect(typeof magic?.sendMagicLink).toBe("function");
  });

  test("social: raw base for Better Auth, google with hd, privileges denied, any redirect", async () => {
    const { layer } = harness("social");
    const o = layer.instance.options;
    expect(o.baseURL).toBe(`${BASE}/`);
    expect(layer.resource).toBe(`${BASE}/mcp`);
    expect(pluginsOf(layer).map((p) => p.id)).toEqual(["jwt", "oauth-provider", "cimd"]);
    expect(o.socialProviders).toEqual({
      google: { clientId: "client-id", clientSecret: "client-secret-value", hd: "example.test" },
    });
    expect(o.rateLimit?.customRules).toEqual({
      "/sign-in/social": { window: 60, max: 10 },
      "/callback/*": { window: 60, max: 30 },
      "/oauth2/token": { window: 60, max: 300 },
      "/jwks": false,
    });
    const p = providerOptions(layer);
    expect(p.scopes).toEqual([...OIDC, "mcp:extra"]);
    expect(p.allowDynamicClientRegistration).toBe(false);
    expect(p.validateRedirectUri).toBeUndefined();
    const deny = p.clientPrivileges as () => unknown;
    expect(deny()).toBe(false);
  });

  test("invited: as-is base, invited magic link, open DCR, listed redirects", () => {
    const { layer } = harness("invited");
    const p = providerOptions(layer);
    expect(layer.instance.options.baseURL).toBe(BASE);
    expect(p.allowDynamicClientRegistration).toBe(true);
    expect(p.allowUnauthenticatedClientRegistration).toBe(true);
    expect(p.clientPrivileges).toBeUndefined();
    expect(typeof p.validateRedirectUri).toBe("function");
  });

  test.each<Shape>(["owner", "social", "invited"])(
    "%s: discovery advertises CIMD and the configured scopes",
    async (shape) => {
      const { layer } = harness(shape);
      const res = await layer.handle(
        new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`),
      );
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.client_id_metadata_document_supported).toBe(true);
      expect(doc.scopes_supported).toEqual(providerOptions(layer).scopes);
      expect("registration_endpoint" in doc).toBe(shape === "invited");
    },
  );
});

describe("listed redirects are refused at authorize", () => {
  const uris = [
    "https://client.example.test/cb",
    "https://other.example.test/cb",
    "myapp://client.example.test/cb",
    "http://127.0.0.1:3000/cb",
    "http://localhost:3000/cb",
  ];

  async function authorize(layer: AuthLayer, clientId: string, redirectUri: string) {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid mcp:tools",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "s",
    });
    const res = await layer.handle(authRequest(`/oauth2/authorize?${q}`));
    expect(res.status).toBe(302);
    return res.headers.get("location") ?? "";
  }

  test("unlisted host, custom scheme and unlisted loopback, even when registered", async () => {
    const { layer } = harness("invited");
    // Registered through open DCR, so Better Auth's own match accepts every URI.
    const reg = await layer.handle(
      jsonPost("/oauth2/register", {
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        application_type: "native",
        client_name: "synthetic",
      }),
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const refused = `${BASE}/api/auth/error?error=invalid_redirect&error_description=invalid+redirect+uri`;
    expect(await authorize(layer, client_id, "https://other.example.test/cb")).toBe(refused);
    expect(await authorize(layer, client_id, "myapp://client.example.test/cb")).toBe(refused);
    expect(await authorize(layer, client_id, "http://localhost:3000/cb")).toBe(refused);
    // Listed: passed on to sign-in.
    expect(await authorize(layer, client_id, "https://client.example.test/cb")).toStartWith(
      "/login?",
    );
    expect(await authorize(layer, client_id, "http://127.0.0.1:3000/cb")).toStartWith("/login?");
  });

  test("registration stays closed without dcr", async () => {
    const { layer } = harness("owner");
    const res = await layer.handle(
      jsonPost("/oauth2/register", {
        redirect_uris: [uris[0]],
        token_endpoint_auth_method: "none",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("Better Auth's limiter", () => {
  test("/jwks is exempt at 1.7.17 while other paths are limited", async () => {
    const { layer, logs } = harness("invited", (o) => ({
      ...o,
      rateLimit: { window: 60, max: 2, rules: {} },
    }));
    for (let i = 0; i < 6; i++) {
      expect((await layer.handle(authRequest("/jwks"))).status).toBe(200);
    }
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await layer.handle(authRequest("/ok", { headers: { [IP_HEADER]: "192.0.2.7" } }))).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    // One line per client and path per window, the held-back count carried on the next.
    const lines = logs.filter((l) => l.event === "auth.rate_limited");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      path: "/api/auth/ok",
      client: "192.0.2.7",
      suppressed: 0,
    });
    expect(typeof lines[0]?.fields.retryAfter).toBe("string");
  });

  test("the 429 log is throttled per client and path, and carries the suppressed count", async () => {
    const { layer, logs, clock } = harness("invited", (o) => ({
      ...o,
      rateLimit: { window: 600, max: 1, rules: {} },
    }));
    const hit = () => layer.handle(authRequest("/ok", { headers: { [IP_HEADER]: "192.0.2.8" } }));
    await hit();
    await hit();
    await hit();
    clock.t += 60_000;
    await hit();
    const lines = logs
      .filter((l) => l.event === "auth.rate_limited")
      .map((l) => l.fields.suppressed);
    expect(lines).toEqual([0, 1]);
  });
});

describe("headers per profile on pages and auth responses", () => {
  test.each<[Shape, Record<string, string>, Record<string, string>]>([
    ["owner", ANTI_FRAMING, ANTI_FRAMING],
    ["social", { "cache-control": "no-store" }, {}],
    ["invited", {}, {}],
  ])("%s", async (shape, pageHeaders, authHeaders) => {
    const { layer } = harness(shape);
    const login = layer.page("/login", new URL(`${BASE}/login`));
    expect(login.status).toBe(200);
    expect(Object.fromEntries(login.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      ...pageHeaders,
    });
    expect(await login.text()).toBe("<p>sign in</p>");
    const consent = layer.page("/consent", new URL(`${BASE}/consent?client_id=a&scope=b`));
    expect(await consent.text()).toBe(`<p>consent ${"client_id=a&scope=b".length}</p>`);
    expect(Object.fromEntries(consent.headers)).toEqual(Object.fromEntries(login.headers));

    const auth = await layer.handle(authRequest("/jwks"));
    expect(Object.fromEntries(auth.headers)).toEqual({
      "content-type": "application/json",
      ...authHeaders,
    });
  });

  test("auth headers keep every Set-Cookie Better Auth sends", async () => {
    const { layer } = harness("owner");
    const res = await layer.handle(
      jsonPost("/sign-out", {}, { cookie: "__Secure-better-auth.session_token=x" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().length).toBeGreaterThanOrEqual(3);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("a header Better Auth sets itself wins over authHeaders", async () => {
    const { layer } = harness("owner", (o) => ({
      ...o,
      authHeaders: { ...ANTI_FRAMING, "content-type": "text/plain" },
    }));
    const res = await layer.handle(authRequest("/jwks"));
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("assets answer by exact path, unchanged; anything else is null", async () => {
    const { layer } = harness("invited");
    const res = layer.asset("/assets/face.woff2");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("font/woff2");
    expect(res?.headers.get("cache-control")).toBe("public, max-age=60");
    expect(new Uint8Array(await (res as Response).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(layer.asset("/assets/other.woff2")).toBeNull();
    expect(layer.asset("/toString")).toBeNull();
  });
});

describe("assertStoreReady", () => {
  test("resolves when the store holds the resource row", async () => {
    const { layer } = harness("owner");
    await layer.assertStoreReady();
  });

  test("refuses a store that answers without the row", async () => {
    const { layer, db } = harness("owner");
    await layer.assertStoreReady();
    db.oauthResource?.splice(0);
    await expect(layer.assertStoreReady()).rejects.toMatchObject({
      code: "ERR_ROOTSTOCK_AUTH_CONFIG",
    });
  });

  test("rejects when the store cannot answer", async () => {
    const { layer, db } = harness("owner");
    delete db.oauthResource;
    const err = (await layer.assertStoreReady().catch((e: unknown) => e)) as Error & {
      code?: string;
    };
    expect(err.code).toBe("ERR_ROOTSTOCK_AUTH_CONFIG");
    expect(err.cause).toBeInstanceOf(Error);
    // The driver's text (here the adapter's model name) stays on `cause`.
    expect(err.message).not.toContain("oauthResource");
  });
});

describe("assertStoreReady's message", () => {
  test("names the cause's class and SQLSTATE, never its text", async () => {
    const { layer } = harness("owner");
    const ctx = await layer.instance.$context;
    ctx.adapter.findOne = async () => {
      throw Object.assign(new TypeError("password authentication failed for db.internal.test"), {
        code: "28P01",
      });
    };
    const err = (await layer.assertStoreReady().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("(TypeError 28P01)");
    expect(err.message).not.toContain("password");
    expect(err.message).not.toContain("internal.test");
  });

  test("leaves out a code that is not SQLSTATE-shaped", async () => {
    const { layer } = harness("owner");
    const ctx = await layer.instance.$context;
    ctx.adapter.findOne = async () => {
      throw Object.assign(new Error("x"), { code: "ECONNREFUSED 10.0.0.1" });
    };
    const err = (await layer.assertStoreReady().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("(Error)");
    expect(err.message).not.toContain("ECONNREFUSED");
  });
});

describe("verify", () => {
  let layer: AuthLayer | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (layer as AuthLayer).handle(req),
  });
  afterAll(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const h = harness("invited", (o) => ({ ...o, baseURL: base }));
  layer = h.layer;

  async function token(scope: string): Promise<string> {
    const ctx = await h.layer.instance.$context;
    const api = h.layer.instance.api as unknown as {
      signJWT(o: { body: { payload: Record<string, unknown> } }): Promise<{ token: string }>;
    };
    const payload = {
      sub: "user-1",
      aud: h.layer.resource,
      azp: "client-1",
      scope,
      iss: ctx.baseURL,
    };
    return (await api.signJWT({ body: { payload } })).token;
  }
  const mcp = (bearer?: string) =>
    new Request(`${base}/mcp`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});

  test("a token carrying mcp:tools reaches next with its claims", async () => {
    const res = await h.layer.verify(mcp(await token("openid mcp:tools")), async (_req, claims) =>
      Response.json({ sub: claims.sub, aud: claims.aud }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sub: "user-1", aud: `${base}/mcp` });
  });

  test("no token: Better Auth's 401 challenge, naming mcp:tools", async () => {
    let called = false;
    const res = await h.layer.verify(mcp(), async () => {
      called = true;
      return new Response();
    });
    expect(called).toBe(false);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('scope="mcp:tools"');
  });

  test("a token without mcp:tools: 403 insufficient_scope", async () => {
    const res = await h.layer.verify(mcp(await token("openid")), async () => new Response());
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("insufficient_scope");
  });
});
