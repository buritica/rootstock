// Build-time checks for `defineAuth`: the secret, the base URL rule and every
// option. Each refusal is an Error with code ERR_ROOTSTOCK_AUTH_CONFIG, thrown
// before Better Auth is built, so a half-configured layer fails the boot.

import { isRecord, q } from "../../internal/slice.ts";
import type { AuthOptions } from "./types.ts";

export const AUTH_CONFIG_CODE = "ERR_ROOTSTOCK_AUTH_CONFIG";

export function authConfigError(fn: string, detail: string): Error {
  return Object.assign(new Error(`rootstock serve/auth: ${fn}(): ${detail}`), {
    code: AUTH_CONFIG_CODE,
  });
}

/** Better Auth's own floor for a production secret. */
const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /STUB|REPLACE|FIXTURE/i;

/**
 * `raw` itself when it can sign tokens: at least 32 characters, not an
 * unresolved `op://` secret reference, and not a placeholder (STUB, REPLACE or
 * FIXTURE, any case). A refusal never echoes the value.
 */
export function checkAuthSecret(raw: string | undefined): string {
  const fail = (detail: string) => authConfigError("checkAuthSecret", detail);
  if (typeof raw !== "string" || raw.trim() === "") throw fail("the auth secret is not set");
  if (raw.startsWith("op://")) {
    throw fail("the auth secret is an unresolved op:// reference; pass the resolved value");
  }
  if (PLACEHOLDER.test(raw)) {
    throw fail("the auth secret looks like a placeholder or test fixture; pass a generated secret");
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    throw fail(
      `the auth secret is ${raw.length} characters; it needs at least ${MIN_SECRET_LENGTH}`,
    );
  }
  return raw;
}

export interface ResolvedBase {
  /** What Better Auth is given as `baseURL`. */
  readonly baseURL: string;
  /** `${base}/mcp`, the audience every token is bound to. */
  readonly resource: string;
  readonly publicHostname: string;
}

/**
 * The three base URL rules: "origin-only" refuses a path, query or fragment and
 * hands Better Auth the origin; "strip-trailing-slash" hands Better Auth the
 * value as given and drops one trailing slash before `/mcp`; "as-is" uses the
 * value as given for both.
 */
export function resolveBase(raw: unknown, rule: unknown): ResolvedBase {
  const fail = (detail: string) => authConfigError("defineAuth", detail);
  if (typeof raw !== "string" || raw === "") throw fail(`baseURL must be a URL — got ${q(raw)}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail(`baseURL must be an absolute URL — got ${q(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw fail(`baseURL must be http or https — got ${q(raw)}`);
  }
  const publicHostname = url.hostname.toLowerCase();
  switch (rule) {
    case "origin-only": {
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || /[?#]$/.test(raw)) {
        throw fail(`baseURL must be an origin with no path, query or fragment — got ${q(raw)}`);
      }
      return { baseURL: url.origin, resource: `${url.origin}/mcp`, publicHostname };
    }
    case "strip-trailing-slash":
      return { baseURL: raw, resource: `${raw.replace(/\/$/, "")}/mcp`, publicHostname };
    case "as-is":
      return { baseURL: raw, resource: `${raw}/mcp`, publicHostname };
    default:
      throw fail(
        `baseUrlRule must be "origin-only", "strip-trailing-slash" or "as-is" — got ${q(rule)}`,
      );
  }
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isPositive = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const isPositiveInt = (v: unknown): v is number => isPositive(v) && Number.isInteger(v);

function textList(path: string, value: unknown, nonEmpty: boolean): string[] {
  if (!Array.isArray(value) || !value.every(isText) || (nonEmpty && value.length === 0)) {
    throw authConfigError(
      "defineAuth",
      `${path} must be ${nonEmpty ? "a non-empty" : "an"} array of non-empty strings — got ${q(value)}`,
    );
  }
  return [...value];
}

function headerRecord(path: string, value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw authConfigError("defineAuth", `${path} must be an object`);
  try {
    // Headers refuses an invalid name or value, so a typo fails here, not per response.
    new Headers(value as Record<string, string>);
  } catch {
    throw authConfigError("defineAuth", `${path} holds an invalid header — got ${q(value)}`);
  }
  for (const [name, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw authConfigError("defineAuth", `${path}[${q(name)}] must be a string — got ${q(v)}`);
    }
  }
  return Object.freeze({ ...(value as Record<string, string>) });
}

function limitRule(path: string, value: unknown): { window: number; max: number } {
  if (!isRecord(value) || !isPositiveInt(value.window) || !isPositiveInt(value.max)) {
    throw authConfigError(
      "defineAuth",
      `${path} must be { window, max } with positive integers — got ${q(value)}`,
    );
  }
  return { window: value.window, max: value.max };
}

const BASE_SCOPES = ["openid", "profile", "email", "offline_access", "mcp:tools"] as const;
export const MCP_TOOLS_SCOPE = "mcp:tools";
const JWKS_RULE = "/jwks";

/** Everything defineAuth reads, checked and copied; the secret and base are checked apart. */
export interface CheckedOptions {
  readonly scopes: readonly string[];
  readonly redirectHosts: readonly string[] | null;
  readonly owners: ReadonlySet<string> | null;
  readonly customRules: Readonly<Record<string, { window: number; max: number } | false>>;
  readonly ipAddressHeaders: readonly string[];
  readonly pageHeaders: Readonly<Record<string, string>>;
  readonly authHeaders: Readonly<Record<string, string>>;
}

/** Refuses (ERR_ROOTSTOCK_AUTH_CONFIG) any option outside its contract shape. */
export function checkOptions(o: AuthOptions): CheckedOptions {
  const fail = (detail: string) => authConfigError("defineAuth", detail);
  if (o.database === undefined || o.database === null) throw fail("database is required");

  const signIn: unknown = o.signIn;
  let owners: Set<string> | null = null;
  if (!isRecord(signIn)) throw fail("signIn must be an object");
  if (signIn.kind === "magicLink") {
    const allow = signIn.allow;
    if (!isRecord(allow) || (allow.kind !== "owner" && allow.kind !== "invited")) {
      throw fail(`signIn.allow must be { kind: "owner", emails } or { kind: "invited" }`);
    }
    if (allow.kind === "owner") {
      // An empty list is allowed and sends no link at all: fail closed.
      owners = new Set(
        textList("signIn.allow.emails", allow.emails, false).map((e) => e.trim().toLowerCase()),
      );
    }
    if (typeof signIn.send !== "function") throw fail("signIn.send must be a function");
    const limit = signIn.sendLimit;
    if (
      !isRecord(limit) ||
      !isPositiveInt(limit.max) ||
      !isPositive(limit.windowMs) ||
      typeof limit.releaseOnFailure !== "boolean"
    ) {
      throw fail(
        `signIn.sendLimit must be { max: positive integer, windowMs: positive number, releaseOnFailure: boolean } — got ${q(limit)}`,
      );
    }
  } else if (signIn.kind === "social") {
    if (signIn.provider !== "google") throw fail(`signIn.provider must be "google"`);
    // Never echoed: clientSecret is a credential.
    for (const key of ["clientId", "clientSecret", "hd"] as const) {
      if (!isText(signIn[key])) throw fail(`signIn.${key} must be a non-empty string`);
    }
  } else {
    throw fail(`signIn.kind must be "magicLink" or "social" — got ${q(signIn.kind)}`);
  }

  if (!isRecord(o.registration) || typeof o.registration.dcr !== "boolean") {
    throw fail("registration must be { dcr: boolean }");
  }
  if (o.clientPrivileges !== "deny" && o.clientPrivileges !== "unset") {
    throw fail(`clientPrivileges must be "deny" or "unset" — got ${q(o.clientPrivileges)}`);
  }

  const redirects: unknown = o.redirects;
  let redirectHosts: string[] | null = null;
  if (!isRecord(redirects)) throw fail("redirects must be an object");
  if (redirects.kind === "listed") {
    if (redirects.loopback !== "if-listed") {
      throw fail(`redirects.loopback must be "if-listed" — got ${q(redirects.loopback)}`);
    }
    redirectHosts = textList("redirects.hosts", redirects.hosts, true).map((h) =>
      h.trim().toLowerCase(),
    );
  } else if (redirects.kind !== "any") {
    throw fail(`redirects.kind must be "any" or "listed" — got ${q(redirects.kind)}`);
  }

  const extra = textList("extraScopes", o.extraScopes, false);
  const scopes = [...BASE_SCOPES, ...extra];
  if (new Set(scopes).size !== scopes.length) {
    throw fail(`extraScopes repeats a scope already offered — got ${q(extra)}`);
  }

  const rateLimit: unknown = o.rateLimit;
  if (!isRecord(rateLimit)) throw fail("rateLimit must be an object");
  limitRule("rateLimit", { window: rateLimit.window, max: rateLimit.max });
  if (!isRecord(rateLimit.rules)) throw fail("rateLimit.rules must be an object");
  const customRules: Record<string, { window: number; max: number } | false> = {};
  for (const [path, rule] of Object.entries(rateLimit.rules)) {
    if (!path.startsWith("/")) throw fail(`rateLimit.rules key ${q(path)} must start with "/"`);
    if (path === JWKS_RULE && rule !== false) {
      // The server fetches its own JWKS through its public URL, so a limit on
      // it lets forged tokens exhaust the bucket every real token needs.
      throw fail(
        `rateLimit.rules["/jwks"] must be false (it is always unmetered) — got ${q(rule)}`,
      );
    }
    customRules[path] = rule === false ? false : limitRule(`rateLimit.rules[${q(path)}]`, rule);
  }
  customRules[JWKS_RULE] = false;

  const ipAddressHeaders = textList("ipAddressHeaders", o.ipAddressHeaders, false);
  for (const h of ipAddressHeaders) {
    if (h.trim().toLowerCase() === "x-forwarded-for") {
      // A client can send its own; a proxy that appends makes it multi-valued,
      // and Better Auth then drops every caller into one shared bucket.
      throw fail(
        `ipAddressHeaders must not list "x-forwarded-for": a client can set it — name the header your proxy overwrites`,
      );
    }
  }

  if (!isRecord(o.pages) || typeof o.pages.login !== "function") {
    throw fail("pages.login must be a function");
  }
  if (typeof o.pages.consent !== "function") throw fail("pages.consent must be a function");
  const pageHeaders = headerRecord("pageHeaders", o.pageHeaders);
  const authHeaders = headerRecord("authHeaders", o.authHeaders);

  if (!isRecord(o.assets)) throw fail("assets must be an object");
  for (const [path, asset] of Object.entries(o.assets)) {
    if (!path.startsWith("/")) throw fail(`assets key ${q(path)} must start with "/"`);
    if (!isRecord(asset) || typeof asset.body !== "function") {
      throw fail(`assets[${q(path)}] must be { body: () => Blob, headers }`);
    }
    headerRecord(`assets[${q(path)}].headers`, asset.headers);
  }

  for (const key of ["clock", "timers"] as const) {
    if (!isRecord(o[key])) throw fail(`${key} is required`);
  }
  if (typeof o.log !== "function") throw fail("log must be a function");

  return {
    scopes,
    redirectHosts,
    owners,
    customRules,
    ipAddressHeaders,
    pageHeaders,
    authHeaders,
  };
}
