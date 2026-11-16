// The `serve/auth` contract: what `defineAuth` takes and the layer it returns.
// `serve` declares the structural subset it uses on its own side (it may not
// import this subpath); this `AuthLayer` must stay assignable to that subset.

import type { Auth } from "better-auth";
import type { Clock, LogEvent, Timers } from "../types.ts";

/** The Better Auth instance, for a node server that mounts `toNodeHandler(instance)` itself. */
export type BetterAuthInstance = Auth;

export type MagicLinkSignIn = {
  readonly kind: "magicLink";
  /** owner: only these addresses (case-insensitive) ever get a link; invited: any existing user. */
  readonly allow:
    | { readonly kind: "owner"; readonly emails: readonly string[] }
    | { readonly kind: "invited" };
  readonly send: (email: string, url: string) => Promise<void>;
  /** A sliding window of sends per lowercased address; releaseOnFailure drops a failed send's time. */
  readonly sendLimit: {
    readonly max: number;
    readonly windowMs: number;
    readonly releaseOnFailure: boolean;
  };
};

export type SocialSignIn = {
  readonly kind: "social";
  readonly provider: "google";
  readonly clientId: string;
  readonly clientSecret: string;
  /** The hosted domain, enforced against the id token's `hd` claim by Better Auth. */
  readonly hd: string;
};

export type RateLimitRule = { readonly window: number; readonly max: number };

export interface AuthOptions {
  /** Validated per `baseUrlRule`. */
  baseURL: string;
  baseUrlRule: "origin-only" | "strip-trailing-slash" | "as-is";
  secret: string;
  /** A pg Pool or an adapter, passed to Better Auth untouched. */
  database: unknown;
  signIn: MagicLinkSignIn | SocialSignIn;
  /** CIMD is always on; dcr true opens unauthenticated dynamic client registration. */
  registration: { dcr: boolean };
  /** "deny": no session may create a client through the provider's endpoints. */
  clientPrivileges: "deny" | "unset";
  /** Checked at authorize. listed: https to a listed host, http only to a listed loopback host. */
  redirects: { kind: "any" } | { kind: "listed"; hosts: readonly string[]; loopback: "if-listed" };
  /** Offered beside openid, profile, email, offline_access and mcp:tools. */
  extraScopes: readonly string[];
  /** Seconds and counts; `"/jwks": false` is always added. */
  rateLimit: {
    window: number;
    max: number;
    rules: Readonly<Record<string, RateLimitRule | false>>;
  };
  /** The client IP headers Better Auth trusts, in order. "x-forwarded-for" is refused. */
  ipAddressHeaders: readonly string[];
  pages: { login: () => string; consent: (query: string) => string };
  /** Added to the login and consent pages. */
  pageHeaders: Readonly<Record<string, string>>;
  /** Added to every Better Auth response (a header Better Auth sets itself wins). */
  authHeaders: Readonly<Record<string, string>>;
  /** Unmetered static files by exact path. */
  assets: Readonly<Record<string, { body: () => Blob; headers: Readonly<Record<string, string>> }>>;
  clock: Clock;
  /** Schedules the magic-link send after the response (`set(0, …)`). */
  timers: Timers;
  log: LogEvent;
}

/** The response surface `wrapNodeAuthResponse` touches: a node `ServerResponse` fits. */
export interface NodeAuthResponse {
  setHeader(n: string, v: string): void;
  on(e: "finish" | "close", f: () => void): void;
  statusCode: number;
}

export interface AuthLayer {
  /** `${baseURL}/mcp`: the audience every token is bound to. */
  readonly resource: string;
  /** The base URL's hostname, lowercased. */
  readonly publicHostname: string;
  readonly instance: BetterAuthInstance;
  /** Better Auth's routes, with `authHeaders` and the 429 log. */
  handle(req: Request): Promise<Response>;
  page(path: "/login" | "/consent", url: URL): Response;
  asset(path: string): Response | null;
  /**
   * `requireMcpAuth` with `requiredScopes: ["mcp:tools"]`: its 401/403 are
   * returned as Better Auth builds them, a JWKS failure or other throw
   * propagates, and a verified token reaches `next` with its claims.
   */
  verify(
    req: Request,
    next: (req: Request, claims: Readonly<Record<string, unknown>>) => Promise<Response>,
  ): Promise<Response>;
  /** Resolves once the store answers and holds the resource row; rejects otherwise. */
  assertStoreReady(): Promise<void>;
  /**
   * Resolves once no magic-link send is scheduled or in flight (at once for
   * social sign-in); never rejects. Shutdown awaits it like a sink's idle().
   */
  idle(): Promise<void>;
  /** For a node server that serves Better Auth itself: apply authHeaders and the 429 log around its own handler. */
  wrapNodeAuthResponse(res: NodeAuthResponse, path: string, client: string): void;
}
