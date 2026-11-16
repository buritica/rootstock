// Build-time checks for `defineAuth`: the secret, the base URL rule and every
// option. Each refusal is an Error with code ERR_ROOTSTOCK_AUTH_CONFIG, thrown
// before Better Auth is built, so a half-configured layer fails the boot.

import { intIn, isRecord, own, q } from "../../internal/slice.ts";
import type { AuthOptions, RateLimitRule } from "./types.ts";

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
 * `raw` itself when it can sign tokens: at least 32 characters, no leading or
 * trailing whitespace, not an unresolved `op://` secret reference, and not a
 * placeholder (STUB, REPLACE or FIXTURE, any case). A refusal never echoes it.
 */
export function checkAuthSecret(raw: string | undefined): string {
  const fail = (detail: string) => authConfigError("checkAuthSecret", detail);
  if (typeof raw !== "string" || raw.trim() === "") throw fail("the auth secret is not set");
  if (raw !== raw.trim()) {
    throw fail("the auth secret has leading or trailing whitespace; pass the value alone");
  }
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

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The three base URL rules: "origin-only" refuses a path and hands Better Auth
 * the origin; "strip-trailing-slash" hands Better Auth the value as given and
 * drops one trailing slash before `/mcp`; "as-is" uses the value as given for
 * both. Every rule refuses a scheme other than https (http only on a loopback
 * host, the mcp plugin's own rule), credentials, a query and a fragment. A
 * refusal never echoes the URL, which may carry a password.
 */
export function resolveBase(raw: unknown, rule: unknown): ResolvedBase {
  const fail = (detail: string) => authConfigError("defineAuth", `baseURL ${detail}`);
  if (rule !== "origin-only" && rule !== "strip-trailing-slash" && rule !== "as-is") {
    throw authConfigError(
      "defineAuth",
      `baseUrlRule must be "origin-only", "strip-trailing-slash" or "as-is" — got ${q(rule)}`,
    );
  }
  if (typeof raw !== "string" || raw === "") throw fail("must be a non-empty string");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("must be an absolute URL");
  }
  const publicHostname = url.hostname.toLowerCase();
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(publicHostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw fail("must be https (http only on a loopback host)");
  }
  if (url.username !== "" || url.password !== "") throw fail("must not carry credentials");
  if (url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) {
    throw fail("must not carry a query or fragment");
  }
  switch (rule) {
    case "origin-only":
      if (url.pathname !== "/") throw fail("must be an origin with no path");
      return { baseURL: url.origin, resource: `${url.origin}/mcp`, publicHostname };
    case "strip-trailing-slash":
      return { baseURL: raw, resource: `${raw.replace(/\/$/, "")}/mcp`, publicHostname };
    case "as-is":
      return { baseURL: raw, resource: `${raw}/mcp`, publicHostname };
  }
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isPositiveInt = (v: unknown): v is number => intIn(v, 1, Number.MAX_SAFE_INTEGER);
const fail = (detail: string) => authConfigError("defineAuth", detail);

/** `value` itself when it is an object holding only `known` keys. A refusal never echoes a value. */
function knownRecord(
  path: string,
  value: unknown,
  known: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw fail(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw fail(`${path}.${key} is not a known key`);
  }
  return value;
}

function textList(path: string, value: unknown, nonEmpty: boolean): string[] {
  if (!Array.isArray(value) || !value.every(isText) || (nonEmpty && value.length === 0)) {
    throw fail(
      `${path} must be ${nonEmpty ? "a non-empty" : "an"} array of non-empty strings — got ${q(value)}`,
    );
  }
  return [...value];
}

function headerRecord(path: string, value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw fail(`${path} must be an object`);
  try {
    // Headers refuses an invalid name or value, so a typo fails here, not per response.
    new Headers(value as Record<string, string>);
  } catch {
    throw fail(`${path} holds an invalid header — got ${q(value)}`);
  }
  for (const [name, v] of Object.entries(value)) {
    if (typeof v !== "string") throw fail(`${path}[${q(name)}] must be a string — got ${q(v)}`);
  }
  return Object.freeze({ ...(value as Record<string, string>) });
}

function limitRule(path: string, value: unknown, extra: readonly string[] = []): RateLimitRule {
  const rule = knownRecord(path, value, ["window", "max", ...extra]);
  const window = own(rule, "window");
  const max = own(rule, "max");
  if (!isPositiveInt(window) || !isPositiveInt(max)) {
    throw fail(`${path} must be { window, max } with positive integers — got ${q(value)}`);
  }
  return { window, max };
}

const BASE_SCOPES = ["openid", "profile", "email", "offline_access", "mcp:tools"] as const;
export const MCP_TOOLS_SCOPE = "mcp:tools";
const JWKS_RULE = "/jwks";

const escapeChar = (c: string): string => (/[-^$+.()|[\]{}*?\\]/.test(c) ? `\\${c}` : c);

/**
 * Better Auth 1.7.17's custom-rule match (`api/rate-limiter`: a key holding
 * `*` goes through `wildcardMatch(key)` with no separator, any other key must
 * equal the path): `*` is any run of characters, `?` one character, `\`
 * escapes the next one. The matcher is not exported, so this restates it; a
 * test holds the two together through the real limiter.
 */
export function ruleMatches(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return pattern === path;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "\\") {
      if (i < pattern.length - 1) source += escapeChar(pattern[++i] ?? "");
    } else if (c === "?") source += ".";
    else if (c === "*") source += ".*?";
    else source += escapeChar(c);
  }
  return new RegExp(`^${source}$`).test(path);
}

const OPTION_KEYS: readonly (keyof AuthOptions)[] = [
  "baseURL",
  "baseUrlRule",
  "secret",
  "database",
  "signIn",
  "registration",
  "clientPrivileges",
  "redirects",
  "extraScopes",
  "rateLimit",
  "ipAddressHeaders",
  "pages",
  "pageHeaders",
  "authHeaders",
  "assets",
  "clock",
  "timers",
  "log",
];

/** Everything defineAuth reads, checked and copied; the secret and base are checked apart. */
export interface CheckedOptions {
  readonly scopes: readonly string[];
  readonly redirectHosts: readonly string[] | null;
  readonly owners: ReadonlySet<string> | null;
  readonly customRules: Readonly<Record<string, RateLimitRule | false>>;
  readonly ipAddressHeaders: readonly string[];
  readonly pageHeaders: Readonly<Record<string, string>>;
  readonly authHeaders: Readonly<Record<string, string>>;
}

function checkSendLimit(value: unknown): void {
  const limit = knownRecord("signIn.sendLimit", value, ["max", "windowMs", "releaseOnFailure"]);
  const windowMs = own(limit, "windowMs");
  if (
    !isPositiveInt(own(limit, "max")) ||
    !(typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs > 0) ||
    typeof own(limit, "releaseOnFailure") !== "boolean"
  ) {
    throw fail(
      `signIn.sendLimit must be { max: positive integer, windowMs: positive number, releaseOnFailure: boolean } — got ${q(limit)}`,
    );
  }
}

/** The lowercased owner addresses for an owner allowlist, else null. */
function checkSignIn(value: unknown): ReadonlySet<string> | null {
  if (!isRecord(value)) throw fail("signIn must be an object");
  const kind = own(value, "kind");
  if (kind === "magicLink") {
    knownRecord("signIn", value, ["kind", "allow", "send", "sendLimit"]);
    const allow = own(value, "allow");
    const allowKind = isRecord(allow) ? own(allow, "kind") : undefined;
    if (!isRecord(allow) || (allowKind !== "owner" && allowKind !== "invited")) {
      throw fail(`signIn.allow must be { kind: "owner", emails } or { kind: "invited" }`);
    }
    if (typeof own(value, "send") !== "function") throw fail("signIn.send must be a function");
    checkSendLimit(own(value, "sendLimit"));
    if (allowKind === "invited") {
      knownRecord("signIn.allow", allow, ["kind"]);
      return null;
    }
    knownRecord("signIn.allow", allow, ["kind", "emails"]);
    // An empty list is allowed and sends no link at all: fail closed.
    return new Set(
      textList("signIn.allow.emails", own(allow, "emails"), false).map((e) =>
        e.trim().toLowerCase(),
      ),
    );
  }
  if (kind === "social") {
    knownRecord("signIn", value, ["kind", "provider", "clientId", "clientSecret", "hd"]);
    if (own(value, "provider") !== "google") throw fail(`signIn.provider must be "google"`);
    // Never echoed: clientSecret is a credential.
    for (const key of ["clientId", "clientSecret", "hd"] as const) {
      if (!isText(own(value, key))) throw fail(`signIn.${key} must be a non-empty string`);
    }
    // Better Auth reads "*" as any hosted domain, which restricts nothing.
    if (String(own(value, "hd")).includes("*")) {
      throw fail("signIn.hd must name one domain, not a wildcard");
    }
    return null;
  }
  throw fail(`signIn.kind must be "magicLink" or "social" — got ${q(kind)}`);
}

/**
 * A listed host as a URL hostname spells it, lowercased. An entry that a URL
 * would rewrite (a port, a path, credentials, a trailing dot, an IDN, a bare
 * IPv6 address) could never match, so it is refused rather than kept dead.
 */
function redirectHost(raw: string): string {
  const host = raw.trim().toLowerCase();
  let parsed: string | null = null;
  try {
    parsed = new URL(`https://${host}`).hostname;
  } catch {
    // Unparseable: refused below.
  }
  if (parsed !== host || host.endsWith(".")) {
    throw fail(
      `redirects.hosts entry ${q(raw)} must be a bare hostname as a URL spells it (no port, path, trailing dot or IDN; IPv6 in brackets)`,
    );
  }
  return host;
}

function checkRedirects(value: unknown): string[] | null {
  if (!isRecord(value)) throw fail("redirects must be an object");
  const kind = own(value, "kind");
  if (kind === "any") {
    knownRecord("redirects", value, ["kind"]);
    return null;
  }
  if (kind !== "listed") throw fail(`redirects.kind must be "any" or "listed" — got ${q(kind)}`);
  knownRecord("redirects", value, ["kind", "hosts", "loopback"]);
  const loopback = own(value, "loopback");
  if (loopback !== "if-listed") {
    throw fail(`redirects.loopback must be "if-listed" — got ${q(loopback)}`);
  }
  return textList("redirects.hosts", own(value, "hosts"), true).map(redirectHost);
}

function checkRules(value: unknown): Record<string, RateLimitRule | false> {
  if (!isRecord(value)) throw fail("rateLimit.rules must be an object");
  // The server fetches its own JWKS through its public URL, so a limit on it
  // lets forged tokens exhaust the bucket every real token needs. Better Auth
  // takes the first key that matches, so the exemption goes first, and any
  // other key that would match "/jwks" is refused rather than left shadowed.
  const customRules: Record<string, RateLimitRule | false> = { [JWKS_RULE]: false };
  for (const [path, rule] of Object.entries(value)) {
    if (!path.startsWith("/")) throw fail(`rateLimit.rules key ${q(path)} must start with "/"`);
    if (path === JWKS_RULE) {
      if (rule !== false) {
        throw fail(
          `rateLimit.rules["/jwks"] must be false (it is always unmetered) — got ${q(rule)}`,
        );
      }
      continue;
    }
    if (ruleMatches(path, JWKS_RULE)) {
      throw fail(
        `rateLimit.rules key ${q(path)} matches "/jwks", which is always unmetered; narrow it`,
      );
    }
    customRules[path] = rule === false ? false : limitRule(`rateLimit.rules[${q(path)}]`, rule);
  }
  return customRules;
}

/** Refuses (ERR_ROOTSTOCK_AUTH_CONFIG) any option outside its contract shape, unknown keys included. */
export function checkOptions(o: AuthOptions): CheckedOptions {
  const opts = knownRecord("options", o, OPTION_KEYS);
  const get = (key: keyof AuthOptions): unknown => own(opts, key);
  const database = get("database");
  if (database === undefined || database === null) throw fail("database is required");
  const owners = checkSignIn(get("signIn"));

  const registration = knownRecord("registration", get("registration"), ["dcr"]);
  if (typeof own(registration, "dcr") !== "boolean") {
    throw fail("registration must be { dcr: boolean }");
  }
  const privileges = get("clientPrivileges");
  if (privileges !== "deny" && privileges !== "unset") {
    throw fail(`clientPrivileges must be "deny" or "unset" — got ${q(privileges)}`);
  }
  const redirectHosts = checkRedirects(get("redirects"));

  const extra = textList("extraScopes", get("extraScopes"), false);
  const scopes = [...BASE_SCOPES, ...extra];
  if (new Set(scopes).size !== scopes.length) {
    throw fail(`extraScopes repeats a scope already offered — got ${q(extra)}`);
  }

  const rateLimit = get("rateLimit");
  limitRule("rateLimit", rateLimit, ["rules"]);
  const customRules = checkRules(own(rateLimit as Record<string, unknown>, "rules"));

  const ipAddressHeaders = textList("ipAddressHeaders", get("ipAddressHeaders"), false);
  for (const h of ipAddressHeaders) {
    if (h.trim().toLowerCase() === "x-forwarded-for") {
      // A client can send its own; a proxy that appends makes it multi-valued,
      // and Better Auth then drops every caller into one shared bucket.
      throw fail(
        `ipAddressHeaders must not list "x-forwarded-for": a client can set it — name the header your proxy overwrites`,
      );
    }
  }

  const pages = knownRecord("pages", get("pages"), ["login", "consent"]);
  if (typeof own(pages, "login") !== "function") throw fail("pages.login must be a function");
  if (typeof own(pages, "consent") !== "function") throw fail("pages.consent must be a function");
  const pageHeaders = headerRecord("pageHeaders", get("pageHeaders"));
  const authHeaders = headerRecord("authHeaders", get("authHeaders"));

  const assets = get("assets");
  if (!isRecord(assets)) throw fail("assets must be an object");
  for (const [path, asset] of Object.entries(assets)) {
    if (!path.startsWith("/")) throw fail(`assets key ${q(path)} must start with "/"`);
    const checked = knownRecord(`assets[${q(path)}]`, asset, ["body", "headers"]);
    if (typeof own(checked, "body") !== "function") {
      throw fail(`assets[${q(path)}] must be { body: () => Blob, headers }`);
    }
    headerRecord(`assets[${q(path)}].headers`, own(checked, "headers"));
  }

  for (const key of ["clock", "timers"] as const) {
    if (!isRecord(get(key))) throw fail(`${key} is required`);
  }
  if (typeof get("log") !== "function") throw fail("log must be a function");

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
