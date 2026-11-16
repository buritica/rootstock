// End to end over HTTP for each test profile's shape (service.test-support.ts
// says which §9 column each stands in for), plus the batch and body edges.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { signal, until } from "./fakes.test-support.ts";
import type { Limits } from "./limits.ts";
import {
  CALL_HEADERS,
  call,
  fakeAuth,
  HANDLER_JSON,
  makeService,
  mcpRequest,
  noLimits,
  ORIGIN,
  registerSynthetic,
  rpcOf,
  sdkAnswer,
  snapshot,
  TRANSPORT_EMPTY,
  TRANSPORT_TEXT,
} from "./service.test-support.ts";
import type { McpServiceOptions } from "./service.ts";
import { defineToolScopes, type ServeProfile } from "./types.ts";

const HOST = { host: "app.example.test" };
const both = { bearer: true, oauth: true };
const withAuth = (
  profile: ServeProfile,
  over: Partial<McpServiceOptions> & { slow?: () => Promise<void> } = {},
) => {
  const auth = fakeAuth();
  return { auth, ...makeService({ profile, auth, acceptCredentials: () => both, ...over }) };
};
const limits = (over: Partial<Limits>): Limits => ({ ...noLimits(), ...over });
const bucket = (capacity: number) => ({ capacity, refillPerSecond: 1, maxKeys: 100 });
const post = (body: unknown, token: string) => mcpRequest(body, { token, headers: HOST });

describe("the exact-host, text-body transport shape", () => {
  test("per-tool buckets over HTTP: charged per caller, refused with the SDK's isError text", async () => {
    const { service, records } = withAuth(TRANSPORT_TEXT, {
      limits: limits({ perTool: { echo: bucket(2) } }),
    });
    const texts: unknown[] = [];
    for (const token of ["good:a", "good:a", "good:a", "good:b"]) {
      texts.push(
        await rpcOf(
          (await service.handle(post(call("echo", { text: "x" }), token), {})) as Response,
        ),
      );
    }
    expect(texts[2]).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "Rate limit exceeded for echo — try again shortly." }],
      },
    });
    expect(records.map((r) => [r.caller, r.stage, r.errorClass])).toEqual([
      ["a", "handler", null],
      ["a", "handler", null],
      ["a", "refused", "RateLimited"],
      ["b", "handler", null],
    ]);
  });
});

describe("the handler-entry shape: a concurrency group across HTTP requests", () => {
  const setup = () => {
    const gate = signal();
    const started = signal();
    const svc = withAuth(HANDLER_JSON, {
      limits: limits({
        concurrency: { one: { tools: ["slow"], max: 1, busy: (t) => `${t} is busy` } },
      }),
      slow: () => {
        started.resolve();
        return gate.promise;
      },
    });
    return { ...svc, gate, started };
  };

  test("two concurrent requests from one caller: the second is busy", async () => {
    const { service, records, gate, started } = setup();
    const first = service
      .handle(post(call("slow"), "good:u"), {})
      .then((r) => rpcOf(r as Response));
    await started.promise;
    expect(
      await rpcOf((await service.handle(post(call("slow"), "good:u"), {})) as Response),
    ).toMatchObject({
      result: { isError: true, content: [{ text: '{"error":"slow is busy"}' }] },
    });
    gate.resolve();
    expect(await first).toMatchObject({ result: { content: [{ text: "slow done" }] } });
    expect(records.map((r) => [r.caller, r.stage, r.errorClass])).toEqual([
      ["u", "refused", "Busy"],
      ["u", "handler", null],
    ]);
  });

  test("two callers each get their own slot", async () => {
    const { service, records, gate, started } = setup();
    const first = service
      .handle(post(call("slow"), "good:u"), {})
      .then((r) => rpcOf(r as Response));
    await started.promise;
    const second = service
      .handle(post(call("slow"), "good:v"), {})
      .then((r) => rpcOf(r as Response));
    gate.resolve();
    expect(await Promise.all([first, second])).toMatchObject([
      { result: { content: [{ text: "slow done" }] } },
      { result: { content: [{ text: "slow done" }] } },
    ]);
    await until(() => records.length === 2);
    expect(records.map((r) => r.errorClass)).toEqual([null, null]);
  });
});

describe("batches", () => {
  test("a mixed batch: the allowed call runs, the denied one is refused, one row each", async () => {
    const toolScopes = defineToolScopes({
      id: "test",
      tools: { echo: "mcp:tools", slow: "mcp:tools", boom: "mcp:tools", spend: "profile" },
      implies: { "mcp:tools": ["mcp:tools"], profile: ["profile", "mcp:tools"] },
    });
    const { service, records } = withAuth(TRANSPORT_EMPTY, {
      toolScopes,
      registerTools: (server: McpServer) => {
        registerSynthetic(server);
        server.registerTool("spend", {}, async () => ({
          content: [{ type: "text", text: "spent" }],
        }));
      },
    });
    const res = await service.handle(
      post([call("echo", { text: "a" }, 1), call("spend", {}, 2)], "good:u"),
      {},
    );
    expect(await rpcOf(res as Response)).toMatchObject([
      { id: 1, result: { content: [{ text: "a" }] } },
      { id: 2, result: { isError: true, content: [{ text: "Tool spend not found" }] } },
    ]);
    // Rows land in completion order; the batch's calls run concurrently.
    expect(records.map((r) => [r.tool, r.stage, r.errorClass]).sort()).toEqual([
      ["echo", "handler", null],
      ["spend", "rejected", "UnknownTool"],
    ]);
  });

  test("[] is the SDK's answer and charges nothing beyond the request", async () => {
    const { service } = withAuth(TRANSPORT_EMPTY, { limits: limits({ serving: bucket(1) }) });
    const ours = await service.handle(post([], "good:u"), {});
    const sdk = await sdkAnswer("transport", mcpRequest([]));
    expect(await snapshot(ours)).toEqual(await snapshot(sdk));
  });

  test("101 messages: charged first (429 when the bucket cannot cover them), else the SDK's batch cap", async () => {
    const batch = Array.from({ length: 101 }, (_, i) => call("echo", { text: `${i}` }, i + 1));
    const drained = withAuth(TRANSPORT_EMPTY, { limits: limits({ serving: bucket(50) }) });
    expect((await drained.service.handle(post(batch, "good:u"), {}))?.status).toBe(429);
    expect(drained.records).toEqual([]);
    const { service, records } = withAuth(TRANSPORT_EMPTY);
    const ours = await service.handle(post(batch, "good:u"), {});
    const sdk = await sdkAnswer("transport", mcpRequest(batch));
    expect(ours?.status).toBe(400);
    expect(await snapshot(ours)).toEqual(await snapshot(sdk));
    expect(records).toEqual([]);
  });
});

describe("bodies", () => {
  test("a short Content-Length with a longer streamed body is cut at the limit: 413", async () => {
    const { service, records } = withAuth(TRANSPORT_TEXT);
    const text = JSON.stringify(call("echo", { text: "a".repeat(8_000) }));
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const req = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { ...CALL_HEADERS, ...HOST, authorization: "Bearer good:u", "content-length": "10" },
      body,
      duplex: "half",
    } as RequestInit);
    expect((await service.handle(req, {}))?.status).toBe(413);
    expect(records).toEqual([]);
  });

  for (const [kind, profile] of [
    ["local", { ...TRANSPORT_EMPTY, requireCaller: false }],
    ["none", TRANSPORT_EMPTY],
  ] as const) {
    test(`413 for the ${kind} kind uses bodyLimit.${kind}, with the SDK's bytes`, async () => {
      const limit = kind === "local" ? 300 : 200;
      const shaped: ServeProfile = {
        ...profile,
        bodyLimit: { oauth: 5_000, bearer: 5_000, local: 300, none: 200 },
      };
      const { service } = makeService({ profile: shaped });
      const over = JSON.stringify(call("echo", { text: "a".repeat(limit) }));
      const ours = await service.handle(mcpRequest(over, { raw: true }), {});
      const sdk = await sdkAnswer("transport", mcpRequest(over, { raw: true }), limit);
      expect(ours?.status).toBe(413);
      expect(await snapshot(ours)).toEqual(await snapshot(sdk));
      const under = JSON.stringify(call("echo", { text: "a" }));
      expect((await service.handle(mcpRequest(under, { raw: true }), {}))?.status).toBe(200);
    });
  }
});
