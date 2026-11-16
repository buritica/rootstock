import { describe, expect, test } from "bun:test";
import { harness, SECRET, type Shape } from "./auth.test-support.ts";
import { checkAuthSecret, resolveBase, ruleMatches } from "./config.ts";
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

  test.each<[string, Shape, (o: AuthOptions) => Record<string, unknown>, string]>([
    [
      "a mistyped top-level key",
      "owner",
      (o) => ({ ...o, ipAddressHeader: ["x-real-ip"] }),
      "options.ipAddressHeader",
    ],
    [
      "a key outside the sign-in kind",
      "social",
      (o) => ({ ...o, signIn: { ...o.signIn, sendLimit: {} } }),
      "signIn.sendLimit",
    ],
    [
      "a key in signIn.allow",
      "invited",
      (o) => ({ ...o, signIn: { ...o.signIn, allow: { kind: "invited", emails: [] } } }),
      "signIn.allow.emails",
    ],
    [
      "a key in signIn.sendLimit",
      "owner",
      (o) => ({
        ...o,
        signIn: {
          ...o.signIn,
          sendLimit: { max: 1, windowMs: 1, releaseOnFailure: true, burst: 2 },
        },
      }),
      "signIn.sendLimit.burst",
    ],
    [
      "a key in registration",
      "owner",
      (o) => ({ ...o, registration: { dcr: false, open: true } }),
      "registration.open",
    ],
    [
      "hosts on an any redirect",
      "social",
      (o) => ({ ...o, redirects: { kind: "any", hosts: ["client.example.test"] } }),
      "redirects.hosts",
    ],
    [
      "a key in rateLimit",
      "owner",
      (o) => ({ ...o, rateLimit: { ...o.rateLimit, customRules: {} } }),
      "rateLimit.customRules",
    ],
    [
      "a key in a rule",
      "owner",
      (o) => ({
        ...o,
        rateLimit: { ...o.rateLimit, rules: { "/x": { window: 1, max: 1, burst: 1 } } },
      }),
      "burst",
    ],
    [
      "a key in pages",
      "owner",
      (o) => ({ ...o, pages: { ...o.pages, logout: () => "" } }),
      "pages.logout",
    ],
    [
      "a key in an asset",
      "invited",
      (o) => ({ ...o, assets: { "/a.css": { body: () => new Blob([]), headers: {}, etag: "x" } } }),
      "etag",
    ],
  ])("unknown key: %s", (_name, shape, change, named) => {
    const err = build(shape, change);
    expect(err.code).toBe(CODE);
    expect(err.message).toContain(named);
    expect(err.message).toContain("is not a known key");
  });

  test("a social client secret is never echoed", () => {
    const err = build("social", (o) => ({ ...o, signIn: { ...o.signIn, clientId: "" } }));
    expect(err.message).not.toContain("client-secret-value");
  });
});

describe("review fixes", () => {
  const build = (shape: Shape, change: (o: AuthOptions) => Record<string, unknown>) =>
    refusal(() => harness(shape, (o) => change(o) as unknown as AuthOptions));

  test("a secret with leading or trailing whitespace is refused", () => {
    for (const raw of [` ${SECRET}`, `${SECRET}\n`]) {
      expect(refusal(() => checkAuthSecret(raw)).message).toContain("whitespace");
    }
  });

  test.each(["origin-only", "strip-trailing-slash", "as-is"])(
    "%s: non-https, credentials, a query and a fragment are refused without echoing the URL",
    (rule) => {
      for (const raw of [
        "http://app.example.test",
        `https://${["user:hunter2-secret", "app.example.test"].join("@")}`,
        "https://app.example.test/?hunter2-secret=1",
        "https://app.example.test/#hunter2-secret",
        "https://app.example.test?",
      ]) {
        const err = refusal(() => resolveBase(raw, rule));
        expect(err.code).toBe(CODE);
        expect(err.message).not.toContain("hunter2");
        expect(err.message).not.toContain(raw);
      }
      expect(resolveBase("http://127.0.0.1:8080", rule).resource).toBe("http://127.0.0.1:8080/mcp");
    },
  );

  test("hd may not be a wildcard", () => {
    const err = build("social", (o) => ({ ...o, signIn: { ...o.signIn, hd: "*" } }));
    expect(err.message).toContain("wildcard");
  });

  test.each([
    "client.example.test.",
    "client.example.test:443",
    "client.example.test/cb",
    "bücher.example.test",
    "::1",
    ["user", "client.example.test"].join("@"),
  ])("redirect host %p is refused", (host) => {
    const err = build("owner", (o) => ({
      ...o,
      redirects: { kind: "listed", hosts: [host], loopback: "if-listed" },
    }));
    expect(err.code).toBe(CODE);
    expect(err.message).toContain("bare hostname");
  });

  test("redirect hosts are lowercased; bracketed IPv6 is accepted", () => {
    const { layer } = harness("owner", (o) => ({
      ...o,
      redirects: { kind: "listed", hosts: ["Client.Example.TEST", "[::1]"], loopback: "if-listed" },
    }));
    expect(layer.resource).toBe("https://app.example.test/mcp");
  });

  test("an inherited option does not count as given", () => {
    const err = build("owner", (o) => {
      const { log, ...rest } = o;
      return Object.assign(Object.create({ log }), rest);
    });
    expect(err.message).toContain("log must be a function");
  });

  test("isAllowedRedirectUri is not exported", async () => {
    const mod: Record<string, unknown> = await import("./index.ts");
    expect(Object.keys(mod).sort()).toEqual(["checkAuthSecret", "defineAuth"]);
  });
});

describe("/jwks stays unmetered", () => {
  test("the exemption is the first custom rule Better Auth sees", () => {
    const { layer } = harness("owner");
    expect(Object.keys(layer.instance.options.rateLimit?.customRules ?? {})[0]).toBe("/jwks");
  });

  test.each(["/*", "/j*", "/*ks", "/**", "/jw?s*"])(
    "a rule key %p that matches /jwks is refused",
    (key) => {
      const err = refusal(() =>
        harness("owner", (o) => ({
          ...o,
          rateLimit: { ...o.rateLimit, rules: { [key]: { window: 60, max: 1 } } },
        })),
      );
      expect(err.code).toBe(CODE);
      expect(err.message).toContain('matches "/jwks"');
    },
  );

  test.each(["/oauth2/*", "/sign-in/*", "/jwk", "/j\\*"])("%p is accepted", (key) => {
    expect(() =>
      harness("owner", (o) => ({
        ...o,
        rateLimit: { ...o.rateLimit, rules: { [key]: { window: 60, max: 1 } } },
      })),
    ).not.toThrow();
  });

  // ruleMatches restates Better Auth's matcher; hold it to the real limiter.
  let source = 0;
  test.each<[string, string]>([
    ["/ok*", "/ok-1"],
    ["/a?c*", "/abc"],
    ["/a?c*", "/ac"],
    ["/x\\*y*", "/x*y1"],
    ["/x\\*y*", "/xzy1"],
    ["/p.q*", "/pzq"],
    ["/exact", "/exact"],
    ["/exact", "/exactly"],
  ])("ruleMatches(%p, %p) agrees with Better Auth 1.7.17", async (pattern, path) => {
    const { layer } = harness("owner", (o) => ({
      ...o,
      rateLimit: { ...o.rateLimit, rules: { [pattern]: { window: 60, max: 1 } } },
    }));
    const ip = `203.0.113.${++source}`;
    const hit = () =>
      layer.handle(
        new Request(`https://app.example.test/api/auth${path}`, {
          headers: { "cf-connecting-ip": ip },
        }),
      );
    await hit();
    const limited = (await hit()).status === 429;
    expect(ruleMatches(pattern, `${path}`)).toBe(limited);
  });
});
