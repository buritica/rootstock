import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  type CallHandle,
  currentCall,
  installSeams,
  LOCAL_CALLER,
  localRequestContext,
  type RequestContext,
} from "./call.ts";
import { captureLog, fakeTime } from "./fakes.test-support.ts";
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
    admin: "admin",
    later: "mcp:tools",
  },
  implies: { "mcp:tools": ["mcp:tools"], admin: ["admin", "mcp:tools"] },
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
  ctx?: RequestContext;
  hooks?: Parameters<typeof installSeams>[1]["hooks"];
  register?: (server: McpServer) => void;
}

async function stdio(s: Setup = {}) {
  const time = fakeTime();
  const log = captureLog();
  const records: CallRecord[] = [];
  const caller = s.caller ?? LOCAL_CALLER(new Set(["mcp:tools"]));
  const server = new McpServer({ name: "t", version: "0" });
  installSeams(server, {
    profile: { unknownTool: s.unknownTool ?? "protocolError" },
    caller,
    toolScopes: SCOPES,
    limits: s.limits === undefined ? NO_LIMITS : s.limits,
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
    const { peer } = await stdio({
      register: (server) =>
        server.registerTool("slow", { inputSchema: { n: z.number() } }, async ({ n }) => {
          currentCall().setArgs({ n });
          await new Promise((r) => setTimeout(r, 10 - n));
          seen.push(
            `${n}:${JSON.stringify(currentCall().tool)}:${(currentCall() as CallHandle).tool}`,
          );
          currentCall().setResultIds([n]);
          return { content: [{ type: "text", text: String(n) }] };
        }),
    });
    const all = await Promise.all([1, 2, 3].map((n) => peer.callTool("slow", { n })));
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
    const { peer } = await stdio({
      usage,
      hooks: { onRegister: (n) => names.push(n) },
      register: (server) => {
        server.registerTool("admin", {}, async () => ({ content: [] }));
        server.registerTool("undeclared", {}, async () => ({ content: [] }));
      },
    });
    const list = resultOf(await peer.request("tools/list", {})).tools as { name: string }[];
    expect(list.map((t) => t.name)).toEqual(["echo", "boom"]);
    expect(names).toEqual(["echo", "boom", "admin", "undeclared"]);
    expect(registered).toEqual(["echo", "boom"]);
    expect((await peer.callTool("admin")).error).toEqual({
      code: -32602,
      message: "Tool admin not found",
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
    server.registerTool("later", { inputSchema: { v: z.string() } }, async ({ v }) => {
      currentCall().setExtra({ late: true });
      return { content: [{ type: "text", text: v }] };
    });
    expect((await peer.callTool("later", { v: 1 })).result).toMatchObject({ isError: true });
    expect(resultOf(await peer.callTool("later", { v: "b" })).content).toEqual([
      { type: "text", text: "b" },
    ]);
    expect(records.map((r) => [r.tool, r.stage, r.errorClass, r.extra])).toEqual([
      ["echo", "handler", null, null],
      ["later", "rejected", "InvalidParams", null],
      ["later", "handler", null, { late: true }],
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
    const limits: Limits = {
      ...NO_LIMITS,
      concurrency: { pass: { tools: ["slow", "spend"], max: 1, busy: (t) => `${t} is busy` } },
    };
    const { peer, records } = await stdio({
      limits,
      register: (server) => {
        server.registerTool("slow", {}, async () => {
          await gate;
          return { content: [{ type: "text", text: "done" }] };
        });
        server.registerTool("spend", {}, async () => ({
          content: [{ type: "text", text: "ran" }],
        }));
      },
    });
    const first = peer.callTool("slow");
    await new Promise((r) => setTimeout(r, 5));
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
    expect(log.lines).toContainEqual(["serve.turn_budget_exhausted", { tool: "spend", used: 3 }]);
  });

  test("a limits tool toolScopes does not declare is refused", async () => {
    const limits: Limits = {
      ...NO_LIMITS,
      perTool: { ghost: { capacity: 1, refillPerSecond: 1, maxKeys: 1 } },
    };
    await expect(stdio({ limits })).rejects.toThrow(/limits.perTool names "ghost"/);
  });

  test("the same Limits object shares bucket state across servers", async () => {
    const limits: Limits = {
      ...NO_LIMITS,
      perTool: { echo: { capacity: 1, refillPerSecond: 1, maxKeys: 10 } },
    };
    const a = await stdio({ limits });
    const b = await stdio({ limits });
    expect(resultOf(await a.peer.callTool("echo", { text: "x" })).isError).toBeUndefined();
    expect(resultOf(await b.peer.callTool("echo", { text: "x" })).isError).toBe(true);
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
