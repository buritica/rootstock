// `defineAuth`: one Better Auth instance configured for an MCP resource
// server, and the layer `serve` routes through. Every option is checked
// before Better Auth is built (config.ts); §6.2 of the W5 contract lists what
// is always set.

import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { jwt, magicLink } from "better-auth/plugins";
import type { Clock, LogEvent } from "../types.ts";
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
/** The Client ID Metadata Document profile MCP 2026-07-28 pins (draft-00). */
const CIMD_PROFILE = "mcp-2026-07-28";
// The 429 line is written at most once per client and path per window, with
// the count it held back; the key set is cleared when it overflows, because
// the path is the caller's choice.
const RATE_LIMIT_LOG_WINDOW_MS = 60_000;
const RATE_LIMIT_LOG_MAX_KEYS = 1_000;

function createRateLimitLog(clock: Clock, emit: LogEvent) {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return (path: string, client: string | null, retryAfter: string | null): void => {
    const t = clock.now();
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
  const checked = checkOptions(o);
  const base = resolveBase(o.baseURL, o.baseUrlRule);
  const secret = checkAuthSecret(o.secret);
  const emit: LogEvent = (event, fields) => {
    try {
      o.log(event, fields);
    } catch {
      // A failing logger never changes an auth answer.
    }
  };

  const { dcr } = o.registration;
  const { redirectHosts } = checked;
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
    cimd({ fetchClientMetadataResource, metadataProfile: CIMD_PROFILE }),
  ];
  if (o.signIn.kind === "magicLink") {
    const send = createMagicLinkSender(o.signIn, checked.owners, { clock: o.clock, log: emit });
    plugins.push(magicLink({ disableSignUp: true, sendMagicLink: send }));
  }

  const options: BetterAuthOptions = {
    database: o.database as BetterAuthOptions["database"],
    baseURL: base.baseURL,
    secret,
    rateLimit: {
      // Never NODE_ENV-dependent: Better Auth leaves it off outside production otherwise.
      enabled: true,
      // One map per process (shared by every instance in it): counts are per
      // process and reset on restart, which suits one container.
      storage: "memory",
      window: o.rateLimit.window,
      max: o.rateLimit.max,
      customRules: { ...checked.customRules },
    },
    advanced: { ipAddress: { ipAddressHeaders: [...checked.ipAddressHeaders] } },
    ...(o.signIn.kind === "social"
      ? {
          socialProviders: {
            [o.signIn.provider]: {
              clientId: o.signIn.clientId,
              clientSecret: o.signIn.clientSecret,
              hd: o.signIn.hd,
            },
          },
        }
      : {}),
    plugins,
  };
  const instance = betterAuth(options) as unknown as BetterAuthInstance;

  const logRateLimited = createRateLimitLog(o.clock, emit);
  const clientOf = (headers: Headers): string | null => {
    for (const name of checked.ipAddressHeaders) {
      const value = headers.get(name);
      if (value !== null) return value;
    }
    return null;
  };
  const authHeaderEntries = Object.entries(checked.authHeaders);
  const pageHeaderEntries = Object.entries(checked.pageHeaders);
  // One header rule for both entries: a header Better Auth sets itself wins.
  // Through node, setHeader runs before toNodeHandler writes, so Better Auth's
  // own setHeader replaces ours; on fetch, ours fill only what is absent.
  const addAuthHeaders = (has: (name: string) => boolean, set: (n: string, v: string) => void) => {
    for (const [name, value] of authHeaderEntries) if (!has(name)) set(name, value);
  };
  const logIf429 = (
    status: number,
    path: string,
    client: string | null,
    retryAfter: string | null,
  ) => {
    if (status === 429)
      logRateLimited(path.slice(0, 100), client?.slice(0, 64) ?? null, retryAfter);
  };

  return Object.freeze({
    resource: base.resource,
    publicHostname: base.publicHostname,
    instance,

    async handle(req: Request): Promise<Response> {
      let res = await instance.handler(req);
      if (authHeaderEntries.length > 0) {
        const headers = new Headers(res.headers);
        addAuthHeaders(
          (n) => headers.has(n),
          (n, v) => headers.set(n, v),
        );
        res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      logIf429(
        res.status,
        new URL(req.url).pathname,
        clientOf(req.headers),
        res.headers.get("x-retry-after"),
      );
      return res;
    },

    page(path: "/login" | "/consent", url: URL): Response {
      const html = path === "/login" ? o.pages.login() : o.pages.consent(url.search.slice(1));
      const headers = new Headers(pageHeaderEntries);
      headers.set("content-type", HTML);
      return new Response(html, { status: 200, headers });
    },

    asset(path: string): Response | null {
      const asset = Object.hasOwn(o.assets, path) ? o.assets[path] : undefined;
      return asset === undefined
        ? null
        : new Response(asset.body(), { status: 200, headers: asset.headers });
    },

    verify(req, next) {
      return requireMcpAuth(instance, next, {
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
      // Nothing is set yet: Better Auth's setHeader comes after and replaces any of these.
      addAuthHeaders(
        () => false,
        (n, v) => res.setHeader(n, v),
      );
      res.on("finish", () => logIf429(res.statusCode, path, client, null));
    },
  } satisfies AuthLayer);
}
