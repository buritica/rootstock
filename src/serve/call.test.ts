import { describe, expect, test } from "bun:test";
import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  type CallHandle,
  currentCall,
  installSeams,
  LOCAL_CALLER,
  localRequestContext,
  type RequestContext,
  seamRuntime,
} from "./call.ts";
import { captureLog, fakeTime, flush } from "./fakes.test-support.ts";
import type { Limits } from "./limits.ts";
import { connectPeer } from "./rpc.test-support.ts";
import {
  type Caller,
  type CallRecord,
  type CallSink,
  defineToolScopes,
  type UsageWiring,
} from "./types.ts";

const SCOPES = defineToolScopes({
  id: "test",
  tools: {
    echo: "mcp:tools",
    slow: "mcp:tools",
    boom: "mcp:tools",
    spend: "mcp:tools",
  },
  implies: { "mcp:tools": ["mcp:tools"] },
});

const NO_LIMITS: Limits = {
  refusal: null,
  serving: null,
  perTool: {},
  concurrency: {},
  turnBudget: null,
  logIntervalMs: 1000,
};

function wiring(records: CallRecord[], over: Partial<UsageWiring> = {}): UsageWiring {
  const sink: CallSink = { record: (r) => records.push(r) };
  return {
    sinks: [sink],
    keepArgs: true,
    keepOutput: true,
    price: (tokens, estimated) => ({
      costUsd: "0.5",
      costNote: `${Object.keys(tokens).sort().join(",")}${estimated ? ":estimated" : ""}`,
    }),
    errorClassOf: (err, classify) =>
      classify?.(err) ?? (err instanceof Error ? err.name : "non-Error throw"),
    spend: null,
    serverSha: "sha1",
    ...over,
  };
}

interface Setup {
  caller?: Caller;
  limits?: Limits | null;
  usage?: UsageWiring | null;
  unknownTool?: "isError" | "protocolError";
  toolThrow?: "message" | "generic";
  ctx?: RequestContext;
  hooks?: Parameters<typeof installSeams>[1]["hooks"];
  register?: (server: McpServer) => void;
  time?: ReturnType<typeof fakeTime>;
  toolScopes?: typeof SCOPES;
  log?: ReturnType<typeof captureLog>;
}

async function stdio(s: Setup = {}) {
  const time = s.time ?? fakeTime();
  const log = s.log ?? captureLog();
  const records: CallRecord[] = [];
  const caller = s.caller ?? LOCAL_CALLER(new Set(["mcp:tools"]));
  const server = new McpServer({ name: "t", version: "0" });
  installSeams(server, {
    profile: { unknownTool: s.unknownTool ?? "protocolError", toolThrow: s.toolThrow ?? "message" },
    caller,
    toolScopes: s.toolScopes ?? SCOPES,
    // A fresh object per server: one Limits shared by servers with other logs is rebuilt (and says so).
    limits: s.limits === undefined ? { ...NO_LIMITS } : s.limits,
    usage: s.usage === undefined ? wiring(records) : s.usage,
    ctx: s.ctx ?? localRequestContext(caller),
    hooks: s.hooks ?? {},
    clock: time,
    log,
  });
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool("boom", { description: "boom" }, async () => {
    throw new RangeError("kaboom");
  });
  s.register?.(server);
  const peer = await connectPeer(server);
  return { server, peer, records, log, time, caller };
}

const resultOf = (m: Record<string, unknown>) => m.result as Record<string, unknown>;

describe("SDK details both seams rely on (stdio; the HTTP entries repeat this in service.test.ts)", () => {
  test("unknown tool, protocolError: the SDK's JSON-RPC error, recorded rejected/UnknownTool", async () => {
    const { peer, records } = await stdio();
    const res = await peer.callTool("nope", {});
    expect(res.error).toEqual({ code: -32602, message: "Tool nope not found" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stage: "rejected",
      tool: "nope",
      ok: false,
      errorClass: "UnknownTool",
      args: {},
    });
  });

  test("unknown tool, isError: an isError result with the SDK's text (the wire puts content first)", async () => {
    const { peer, records } = await stdio({ unknownTool: "isError" });
    const res = await peer.callTool("nope");
    expect(JSON.stringify(res.result)).toBe(
      '{"content":[{"type":"text","text":"Tool nope not found"}],"isError":true}',
    );
    expect(records[0]).toMatchObject({ stage: "rejected", errorClass: "UnknownTool" });
  });

  for (const unknownTool of ["isError", "protocolError"] as const) {
    test(`invalid params (${unknownTool}): the SDK returns isError, no handler runs, InvalidParams`, async () => {
      const { peer, records } = await stdio({ unknownTool });
      const res = resultOf(await peer.callTool("echo", { text: 5 }));
      expect(res.isError).toBe(true);
      const text = (res.content as { text: string }[])[0]?.text ?? "";
      expect(text.startsWith("Input validation error: Invalid arguments for tool echo: ")).toBe(
        true,
      );
      expect(Object.keys(res)).toEqual(["content", "isError"]);
      expect(records[0]).toMatchObject({
        stage: "rejected",
        errorClass: "InvalidParams",
        args: { text: 5 },
      });
    });
  }

  test("a throwing tool: the SDK's isError with the message; stage handler", async () => {
    const { peer, records } = await stdio();
    const res = resultOf(await peer.callTool("boom"));
    expect(res).toEqual({ content: [{ type: "text", text: "kaboom" }], isError: true });
    expect(records[0]).toMatchObject({
      stage: "handler",
      ok: false,
      errorClass: "RangeError",
      errorMessage: "kaboom",
    });
  });

  test("batch-style concurrency: each call's handle is its own", async () => {
    const seen: string[] = [];
    // All three start, then finish in reverse order: each must still see its own handle.
    const gates = new Map<number, () => void>();
    let allStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      allStarted = r;
    });
    const { peer } = await stdio({
      register: (server) =>
        server.registerTool("slow", { inputSchema: { n: z.number() } }, async ({ n }) => {
          currentCall().setArgs({ n });
          await new Promise<void>((r) => {
            gates.set(n, r);
            if (gates.size === 3) allStarted();
          });
          seen.push(
            `${n}:${JSON.stringify(currentCall().tool)}:${(currentCall() as CallHandle).tool}`,
          );
          currentCall().setResultIds([n]);
          return { content: [{ type: "text", text: String(n) }] };
        }),
    });
    const pending = Promise.all([1, 2, 3].map((n) => peer.callTool("slow", { n })));
    await started;
    for (const n of [3, 2, 1]) {
      gates.get(n)?.();
      await flush();
    }
    const all = await pending;
    expect(all.map((m) => (resultOf(m).content as { text: string }[])[0]?.text)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(seen.sort()).toEqual(['1:"slow":slow', '2:"slow":slow', '3:"slow":slow']);
  });
});

describe("registration seam", () => {
  test("a tool the caller's scopes miss, or toolScopes lacks, is removed; onRegister sees every tool", async () => {
    const names: string[] = [];
    const registered: string[] = [];
    const records: CallRecord[] = [];
    const usage = wiring(records, {
      sinks: [{ record: (r) => records.push(r), onRegister: (t) => registered.push(t) }],
    });
    // slow needs a scope this caller lacks; spend is not declared at all.
    const toolScopes = defineToolScopes({
      id: "test",
      tools: { echo: "mcp:tools", boom: "mcp:tools", slow: "profile" },
      implies: { "mcp:tools": ["mcp:tools"], profile: ["profile", "mcp:tools"] },
    });
    const { peer } = await stdio({
      usage,
      toolScopes,
      hooks: { onRegister: (n) => names.push(n) },
      register: (server) => {
        server.registerTool("slow", {}, async () => ({ content: [] }));
        server.registerTool("spend", {}, async () => ({ content: [] }));
      },
    });
    const list = resultOf(await peer.request("tools/list", {})).tools as { name: string }[];
    expect(list.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(names).toEqual(["echo", "boom", "slow", "spend"]);
    expect(registered).toEqual(["echo", "boom"]);
    expect((await peer.callTool("slow")).error).toEqual({
      code: -32602,
      message: "Tool slow not found",
    });
  });

  test("the call-time scope guard answers the labeled error, stage refused/ScopeDenied", async () => {
    const scopes = new Set(["mcp:tools"]);
    const { peer, records } = await stdio({ caller: { name: "c", kind: "bearer", scopes } });
    scopes.delete("mcp:tools");
    const res = resultOf(await peer.callTool("echo", { text: "x" }));
    expect(JSON.stringify(res)).toBe(
      '{"content":[{"type":"text","text":"{\\"error\\":\\"echo: this token\'s scopes do not allow it\\"}"}],"isError":true}',
    );
    expect(records[0]).toMatchObject({ stage: "refused", errorClass: "ScopeDenied", ok: false });
  });

  test("both seams cover a tool registered after the first call", async () => {
    const { server, peer, records } = await stdio();
    await peer.callTool("echo", { text: "a" });
    server.registerTool("slow", { inputSchema: { v: z.string() } }, async ({ v }) => {
      currentCall().setExtra({ late: true });
      return { content: [{ type: "text", text: v }] };
    });
    expect((await peer.callTool("slow", { v: 1 })).result).toMatchObject({ isError: true });
    expect(resultOf(await peer.callTool("slow", { v: "b" })).content).toEqual([
      { type: "text", text: "b" },
    ]);
    expect(records.map((r) => [r.tool, r.stage, r.errorClass, r.extra])).toEqual([
      ["echo", "handler", null, null],
      ["slow", "rejected", "InvalidParams", null],
      ["slow", "handler", null, { late: true }],
    ]);
  });
});

describe("the handle", () => {
  test("fills a row from inside a handler, including an error the handler caught", async () => {
    const ctx: RequestContext = {
      caller: { name: "u1", kind: "oauth", scopes: new Set(["mcp:tools"]) },
      requestId: "r1",
      request: { headers: new Headers(), url: new URL("http://app.example.test/mcp") },
      delegated: { onBehalfOf: "someone", turnId: "t-1" },
      client: { ua: "ua/1", mcpProtocol: "2025-06-18" },
    };
    const { peer, records, time } = await stdio({
      caller: ctx.caller,
      ctx,
      hooks: { classifyError: (e) => (e instanceof SyntaxError ? "GuardLike" : undefined) },
      register: (server) =>
        server.registerTool("spend", { inputSchema: { q: z.string() } }, async ({ q }) => {
          const h = currentCall();
          h.setArgs({ q, normalized: true });
          h.phase("read", 3.4);
          h.phase("read", 1);
          h.meter({ model: "m-b", input: 10, output: 2 });
          h.meter({ model: "m-a", input: 1, output: 1, estimated: true });
          h.meter({ model: "m-b", input: 5, output: 0 });
          h.setResultIds(["e1", "e2"]);
          time.advance(42);
          try {
            throw new SyntaxError("bad row");
          } catch (err) {
            h.fail(err);
          }
          return { content: [{ type: "text", text: "partial" }] };
        }),
    });
    await peer.callTool("spend", { q: "hi" });
    expect(records[0]).toEqual({
      stage: "handler",
      caller: "u1",
      onBehalfOf: "someone",
      turnId: "t-1",
      tool: "spend",
      args: { q: "hi", normalized: true },
      durationMs: 42,
      ok: false,
      errorClass: "GuardLike",
      errorMessage: "bad row",
      resultIds: ["e1", "e2"],
      phases: { read: 4 },
      tokens: { "m-b": { input: 15, output: 2 }, "m-a": { input: 1, output: 1 } },
      costUsd: "0.5",
      costNote: "m-a,m-b:estimated",
      outputText: "partial",
      extra: null,
      serverSha: "sha1",
      clientUa: "ua/1",
      mcpProtocol: "2025-06-18",
    });
  });

  test("nothing metered: tokens and cost null; keepArgs/keepOutput off", async () => {
    const records: CallRecord[] = [];
    const { peer } = await stdio({
      usage: wiring(records, { keepArgs: false, keepOutput: false }),
    });
    await peer.callTool("echo", { text: "secret" });
    expect(records[0]).toMatchObject({
      args: {},
      tokens: null,
      costUsd: null,
      costNote: null,
      outputText: null,
      ok: true,
    });
  });

  test("a throwing price, errorClassOf or sink never fails the call", async () => {
    const records: CallRecord[] = [];
    const usage = wiring(records, {
      price: () => {
        throw new Error("no");
      },
      errorClassOf: () => {
        throw new Error("no");
      },
      sinks: [
        {
          record: () => {
            throw new Error("sink down");
          },
        },
        { record: (r) => records.push(r) },
      ],
    });
    const { peer, log } = await stdio({
      usage,
      register: (server) =>
        server.registerTool("spend", {}, async () => {
          currentCall().meter({ model: "m", input: 1, output: 1 });
          throw new Error("x");
        }),
    });
    const res = resultOf(await peer.callTool("spend"));
    expect(res.isError).toBe(true);
    expect(records[0]).toMatchObject({
      costUsd: null,
      costNote: "price_failed",
      errorClass: "unreadable error",
    });
    expect(log.names()).toEqual(["usage.price_failed", "usage.sink_failed"]);
  });

  test("price runs once, only for a call that metered; estimated when any meter was", async () => {
    const priced: [string[], boolean][] = [];
    const records: CallRecord[] = [];
    const usage = wiring(records, {
      price: (tokens, estimated) => {
        priced.push([Object.keys(tokens), estimated]);
        return { costUsd: "1", costNote: null };
      },
    });
    const { peer } = await stdio({
      usage,
      register: (server) =>
        server.registerTool("spend", { inputSchema: { est: z.boolean() } }, async ({ est }) => {
          currentCall().meter({ model: "m", input: 1, output: 1 });
          currentCall().meter({ model: "m", input: 1, output: 1, estimated: est });
          return { content: [] };
        }),
    });
    await peer.callTool("echo", { text: "no meter" });
    await peer.callTool("spend", { est: false });
    await peer.callTool("spend", { est: true });
    expect(priced).toEqual([
      [["m"], false],
      [["m"], true],
    ]);
    expect(records.map((r) => r.costUsd)).toEqual([null, "1", "1"]);
  });

  test("a rejected spend write never becomes an unhandled rejection", async () => {
    // The seam must attach a rejection handler to the promise the charger returns.
    let handled = false;
    const rejected = () => {
      const p = Promise.reject(new Error("write failed"));
      const then = p.then.bind(p);
      // biome-ignore lint/suspicious/noThenProperty: spying on the handler the seam attaches is the point
      p.then = ((ok, bad) => {
        if (bad !== undefined) handled = true;
        return then(ok, bad);
      }) as typeof p.then;
      return p;
    };
    {
      const usage = wiring([], {
        spend: {
          forCaller: () => ({
            assertWithin: async () => {},
            record: rejected,
          }),
        },
      });
      const { peer } = await stdio({
        usage,
        register: (server) =>
          server.registerTool("spend", {}, async () => {
            currentCall().meter({ model: "m", input: 1, output: 0 });
            return { content: [] };
          }),
      });
      await peer.callTool("spend");
      expect(handled).toBe(true);
    }
  });

  test("meter queues the spend write; assertWithinSpend reaches the charger", async () => {
    const calls: string[] = [];
    const records: CallRecord[] = [];
    const usage = wiring(records, {
      spend: {
        forCaller: (key) => ({
          assertWithin: async () => {
            calls.push(`assert:${key}`);
          },
          record: async (u) => {
            calls.push(`record:${key}:${u.input}`);
            throw new Error("write failed is the charger's to log");
          },
        }),
      },
    });
    const { peer } = await stdio({
      usage,
      register: (server) =>
        server.registerTool("spend", {}, async () => {
          await currentCall().assertWithinSpend();
          currentCall().meter({ model: "m", input: 7, output: 0 });
          return { content: [] };
        }),
    });
    await peer.callTool("spend");
    expect(calls).toEqual(["assert:local", "record:local:7"]);
  });

  test("currentCall outside a call throws ERR_ROOTSTOCK_SERVE_NO_CALL", () => {
    expect(() => currentCall()).toThrow(
      expect.objectContaining({ code: "ERR_ROOTSTOCK_SERVE_NO_CALL" }),
    );
  });

  test("aroundCall wraps the SDK handler with the handle", async () => {
    const order: string[] = [];
    const { peer } = await stdio({
      hooks: {
        aroundCall: async (call, next) => {
          order.push(`before:${call.tool}`);
          const r = await next();
          order.push("after");
          return r;
        },
      },
    });
    await peer.callTool("echo", { text: "x" });
    expect(order).toEqual(["before:echo", "after"]);
  });
});

describe("toolThrow (F5): what a handler's throw shows the client", () => {
  // A driver-style message: the text a client must not see under "generic".
  const LEAKY = "db error: select * from t where id = $1\nparams: 7";
  const register = (server: McpServer) => {
    server.registerTool("leaky", { description: "leaky" }, async () => {
      throw new Error(LEAKY);
    });
    server.registerTool("proto", { description: "proto" }, async () => {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "id must be positive");
    });
    server.registerTool("caught", { description: "caught" }, async () => {
      currentCall().fail(new TypeError("handled inside"));
      return { content: [{ type: "text", text: "partial" }], isError: true };
    });
    server.registerTool("text", { description: "text" }, async () => {
      throw "a bare string";
    });
  };
  const toolScopes = defineToolScopes({
    id: "test",
    tools: Object.fromEntries(
      ["echo", "boom", "leaky", "proto", "caught", "text"].map((t) => [t, "mcp:tools"]),
    ),
    implies: { "mcp:tools": ["mcp:tools"] },
  });

  test('"generic": the labeled error, isError; the record keeps class and full message', async () => {
    const { peer, records } = await stdio({ toolThrow: "generic", register, toolScopes });
    const res = resultOf(await peer.callTool("leaky"));
    expect(JSON.stringify(res)).toBe(
      '{"content":[{"type":"text","text":"{\\"error\\":\\"leaky failed\\"}"}],"isError":true}',
    );
    expect(JSON.stringify(res)).not.toContain("db error");
    expect(records[0]).toMatchObject({
      stage: "handler",
      ok: false,
      errorClass: "Error",
      errorMessage: LEAKY,
      // keepOutput: the text the client got, never the message.
      outputText: '{"error":"leaky failed"}',
    });
    // A non-Error throw is unlabeled too.
    expect(resultOf(await peer.callTool("text"))).toEqual({
      content: [{ type: "text", text: '{"error":"text failed"}' }],
      isError: true,
    });
    expect(records[1]).toMatchObject({ stage: "handler", errorMessage: "a bare string" });
  });

  test("\"message\": today's bytes, the SDK's isError with the message", async () => {
    const { peer, records } = await stdio({ toolThrow: "message", register, toolScopes });
    expect(resultOf(await peer.callTool("leaky"))).toEqual({
      content: [{ type: "text", text: LEAKY }],
      isError: true,
    });
    expect(records[0]).toMatchObject({
      stage: "handler",
      ok: false,
      errorClass: "Error",
      errorMessage: LEAKY,
      outputText: LEAKY,
    });
  });

  test('"generic": an aroundCall hook sees the result the client gets', async () => {
    const seen: unknown[] = [];
    const { peer, records } = await stdio({
      toolThrow: "generic",
      register,
      toolScopes,
      hooks: {
        aroundCall: async (_call, next) => {
          const r = await next();
          seen.push(r);
          return r;
        },
      },
    });
    const res = resultOf(await peer.callTool("leaky"));
    expect(seen).toEqual([res]);
    expect(JSON.stringify(seen)).not.toContain("db error");
    expect(records[0]).toMatchObject({ errorMessage: LEAKY });
  });

  test('"generic" is read at install: changing the profile afterwards does not leak', async () => {
    const profile = { unknownTool: "protocolError" as const, toolThrow: "generic" as string };
    const server = new McpServer({ name: "t", version: "0" });
    const caller = LOCAL_CALLER(new Set(["mcp:tools"]));
    installSeams(server, {
      profile: profile as never,
      caller,
      toolScopes,
      limits: { ...NO_LIMITS },
      usage: null,
      ctx: localRequestContext(caller),
      hooks: {},
      clock: fakeTime(),
      log: captureLog(),
    });
    register(server);
    profile.toolThrow = "message";
    const peer = await connectPeer(server);
    expect(resultOf(await peer.callTool("leaky"))).toEqual({
      content: [{ type: "text", text: '{"error":"leaky failed"}' }],
      isError: true,
    });
  });

  test('"generic" leaves a thrown ProtocolError, a returned isError, refusals and rejections alone', async () => {
    const limits: Limits = {
      ...NO_LIMITS,
      perTool: { echo: { capacity: 1, refillPerSecond: 1, maxKeys: 10 } },
    };
    const { peer, records } = await stdio({ toolThrow: "generic", register, toolScopes, limits });
    expect(resultOf(await peer.callTool("proto"))).toEqual({
      content: [{ type: "text", text: "id must be positive" }],
      isError: true,
    });
    expect(resultOf(await peer.callTool("caught"))).toEqual({
      content: [{ type: "text", text: "partial" }],
      isError: true,
    });
    await peer.callTool("echo", { text: "a" });
    expect(resultOf(await peer.callTool("echo", { text: "b" }))).toEqual({
      content: [{ type: "text", text: "Rate limit exceeded for echo — try again shortly." }],
      isError: true,
    });
    const invalid = resultOf(await peer.callTool("echo", { text: 5 }));
    expect((invalid.content as { text: string }[])[0]?.text).toStartWith("Input validation error:");
    expect((await peer.callTool("nope", {})).error).toEqual({
      code: -32602,
      message: "Tool nope not found",
    });
    expect(records.map((r) => [r.stage, r.errorClass, r.errorMessage])).toEqual([
      ["handler", "ProtocolError", "id must be positive"],
      ["handler", "TypeError", "handled inside"],
      ["handler", null, null],
      ["refused", "RateLimited", null],
      ["rejected", "InvalidParams", null],
      ["rejected", "UnknownTool", null],
    ]);
  });

  test("a profile without toolThrow (pre-0.13) is refused", () => {
    for (const toolThrow of [undefined, "quiet"]) {
      const server = new McpServer({ name: "t", version: "0" });
      const caller = LOCAL_CALLER(new Set(["mcp:tools"]));
      expect(() =>
        installSeams(server, {
          profile: { unknownTool: "protocolError", toolThrow } as never,
          caller,
          toolScopes: SCOPES,
          limits: null,
          usage: null,
          ctx: localRequestContext(caller),
          hooks: {},
          clock: fakeTime(),
          log: captureLog(),
        }),
      ).toThrow(/profile.toolThrow must be "message" or "generic"/);
    }
  });
});

describe("limits in the seams", () => {
  test("per-tool bucket: charged only after validation, refusal thrown, refused/RateLimited", async () => {
    const limits: Limits = {
      ...NO_LIMITS,
      perTool: { echo: { capacity: 1, refillPerSecond: 1, maxKeys: 10 } },
    };
    const { peer, records, log } = await stdio({ limits });
    await peer.callTool("echo", { text: 1 }); // invalid: never reaches the bucket
    expect(resultOf(await peer.callTool("echo", { text: "a" })).isError).toBeUndefined();
    const refused = resultOf(await peer.callTool("echo", { text: "b" }));
    expect(refused).toEqual({
      content: [{ type: "text", text: "Rate limit exceeded for echo — try again shortly." }],
      isError: true,
    });
    expect(records.map((r) => [r.stage, r.errorClass])).toEqual([
      ["rejected", "InvalidParams"],
      ["handler", null],
      ["refused", "RateLimited"],
    ]);
    expect(log.lines).toEqual([
      ["serve.rate_limited", { tool: "echo", caller: "local", bucket: "tool:echo", suppressed: 0 }],
    ]);
  });

  test("a concurrency group is shared by its tools, per caller, with the profile's text", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let slowStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      slowStarted = r;
    });
    const limits: Limits = {
      ...NO_LIMITS,
      concurrency: { pass: { tools: ["slow", "spend"], max: 1, busy: (t) => `${t} is busy` } },
    };
    const { peer, records } = await stdio({
      limits,
      register: (server) => {
        server.registerTool("slow", {}, async () => {
          slowStarted();
          await gate;
          return { content: [{ type: "text", text: "done" }] };
        });
        server.registerTool("spend", {}, async () => ({
          content: [{ type: "text", text: "ran" }],
        }));
      },
    });
    const first = peer.callTool("slow");
    await started;
    const busy = resultOf(await peer.callTool("spend"));
    expect(JSON.stringify(busy)).toBe(
      '{"content":[{"type":"text","text":"{\\"error\\":\\"spend is busy\\"}"}],"isError":true}',
    );
    release();
    await first;
    expect(resultOf(await peer.callTool("spend")).content).toEqual([{ type: "text", text: "ran" }]);
    expect(records.map((r) => [r.tool, r.stage, r.errorClass])).toEqual([
      ["spend", "refused", "Busy"],
      ["slow", "handler", null],
      ["spend", "handler", null],
    ]);
  });

  test("turn budget: only a kept turn id is charged; past the cap the call does not run", async () => {
    let ran = 0;
    const caller: Caller = { name: "agent", kind: "oauth", scopes: new Set(["mcp:tools"]) };
    const ctx = {
      ...localRequestContext(caller),
      delegated: { onBehalfOf: null, turnId: "turn-1" },
    };
    const limits: Limits = {
      ...NO_LIMITS,
      turnBudget: { cap: 2, warnAt: 1, maxTurns: 10, exhausted: (n) => `spent ${n}` },
    };
    const charges: unknown[] = [];
    const { peer, records, log } = await stdio({
      caller,
      ctx,
      limits,
      register: (server) =>
        server.registerTool("spend", {}, async () => {
          ran++;
          charges.push(currentCall().turnCharge);
          return { content: [] };
        }),
    });
    await peer.callTool("spend");
    await peer.callTool("nope"); // a rejected call still counts against the turn
    const third = resultOf(await peer.callTool("spend"));
    expect(third).toEqual({
      content: [
        {
          type: "text",
          text: '{"turnBudget":{"remaining":0,"exhausted":true},"message":"spent 2"}',
        },
      ],
    });
    expect(ran).toBe(1);
    expect(charges).toEqual([{ used: 1, remaining: 1, exhausted: false }]);
    expect(records.at(-1)).toMatchObject({
      stage: "refused",
      errorClass: "TurnBudgetExhausted",
      turnId: "turn-1",
    });
    expect(log.lines.filter(([e]) => e === "serve.turn_budget_exhausted")).toEqual([
      [
        "serve.turn_budget_exhausted",
        { tool: "spend", used: 3, caller: "agent", turnId: "turn-1" },
      ],
    ]);
  });

  test("a limits tool toolScopes does not declare is refused", async () => {
    const limits: Limits = {
      ...NO_LIMITS,
      perTool: { ghost: { capacity: 1, refillPerSecond: 1, maxKeys: 1 } },
    };
    await expect(stdio({ limits })).rejects.toThrow(/limits.perTool names "ghost"/);
  });

  test("the same Limits object and deps share bucket state across servers; other deps do not", async () => {
    const limits: Limits = {
      ...NO_LIMITS,
      perTool: { echo: { capacity: 1, refillPerSecond: 1, maxKeys: 10 } },
    };
    const time = fakeTime();
    const log = captureLog();
    const a = await stdio({ limits, time, log });
    const b = await stdio({ limits, time, log });
    const other = await stdio({ limits, time }); // its own log: its own state
    expect(resultOf(await a.peer.callTool("echo", { text: "x" })).isError).toBeUndefined();
    expect(resultOf(await b.peer.callTool("echo", { text: "x" })).isError).toBe(true);
    expect(resultOf(await other.peer.callTool("echo", { text: "x" })).isError).toBeUndefined();
  });
});

test("installSeams on a stdio-style server with no usage wiring", async () => {
  const { peer } = await stdio({ usage: null, limits: null });
  expect(resultOf(await peer.callTool("echo", { text: "hi" })).content).toEqual([
    { type: "text", text: "hi" },
  ]);
  expect(localRequestContext(LOCAL_CALLER(new Set()))).toMatchObject({
    delegated: { onBehalfOf: null, turnId: null },
    client: { ua: null, mcpProtocol: null },
  });
  expect([...localRequestContext(LOCAL_CALLER(new Set())).request.headers]).toEqual([]);
});

describe("throws out of rootstock's own seam", () => {
  const throwingLog = () =>
    Object.assign(
      () => {
        throw new Error("log down");
      },
      { lines: [], names: () => [] },
    ) as unknown as ReturnType<typeof captureLog>;

  test("an aroundCall throw answers a generic error, never its message, recorded by errorClassOf", async () => {
    const { peer, records } = await stdio({
      hooks: {
        aroundCall: async () => {
          throw new RangeError("secret detail");
        },
      },
    });
    const res = await peer.callTool("echo", { text: "x" });
    expect(res.error).toEqual({ code: -32603, message: "Internal error" });
    expect(JSON.stringify(res)).not.toContain("secret detail");
    expect(records.map((r) => [r.stage, r.ok, r.errorClass])).toEqual([
      ["rejected", false, "RangeError"],
    ]);
  });

  test("an aroundCall that rethrows the SDK's own error passes it through", async () => {
    const { peer } = await stdio({
      hooks: { aroundCall: async (_c, next) => next() },
    });
    expect((await peer.callTool("nope")).error).toEqual({
      code: -32602,
      message: "Tool nope not found",
    });
  });

  test("a turnBudget.exhausted throw answers a generic error, recorded", async () => {
    const caller: Caller = { name: "agent", kind: "oauth", scopes: new Set(["mcp:tools"]) };
    const ctx = { ...localRequestContext(caller), delegated: { onBehalfOf: null, turnId: "t" } };
    const { peer, records } = await stdio({
      caller,
      ctx,
      limits: {
        ...NO_LIMITS,
        turnBudget: {
          cap: 1,
          warnAt: 0,
          maxTurns: 10,
          exhausted: () => {
            throw new TypeError("wording broke");
          },
        },
      },
    });
    await peer.callTool("echo", { text: "a" });
    const res = await peer.callTool("echo", { text: "b" });
    expect(res.error).toEqual({ code: -32603, message: "Internal error" });
    expect(records.map((r) => [r.stage, r.errorClass])).toEqual([
      ["handler", null],
      ["rejected", "TypeError"],
    ]);
  });

  test("a throwing log never changes an answer, and every sink still records", async () => {
    const caller: Caller = { name: "agent", kind: "oauth", scopes: new Set(["mcp:tools"]) };
    const ctx = { ...localRequestContext(caller), delegated: { onBehalfOf: null, turnId: "t" } };
    const kept: CallRecord[] = [];
    const usage = wiring([], {
      sinks: [
        {
          record: () => {
            throw new Error("sink down");
          },
          onRegister: () => {
            throw new Error("sink down");
          },
        },
        { record: (r) => kept.push(r) },
      ],
      price: () => {
        throw new Error("no prices");
      },
    });
    const { peer } = await stdio({
      caller,
      ctx,
      usage,
      log: throwingLog(),
      limits: {
        ...NO_LIMITS,
        perTool: { echo: { capacity: 1, refillPerSecond: 1, maxKeys: 10 } },
        turnBudget: { cap: 3, warnAt: 0, maxTurns: 10, exhausted: (n) => `spent ${n}` },
      },
      register: (server) =>
        server.registerTool("spend", {}, async () => {
          currentCall().meter({ model: "m", input: 1, output: 0 });
          return { content: [{ type: "text", text: "ran" }] };
        }),
    });
    expect(resultOf(await peer.callTool("spend")).content).toEqual([{ type: "text", text: "ran" }]);
    expect(resultOf(await peer.callTool("echo", { text: "a" })).isError).toBeUndefined();
    expect(resultOf(await peer.callTool("echo", { text: "b" })).isError).toBe(true); // rate limited
    expect(resultOf(await peer.callTool("echo", { text: "c" })).content).toEqual([
      { type: "text", text: '{"turnBudget":{"remaining":0,"exhausted":true},"message":"spent 3"}' },
    ]);
    expect(kept.map((r) => [r.tool, r.errorClass, r.costNote])).toEqual([
      ["spend", null, "price_failed"],
      ["echo", null, null],
      ["echo", "RateLimited", null],
      ["echo", "TurnBudgetExhausted", null],
    ]);
  });
});

test("installSeams on a server that already has tools throws ERR_ROOTSTOCK_SERVE_CONFIG", () => {
  const server = new McpServer({ name: "t", version: "0" });
  server.registerTool("echo", {}, async () => ({ content: [] }));
  const caller = LOCAL_CALLER(new Set(["mcp:tools"]));
  let caught: unknown;
  try {
    installSeams(server, {
      profile: { unknownTool: "protocolError", toolThrow: "message" },
      caller,
      toolScopes: SCOPES,
      limits: NO_LIMITS,
      usage: null,
      ctx: localRequestContext(caller),
      hooks: {},
      clock: fakeTime(),
      log: captureLog(),
    });
  } catch (err) {
    caught = err;
  }
  expect((caught as { code?: string })?.code).toBe("ERR_ROOTSTOCK_SERVE_CONFIG");
  expect(String(caught)).toMatch(/before the first registerTool/);
});

describe("imagine-gate seam details", () => {
  test("one Limits object keeps at most 8 runtimes, least recently used out, and says when it rebuilds", () => {
    const limits: Limits = { ...NO_LIMITS };
    const time = fakeTime();
    const lines: [string, Record<string, unknown>][] = [];
    const logs = Array.from({ length: 9 }, () =>
      Object.assign(
        (e: string, f: Readonly<Record<string, unknown>>) => lines.push([e, { ...f }]),
        {},
      ),
    );
    const first = seamRuntime(limits, SCOPES, time, logs[0] as never);
    expect(seamRuntime(limits, SCOPES, time, logs[0] as never)).toBe(first); // a hit
    for (const l of logs.slice(1)) seamRuntime(limits, SCOPES, time, l as never);
    expect(seamRuntime(limits, SCOPES, time, logs[0] as never)).not.toBe(first); // evicted, rebuilt
    expect(lines.map(([, f]) => f.reason)).toEqual([
      ...Array(7).fill("new-deps"),
      "evicted",
      "evicted",
    ]);
    expect(lines.every(([e]) => e === "serve.seam_runtime_rebuilt")).toBe(true);
  });

  test("turn_budget_exhausted is logged once per caller and turn", async () => {
    const caller: Caller = { name: "agent", kind: "oauth", scopes: new Set(["mcp:tools"]) };
    const ctx = { ...localRequestContext(caller), delegated: { onBehalfOf: null, turnId: "t-9" } };
    const { peer, log } = await stdio({
      caller,
      ctx,
      limits: {
        ...NO_LIMITS,
        turnBudget: { cap: 1, warnAt: 0, maxTurns: 10, exhausted: (n) => `spent ${n}` },
      },
    });
    for (let i = 0; i < 4; i++) await peer.callTool("echo", { text: "x" });
    expect(log.lines.filter(([e]) => e === "serve.turn_budget_exhausted")).toEqual([
      ["serve.turn_budget_exhausted", { tool: "echo", used: 2, caller: "agent", turnId: "t-9" }],
    ]);
  });

  test("an async sink whose record rejects is logged, never unhandled; the other sinks record", async () => {
    let handled = false;
    const kept: CallRecord[] = [];
    const usage = wiring([], {
      sinks: [
        {
          record: () => {
            const p = Promise.reject(new SyntaxError("write failed"));
            const then = p.then.bind(p);
            // biome-ignore lint/suspicious/noThenProperty: spying on the handler the seam attaches is the point
            p.then = ((ok, bad) => {
              if (bad !== undefined) handled = true;
              return then(ok, bad);
            }) as typeof p.then;
            return p as never;
          },
        },
        { record: (r) => kept.push(r) },
      ],
    });
    const { peer, log } = await stdio({ usage });
    await peer.callTool("echo", { text: "x" });
    await flush();
    expect(handled).toBe(true);
    expect(kept).toHaveLength(1);
    expect(log.lines).toContainEqual([
      "usage.sink_failed",
      { tool: "echo", stage: "record", errorClass: "SyntaxError" },
    ]);
  });
});
