import { describe, expect, test } from "bun:test";
import {
  type Caller,
  type CallRecord,
  type CallSink,
  canCallTool,
  defineToolScopes,
  expandScopes,
  type ServeProfile,
  type ToolScopes,
  type UsageWiring,
} from "./types.ts";

const REG = defineToolScopes({
  id: "example.tools",
  tools: { echo: "mcp:tools", slow: "mcp:tools", boom: "offline_access", spend: "profile" },
  implies: {
    "mcp:tools": ["mcp:tools"],
    profile: ["profile", "mcp:tools"],
    offline_access: ["offline_access", "profile"],
  },
});

const caller = (...scopes: string[]): Caller => ({
  name: "app.example.test",
  kind: "oauth",
  scopes: expandScopes(REG, scopes),
});

function refusal(fn: () => unknown): { code?: unknown; message: string } {
  try {
    fn();
  } catch (err) {
    return err as { code?: unknown; message: string };
  }
  throw new Error("expected a refusal");
}

describe("defineToolScopes", () => {
  test("returns a deep-frozen copy", () => {
    const tools: Record<string, string> = { echo: "mcp:tools" };
    const granted = ["mcp:tools"];
    const reg = defineToolScopes({ id: "copy", tools, implies: { "mcp:tools": granted } });
    tools.echo = "other";
    granted.push("other");
    expect(reg.tools).toEqual({ echo: "mcp:tools" });
    expect(reg.implies).toEqual({ "mcp:tools": ["mcp:tools"] });
    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen(reg.tools)).toBe(true);
    expect(Object.isFrozen(reg.implies)).toBe(true);
    expect(Object.isFrozen(reg.implies["mcp:tools"])).toBe(true);
  });

  const bad: [string, unknown, string][] = [
    ["a non-object", null, "the registry must be an object — got null"],
    [
      "a bad id",
      { id: "Bad", tools: {}, implies: {} },
      'id must match /^[a-z0-9][a-z0-9.-]*$/ — got "Bad"',
    ],
    [
      "tools not an object",
      { id: "x", tools: [], implies: {} },
      "tools must be an object — got []",
    ],
    [
      "implies not an object",
      { id: "x", tools: {}, implies: null },
      "implies must be an object — got null",
    ],
    [
      "an empty tool scope",
      { id: "x", tools: { echo: "" }, implies: {} },
      'tools.echo must be a non-empty string — got ""',
    ],
    [
      "a non-array grant",
      { id: "x", tools: {}, implies: { openid: "openid" } },
      'implies.openid must be an array of non-empty strings — got "openid"',
    ],
    [
      "a grant without itself",
      { id: "x", tools: {}, implies: { openid: ["email"], email: ["email"] } },
      'implies.openid must include openid itself — got ["email"]',
    ],
    [
      "an undeclared implied scope",
      { id: "x", tools: {}, implies: { openid: ["openid", "email"] } },
      'implies.openid grants email, which implies does not declare — got "email"',
    ],
  ];
  for (const [label, input, detail] of bad) {
    test(`refuses ${label}`, () => {
      const err = refusal(() => defineToolScopes(input as ToolScopes));
      expect(err.code).toBe("ERR_ROOTSTOCK_SERVE_CONFIG");
      expect(err.message).toBe(`rootstock serve: defineToolScopes(): ${detail}`);
    });
  }

  test("refuses a Map or class instance as tools", () => {
    const err = refusal(() =>
      defineToolScopes({ id: "x", tools: new Map() as never, implies: {} }),
    );
    expect(err.code).toBe("ERR_ROOTSTOCK_SERVE_CONFIG");
    expect(err.message).toBe(
      "rootstock serve: defineToolScopes(): tools must be an object — got {}",
    );
  });

  test("keeps JSON-parsed __proto__ keys as own data properties", () => {
    const reg = defineToolScopes(
      JSON.parse(
        '{"id":"x","tools":{"__proto__":"admin","echo":"mcp:tools"},' +
          '"implies":{"__proto__":["__proto__","mcp:tools"],"mcp:tools":["mcp:tools"]}}',
      ),
    );
    expect(Object.getPrototypeOf(reg.tools)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(reg.implies)).toBe(Object.prototype);
    expect(Object.keys(reg.tools).sort()).toEqual(["__proto__", "echo"]);
    expect(Object.keys(reg.implies).sort()).toEqual(["__proto__", "mcp:tools"]);
    expect(Object.getOwnPropertyDescriptor(reg.tools, "__proto__")?.value).toBe("admin");
    expect(Object.isFrozen(Object.getOwnPropertyDescriptor(reg.implies, "__proto__")?.value)).toBe(
      true,
    );
    const admin: Caller = { name: "a", kind: "oauth", scopes: expandScopes(reg, ["__proto__"]) };
    expect([...admin.scopes].sort()).toEqual(["__proto__", "mcp:tools"]);
    expect(canCallTool(reg, admin, "__proto__")).toBe(false);
    expect(canCallTool(reg, admin, "echo")).toBe(true);
    const tool: Caller = { name: "a", kind: "oauth", scopes: expandScopes(reg, ["mcp:tools"]) };
    expect([...tool.scopes]).toEqual(["mcp:tools"]);
    expect(canCallTool(reg, tool, "__proto__")).toBe(false);
  });

  test("every scope the returned registry grants is declared by it", () => {
    const reg = defineToolScopes(
      JSON.parse(
        '{"id":"x","tools":{},"implies":{"a":["a","__proto__"],"__proto__":["__proto__"]}}',
      ),
    );
    for (const granted of Object.values(reg.implies)) {
      for (const g of granted) expect(Object.hasOwn(reg.implies, g)).toBe(true);
    }
    expect([...expandScopes(reg, ["a"])].sort()).toEqual(["__proto__", "a"]);
  });

  test("an inherited implied scope is not declared", () => {
    const err = refusal(() =>
      defineToolScopes({ id: "x", tools: {}, implies: { openid: ["openid", "toString"] } }),
    );
    expect(err.code).toBe("ERR_ROOTSTOCK_SERVE_CONFIG");
  });
});

describe("expandScopes", () => {
  test("adds what each scope grants, transitively", () => {
    expect([...expandScopes(REG, ["offline_access"])].sort()).toEqual([
      "mcp:tools",
      "offline_access",
      "profile",
    ]);
  });

  test("keeps an undeclared scope and grants nothing for it", () => {
    expect([...expandScopes(REG, ["openid", "toString"])].sort()).toEqual(["openid", "toString"]);
  });

  test("refuses a bare string instead of splitting it into characters", () => {
    const err = refusal(() => expandScopes(REG, "a b"));
    expect(err.code).toBe("ERR_ROOTSTOCK_SERVE_CONFIG");
    expect(err.message).toBe(
      'rootstock serve: expandScopes(): scopes must be an iterable, not one string — got "a b"',
    );
  });

  test("an empty input expands to nothing", () => {
    expect(expandScopes(REG, []).size).toBe(0);
  });
});

describe("canCallTool", () => {
  test("allows a tool whose scope the caller holds", () => {
    expect(canCallTool(REG, caller("mcp:tools"), "echo")).toBe(true);
    expect(canCallTool(REG, caller("offline_access"), "boom")).toBe(true);
    expect(canCallTool(REG, caller("profile"), "slow")).toBe(true);
  });

  test("refuses a tool whose scope the caller lacks", () => {
    expect(canCallTool(REG, caller("mcp:tools"), "spend")).toBe(false);
    expect(canCallTool(REG, caller(), "echo")).toBe(false);
  });

  test("refuses a tool absent from the registry, inherited names included", () => {
    const all = caller("offline_access", "mcp:tools");
    for (const tool of ["missing", "toString", "constructor", "__proto__"]) {
      expect(canCallTool(REG, all, tool)).toBe(false);
    }
  });
});

// Compile-time: a full profile and record type-check (bun test runs no tsc;
// `bun run typecheck` does).
test("the shared types admit a complete value", () => {
  const profile: ServeProfile = {
    id: "example",
    mcpPath: "/mcp",
    methods: { get: "405", head: "405", other: "post-path" },
    passUnknown: false,
    authPrefixes: { api: ["/api/auth/"], wellKnown: ["/.well-known/"] },
    entry: { kind: "transport", json: true },
    bodyLimit: { oauth: 4_194_304, bearer: 4_194_304, local: null, none: 4_194_304 },
    deadlineMs: null,
    unknownTool: "protocolError",
    requireCaller: true,
    oauthScopes: ["mcp:tools"],
    hostCheck: {
      hosts: {
        list: ["app.example.test"],
        whenEmpty: "allow-all",
        match: "exact",
        loopback: "none",
      },
      origins: { list: [], whenEmpty: "allow-all", absent: "allow" },
      refusal: "404-text",
      appliesTo: "mcp",
    },
    delegated: false,
    clientIpHeader: null,
    bodies: {
      unauthorizedNoSub: "jsonrpc-401",
      jwksFailure: "503-retry",
      notFound: "text-not-found",
      internal: "text-500",
      tooLarge: "jsonrpc-413",
      parseError: "jsonrpc-400",
    },
    logNames: {},
    shutdown: { drainMs: 1, forceMs: 1, poolEndTimeoutS: 1, flushMs: 1 },
  };
  const record: CallRecord = {
    stage: "handler",
    caller: "app.example.test",
    onBehalfOf: null,
    turnId: null,
    tool: "echo",
    args: {},
    durationMs: 0,
    ok: true,
    errorClass: null,
    errorMessage: null,
    resultIds: null,
    phases: null,
    tokens: null,
    costUsd: null,
    costNote: null,
    outputText: null,
    extra: null,
    serverSha: null,
    clientUa: null,
    mcpProtocol: null,
  };
  const seen: CallRecord[] = [];
  const sink: CallSink = { record: (r) => seen.push(r) };
  const wiring: UsageWiring = {
    sinks: [sink],
    keepArgs: true,
    keepOutput: false,
    prices: null,
    spend: null,
    serverSha: null,
  };
  wiring.sinks[0]?.record(record);
  expect(seen).toEqual([record]);
  expect(profile.entry.kind).toBe("transport");
});
