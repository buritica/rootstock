import { describe, expect, test } from "bun:test";
import { harness, SECRET, type Shape } from "./auth.test-support.ts";
import { checkAuthSecret, resolveBase } from "./config.ts";
import { isAllowedRedirectUri } from "./redirects.ts";
import type { AuthOptions } from "./types.ts";

const CODE = "ERR_ROOTSTOCK_AUTH_CONFIG";

function refusal(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error("expected a refusal");
}

describe("checkAuthSecret", () => {
  test("returns a usable secret unchanged", () => {
    expect(checkAuthSecret(SECRET)).toBe(SECRET);
  });

  test.each([
    ["unset", undefined, "not set"],
    ["blank", "   ", "not set"],
    ["an op:// reference", `op://vault/item/${"x".repeat(40)}`, "op://"],
    ["a STUB placeholder", `stub-${SECRET}`, "placeholder"],
    ["a REPLACE placeholder", `${SECRET}-Replace-me`, "placeholder"],
    ["a FIXTURE placeholder", `${SECRET}FIXTURE`, "placeholder"],
    ["shorter than 32", "a".repeat(31), "31 characters"],
  ])("refuses %s, never echoing it", (_name, raw, text) => {
    const err = refusal(() => checkAuthSecret(raw));
    expect(err.code).toBe(CODE);
    expect(err.message).toContain(text);
    if (raw !== undefined && raw.trim() !== "") expect(err.message).not.toContain(raw);
  });
});

describe("resolveBase", () => {
  test("origin-only hands Better Auth the origin and refuses a path, query or fragment", () => {
    expect(resolveBase("https://App.example.test/", "origin-only")).toEqual({
      baseURL: "https://app.example.test",
      resource: "https://app.example.test/mcp",
      publicHostname: "app.example.test",
    });
    for (const raw of [
      "https://app.example.test/x",
      "https://app.example.test/?a=1",
      "https://app.example.test/#f",
      "https://app.example.test?",
    ]) {
      expect(refusal(() => resolveBase(raw, "origin-only")).code).toBe(CODE);
    }
  });

  test("strip-trailing-slash keeps the value for Better Auth and drops one slash before /mcp", () => {
    expect(resolveBase("https://app.example.test/", "strip-trailing-slash")).toEqual({
      baseURL: "https://app.example.test/",
      resource: "https://app.example.test/mcp",
      publicHostname: "app.example.test",
    });
  });

  test("as-is uses the value for both", () => {
    expect(resolveBase("https://app.example.test", "as-is").resource).toBe(
      "https://app.example.test/mcp",
    );
  });

  test("refuses a relative URL, a non-http scheme and an unknown rule", () => {
    expect(refusal(() => resolveBase("/relative", "as-is")).code).toBe(CODE);
    expect(refusal(() => resolveBase("ftp://app.example.test", "as-is")).code).toBe(CODE);
    expect(refusal(() => resolveBase("https://app.example.test", "loose")).code).toBe(CODE);
  });
});

describe("isAllowedRedirectUri", () => {
  const hosts = ["client.example.test", "127.0.0.1"];
  test.each([
    ["https://client.example.test/cb", true],
    ["https://CLIENT.example.test/cb", true],
    ["http://127.0.0.1:3000/cb", true],
    ["https://sub.client.example.test/cb", false],
    ["http://client.example.test/cb", false],
    ["http://localhost:3000/cb", false],
    ["myapp://client.example.test/cb", false],
    ["not a url", false],
  ])("%s → %p", (uri, allowed) => {
    expect(isAllowedRedirectUri(uri, hosts)).toBe(allowed);
  });
});

describe("defineAuth refuses at build", () => {
  const build = (shape: Shape, change: (o: AuthOptions) => Record<string, unknown>) =>
    refusal(() => harness(shape, (o) => change(o) as unknown as AuthOptions));

  test("x-forwarded-for in ipAddressHeaders, in any case", () => {
    for (const h of ["x-forwarded-for", "X-Forwarded-For", " x-forwarded-for "]) {
      const err = build("owner", (o) => ({ ...o, ipAddressHeaders: ["cf-connecting-ip", h] }));
      expect(err.code).toBe(CODE);
      expect(err.message).toContain("x-forwarded-for");
    }
  });

  test("a /jwks rule that meters it", () => {
    const err = build("invited", (o) => ({
      ...o,
      rateLimit: { ...o.rateLimit, rules: { "/jwks": { window: 60, max: 10 } } },
    }));
    expect(err.code).toBe(CODE);
    expect(err.message).toContain("/jwks");
  });

  test.each<[string, Shape, (o: AuthOptions) => Record<string, unknown>]>([
    ["a placeholder secret", "owner", (o) => ({ ...o, secret: `${SECRET}stub` })],
    [
      "a base URL with a path under origin-only",
      "owner",
      (o) => ({ ...o, baseURL: `${o.baseURL}/x` }),
    ],
    ["no database", "owner", (o) => ({ ...o, database: undefined })],
    ["an unknown sign-in kind", "owner", (o) => ({ ...o, signIn: { kind: "password" } })],
    [
      "a zero send limit",
      "invited",
      (o) => ({
        ...o,
        signIn: { ...o.signIn, sendLimit: { max: 0, windowMs: 1, releaseOnFailure: true } },
      }),
    ],
    ["a social sign-in without hd", "social", (o) => ({ ...o, signIn: { ...o.signIn, hd: "" } })],
    ["dcr that is not a boolean", "owner", (o) => ({ ...o, registration: { dcr: "yes" } })],
    ["an unknown privilege", "owner", (o) => ({ ...o, clientPrivileges: "allow" })],
    [
      "a listed redirect with no hosts",
      "owner",
      (o) => ({ ...o, redirects: { kind: "listed", hosts: [], loopback: "if-listed" } }),
    ],
    ["a repeated scope", "owner", (o) => ({ ...o, extraScopes: ["mcp:tools"] })],
    [
      "a rule path without a slash",
      "owner",
      (o) => ({ ...o, rateLimit: { ...o.rateLimit, rules: { token: false } } }),
    ],
    ["a non-integer rule", "owner", (o) => ({ ...o, rateLimit: { ...o.rateLimit, window: 0.5 } })],
    ["an invalid header name", "owner", (o) => ({ ...o, pageHeaders: { "bad header": "x" } })],
    [
      "an asset without a leading slash",
      "invited",
      (o) => ({ ...o, assets: { "a.css": { body: () => new Blob([]), headers: {} } } }),
    ],
    ["no log", "owner", (o) => ({ ...o, log: undefined })],
  ])("%s", (_name, shape, change) => {
    expect(build(shape, change).code).toBe(CODE);
  });

  test("a social client secret is never echoed", () => {
    const err = build("social", (o) => ({ ...o, signIn: { ...o.signIn, clientId: "" } }));
    expect(err.message).not.toContain("client-secret-value");
  });
});
