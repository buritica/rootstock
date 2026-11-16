import { describe, expect, test } from "bun:test";
import { hostGuard } from "./host-check.ts";
import type { ServeProfile } from "./types.ts";

type HostCheck = Exclude<ServeProfile["hostCheck"], false>;

const EXACT: HostCheck = {
  hosts: { list: ["app.example.test"], whenEmpty: "allow-all", match: "exact", loopback: "none" },
  origins: { list: ["https://app.example.test"], whenEmpty: "allow-all", absent: "allow" },
  refusal: "404-text",
  appliesTo: "mcp",
};
const HOSTNAME: HostCheck = {
  hosts: { list: [], whenEmpty: "loopback-only", match: "hostname", loopback: "union" },
  origins: { list: [], whenEmpty: "same-as-hosts", absent: "allow" },
  refusal: "sdk-403",
  appliesTo: "mcp",
};

const req = (headers: Record<string, string>) =>
  new Request("http://app.example.test/mcp", { method: "POST", headers });
const status = (r: Response | undefined) => r?.status ?? "pass";

describe("exact matching", () => {
  for (const [what, hc] of [
    ['refusal "sdk-403"', { ...EXACT, refusal: "sdk-403" }],
    [
      'hosts.whenEmpty "loopback-only"',
      { ...EXACT, hosts: { ...EXACT.hosts, whenEmpty: "loopback-only" } },
    ],
    ['hosts.loopback "union"', { ...EXACT, hosts: { ...EXACT.hosts, loopback: "union" } }],
    [
      'origins.whenEmpty "same-as-hosts"',
      { ...EXACT, origins: { ...EXACT.origins, whenEmpty: "same-as-hosts" } },
    ],
  ] as [string, HostCheck][]) {
    test(`refuses ${what} at build`, () => {
      expect(() => hostGuard(hc)).toThrow(/needs hosts.match "hostname"/);
      try {
        hostGuard(hc);
      } catch (err) {
        expect((err as { code?: string }).code).toBe("ERR_ROOTSTOCK_SERVE_CONFIG");
      }
    });
  }

  test("an absent or empty Origin passes; a listed one passes; another is the 404", () => {
    const guard = hostGuard(EXACT);
    const host = { host: "app.example.test" };
    expect(status(guard(req(host)))).toBe("pass");
    expect(status(guard(req({ ...host, origin: "" })))).toBe("pass");
    expect(status(guard(req({ ...host, origin: "https://app.example.test" })))).toBe("pass");
    expect(status(guard(req({ ...host, origin: "https://elsewhere.example.test" })))).toBe(404);
    expect(status(guard(req({ host: "app.example.test:8080" })))).toBe(404);
  });

  test('whenEmpty "allow-all": empty lists check nothing', () => {
    const guard = hostGuard({
      ...EXACT,
      hosts: { ...EXACT.hosts, list: [] },
      origins: { ...EXACT.origins, list: [] },
    });
    expect(
      status(guard(req({ host: "anything.example.test", origin: "https://x.example.test" }))),
    ).toBe("pass");
  });
});

describe("hostname matching", () => {
  test('whenEmpty "loopback-only": loopback hosts pass on any port, others get the SDK 403', () => {
    const guard = hostGuard(HOSTNAME);
    expect(status(guard(req({ host: "localhost:3000" })))).toBe("pass");
    expect(status(guard(req({ host: "127.0.0.1" })))).toBe("pass");
    expect(status(guard(req({ host: "app.example.test" })))).toBe(403);
  });

  test('whenEmpty "allow-all": no host check at all', () => {
    const guard = hostGuard({
      ...HOSTNAME,
      hosts: { ...HOSTNAME.hosts, whenEmpty: "allow-all" },
      origins: { ...HOSTNAME.origins, whenEmpty: "allow-all" },
    });
    expect(status(guard(req({ host: "app.example.test", origin: "https://x.example.test" })))).toBe(
      "pass",
    );
  });

  test('a list unions with loopback; origins "same-as-hosts" follow it; an empty Origin passes', () => {
    const guard = hostGuard({
      ...HOSTNAME,
      hosts: { ...HOSTNAME.hosts, list: ["app.example.test"] },
    });
    expect(status(guard(req({ host: "app.example.test" })))).toBe("pass");
    expect(status(guard(req({ host: "localhost" })))).toBe("pass");
    expect(status(guard(req({ host: "app.example.test", origin: "" })))).toBe("pass");
    expect(
      status(guard(req({ host: "app.example.test", origin: "https://app.example.test" }))),
    ).toBe("pass");
    expect(status(guard(req({ host: "app.example.test", origin: "https://x.example.test" })))).toBe(
      403,
    );
  });

  test('refusal "404-text" swaps the SDK 403 for the text 404', () => {
    const guard = hostGuard({ ...HOSTNAME, refusal: "404-text" });
    expect(status(guard(req({ host: "app.example.test" })))).toBe(404);
  });
});
