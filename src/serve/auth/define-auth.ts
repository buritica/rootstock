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
  errorClassOf,
  MCP_TOOLS_SCOPE,
  resolveBase,
} from "./config.ts";
import { createMagicLinkSender, type MagicLinkSender } from "./magic-link.ts";
import { createRateLimitLog } from "./rate-limit-log.ts";
import { isAllowedRedirectUri } from "./redirects.ts";
import type { AuthLayer, AuthOptions, BetterAuthInstance } from "./types.ts";

const HTML = "text/html; charset=utf-8";
/** The Client ID Metadata Document profile MCP 2026-07-28 pins (draft-00). */
const CIMD_PROFILE = "mcp-2026-07-28";
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
  let sender: MagicLinkSender | null = null;
  if (o.signIn.kind === "magicLink") {
    const created = createMagicLinkSender(o.signIn, checked.owners, {
      clock: o.clock,
      timers: o.timers,
      log: emit,
    });
    sender = created;
    plugins.push(magicLink({ disableSignUp: true, sendMagicLink: created.send }));
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
      // read the resource row back: a down or unmigrated store is refused,
      // and so is one that answers without the row. A driver error can carry
      // connection details, so it rides as `cause`, never in the message.
      let row: unknown;
      try {
        const ctx = await instance.$context;
        row = await ctx.adapter.findOne({
          model: "oauthResource",
          where: [{ field: "identifier", value: base.resource }],
        });
      } catch (err) {
        // The class and a SQLSTATE-shaped code tell a missing table from a bad
        // password; the cause's text (hosts, users) never reaches the message.
        const code = (err as { code?: unknown } | null)?.code;
        const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? ` ${code}` : "";
        throw Object.assign(
          authConfigError(
            "assertStoreReady",
            `the auth store could not be read (${errorClassOf(err)}${sqlstate}); see cause`,
          ),
          { cause: err },
        );
      }
      if (!row) {
        throw authConfigError(
          "assertStoreReady",
          `the auth store answered but holds no oauth resource row for ${base.resource}; the startup seed did not land`,
        );
      }
    },

    idle(): Promise<void> {
      return sender === null ? Promise.resolve() : sender.idle();
    },

    wrapNodeAuthResponse(res, rawPath, client) {
      // The caller may pass req.url; a query can carry a magic-link token.
      const path = rawPath.split("?")[0] ?? "";
      // Nothing is set yet: Better Auth's setHeader comes after and replaces any of these.
      addAuthHeaders(
        () => false,
        (n, v) => res.setHeader(n, v),
      );
      // `finish` when the response is written, `close` when it is cut short; log once.
      let logged = false;
      const once = () => {
        if (logged) return;
        logged = true;
        logIf429(res.statusCode, path, client, null);
      };
      res.on("finish", once);
      res.on("close", once);
    },
  } satisfies AuthLayer);
}
