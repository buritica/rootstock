import { describe, expect, test } from "bun:test";
import {
  CHAIN_SHAPED_HEADERS,
  resolveBind,
  resolveClientIpHeader,
  SERVE_HARDENING,
  sourceKeyFor,
} from "./hardening.ts";

test("SERVE_HARDENING pins the safe posture", () => {
  expect(SERVE_HARDENING).toEqual({
    maxRequestBodySize: 2_000_000,
    development: false,
    idleTimeout: 45,
    hostname: "127.0.0.1",
  });
  expect(Object.isFrozen(SERVE_HARDENING)).toBe(true);
});

describe("resolveBind", () => {
  test("unset, empty and loopback are loopback; 0.0.0.0 is itself", () => {
    expect(resolveBind(undefined)).toBe("127.0.0.1");
    expect(resolveBind("")).toBe("127.0.0.1");
    expect(resolveBind("127.0.0.1")).toBe("127.0.0.1");
    expect(resolveBind("0.0.0.0")).toBe("0.0.0.0");
  });
  test("anything else is refused", () => {
    expect(() => resolveBind("10.0.0.5")).toThrow(
      expect.objectContaining({ code: "ERR_ROOTSTOCK_SERVE_CONFIG" }),
    );
  });
});

describe("resolveClientIpHeader", () => {
  test("unset on loopback is the default; unset on 0.0.0.0 is refused", () => {
    expect(resolveClientIpHeader(undefined, "127.0.0.1")).toBe("cf-connecting-ip");
    expect(() => resolveClientIpHeader(undefined, "0.0.0.0")).toThrow(/needs the client-IP header/);
  });
  test("chain-shaped headers are refused on 0.0.0.0 only", () => {
    expect(CHAIN_SHAPED_HEADERS.has("x-forwarded-for")).toBe(true);
    expect(() => resolveClientIpHeader("X-Forwarded-For", "0.0.0.0")).toThrow(/forwarding chain/);
    expect(() => resolveClientIpHeader("forwarded", "0.0.0.0")).toThrow(/forwarding chain/);
    expect(resolveClientIpHeader("x-forwarded-for", "127.0.0.1")).toBe("x-forwarded-for");
    expect(resolveClientIpHeader("x-real-ip", "0.0.0.0")).toBe("x-real-ip");
  });
  test("a name that is not a token is refused, empty included", () => {
    expect(() => resolveClientIpHeader("", "127.0.0.1")).toThrow(/RFC 7230 token/);
    expect(() => resolveClientIpHeader("bad header", "0.0.0.0")).toThrow(/RFC 7230 token/);
  });
});

describe("sourceKeyFor", () => {
  const req = (h: Record<string, string>) =>
    new Request("http://app.example.test/mcp", { headers: h });
  test("rightmost entry of the header, trimmed", () => {
    expect(sourceKeyFor(req({ "x-ff": "203.0.113.9, 192.0.2.7 " }), {}, "x-ff")).toBe("192.0.2.7");
  });
  test("falls back to the socket address, then unknown", () => {
    expect(sourceKeyFor(req({}), { remoteAddress: "198.51.100.2" }, "x-ff")).toBe("198.51.100.2");
    expect(sourceKeyFor(req({ "x-ff": " " }), {}, "x-ff")).toBe("unknown");
  });
  test("null header reads the socket only", () => {
    expect(
      sourceKeyFor(req({ "x-ff": "192.0.2.7" }), { remoteAddress: "198.51.100.2" }, null),
    ).toBe("198.51.100.2");
  });
  test("capped at 64 characters", () => {
    expect(sourceKeyFor(req({ "x-ff": "a".repeat(100) }), {}, "x-ff")).toHaveLength(64);
  });
});
