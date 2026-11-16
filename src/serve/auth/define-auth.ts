// `defineAuth`: one Better Auth instance configured for an MCP resource
// server, and the layer `serve` routes through. Every option is checked
// before Better Auth is built (config.ts); §6.2 of the W5 contract lists what
// is always set.

import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { jwt, magicLink } from "better-auth/plugins";
import type { LogEvent } from "../types.ts";
import {
  authConfigError,
  checkAuthSecret,
  checkOptions,
  MCP_TOOLS_SCOPE,
  resolveBase,
} from "./config.ts";
import { createMagicLinkSender } from "./magic-link.ts";
import { isAllowedRedirectUri } from "./redirects.ts";
import type { AuthLayer, AuthOptions, BetterAuthInstance } from "./types.ts";

const HTML = "text/html; charset=utf-8";
// The 429 line is written at most once per client and path per window, with
// the count it held back; the key set is cleared when it overflows, because
// the path is the caller's choice.
const RATE_LIMIT_LOG_WINDOW_MS = 60_000;
const RATE_LIMIT_LOG_MAX_KEYS = 1_000;

function createRateLimitLog(o: Pick<AuthOptions, "clock">, emit: LogEvent) {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return (path: string, client: string | null, retryAfter: string | null): void => {
    const t = o.clock.now();
    const key = `${client ?? ""}|${path}`;
    const last = seen.get(key);
    if (last !== undefined && t - last.at >= 0 && t - last.at < RATE_LIMIT_LOG_WINDOW_MS) {
      last.suppressed += 1;
      return;
    }
    if (last === undefined && seen.size >= RATE_LIMIT_LOG_MAX_KEYS) seen.clear();
    seen.set(key, { at: t, suppressed: 0 });
    emit("auth.rate_limited", { path, client, retryAfter, suppressed: last?.suppressed ?? 0 });
  };
}

/** Builds the auth layer. Refuses (ERR_ROOTSTOCK_AUTH_CONFIG) any option outside the contract. */
export function defineAuth(o: AuthOptions): AuthLayer {
  if (o === null || typeof o !== "object")
    throw authConfigError("defineAuth", "options are required");
  const base = resolveBase(o.baseURL, o.baseUrlRule);
  const secret = checkAuthSecret(o.secret);
  const checked = checkOptions(o);
  const emit: LogEvent = (event, fields) => {
    try {
      o.log(event, fields);
    } catch {
      // A failing logger never changes an auth answer.
    }
  };

  const { dcr } = o.registration;
  const redirectHosts = checked.redirectHosts;
  const plugins: NonNullable<BetterAuthOptions["plugins"]> = [
    jwt(),
    mcp({
      resource: base.resource,
      loginPage: "/login",
      consentPage: "/consent",
      scopes: [...checked.scopes],
      allowDynamicClientRegistration: dcr,
      allowUnauthenticatedClientRegistration: dcr,
      ...(o.clientPrivileges === "deny" ? { clientPrivileges: () => false } : {}),
      // Better Auth's own registered-URI match, narrowed and never widened.
      ...(redirectHosts !== null
        ? {
            validateRedirectUri: (uri: string, _registered: unknown, defaultResult: boolean) =>
              defaultResult && isAllowedRedirectUri(uri, redirectHosts),
          }
        : {}),
    }),
    // The package's DNS-pinning, SSRF-safe fetch, never a plain fetch wrapper.
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ];
  const signIn = o.signIn;
  if (signIn.kind === "magicLink") {
    const send = createMagicLinkSender(signIn, checked.owners, { clock: o.clock, log: emit });
    plugins.push(magicLink({ disableSignUp: true, sendMagicLink: send }));
  }

  const options: BetterAuthOptions = {
    database: o.database as BetterAuthOptions["database"],
    baseURL: base.baseURL,
    secret,
    rateLimit: {
      // Never NODE_ENV-dependent: Better Auth leaves it off outside production otherwise.
      enabled: true,
      storage: "memory",
      window: o.rateLimit.window,
      max: o.rateLimit.max,
      customRules: { ...checked.customRules },
    },
    advanced: { ipAddress: { ipAddressHeaders: [...checked.ipAddressHeaders] } },
    ...(signIn.kind === "social"
      ? {
          socialProviders: {
            [signIn.provider]: {
              clientId: signIn.clientId,
              clientSecret: signIn.clientSecret,
              hd: signIn.hd,
            },
          },
        }
      : {}),
    plugins,
  };
  const instance = betterAuth(options) as unknown as BetterAuthInstance;

  const logRateLimited = createRateLimitLog(o, emit);
  const clientOf = (headers: Headers): string | null => {
    for (const name of checked.ipAddressHeaders) {
      const value = headers.get(name);
      if (value !== null) return value.slice(0, 64);
    }
    return null;
  };
  const authHeaderEntries = Object.entries(checked.authHeaders);
  const pageHeaderEntries = Object.entries(checked.pageHeaders);

  return Object.freeze({
    resource: base.resource,
    publicHostname: base.publicHostname,
    instance,

    async handle(req: Request): Promise<Response> {
      let res = await instance.handler(req);
      if (authHeaderEntries.length > 0) {
        // A header Better Auth set wins, as it does through node's setHeader.
        const headers = new Headers(res.headers);
        for (const [name, value] of authHeaderEntries) {
          if (!headers.has(name)) headers.set(name, value);
        }
        res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      if (res.status === 429) {
        logRateLimited(
          new URL(req.url).pathname.slice(0, 100),
          clientOf(req.headers),
          res.headers.get("x-retry-after"),
        );
      }
      return res;
    },

    page(path: "/login" | "/consent", url: URL): Response {
      let html: string;
      if (path === "/login") html = o.pages.login();
      else if (path === "/consent") html = o.pages.consent(url.search.slice(1));
      else throw authConfigError("page", `path must be "/login" or "/consent" — got ${path}`);
      const headers = new Headers(pageHeaderEntries);
      headers.set("content-type", HTML);
      return new Response(html, { status: 200, headers });
    },

    asset(path: string): Response | null {
      if (!Object.hasOwn(o.assets, path)) return null;
      const asset = o.assets[path];
      if (asset === undefined) return null;
      return new Response(asset.body(), { status: 200, headers: { ...asset.headers } });
    },

    verify(req, next) {
      return requireMcpAuth(instance, (request, claims) => next(request, claims), {
        resource: base.resource,
        requiredScopes: [MCP_TOOLS_SCOPE],
      })(req);
    },

    async assertStoreReady(): Promise<void> {
      // `$context` resolves even when the provider's startup seed failed, so
      // read the resource row back: a down or unmigrated store throws here,
      // and one that answers without the row is refused.
      const ctx = await instance.$context;
      const row = await ctx.adapter.findOne({
        model: "oauthResource",
        where: [{ field: "identifier", value: base.resource }],
      });
      if (!row) {
        throw authConfigError(
          "assertStoreReady",
          `the auth store answered but holds no oauth resource row for ${base.resource}; the startup seed did not land`,
        );
      }
    },

    wrapNodeAuthResponse(res, path, client) {
      for (const [name, value] of authHeaderEntries) res.setHeader(name, value);
      res.on("finish", () => {
        if (res.statusCode === 429) logRateLimited(path.slice(0, 100), client.slice(0, 64), null);
      });
    },
  } satisfies AuthLayer);
}
