// The imagine-gate paths of createMcpService: the line a late aroundRequest
// throw writes, host refusal lines, the deadline's edges, shutdown details.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { type FakeTime, signal, until } from "./fakes.test-support.ts";
import {
  call,
  fakeAuth,
  HANDLER_JSON,
  makeService,
  mcpRequest,
  registerSynthetic,
  TRANSPORT_EMPTY,
  TRANSPORT_TEXT,
} from "./service.test-support.ts";
import type { McpServiceOptions } from "./service.ts";
import type { CallSink, ServeProfile, UsageWiring } from "./types.ts";

const both = { bearer: true, oauth: true };
const withAuth = (
  profile: ServeProfile,
  over: Partial<McpServiceOptions> & { slow?: () => Promise<void> } = {},
) => {
  const auth = fakeAuth();
  return { auth, ...makeService({ profile, auth, acceptCredentials: () => both, ...over }) };
};
const echo = (token: string, headers: Record<string, string> = {}) =>
  mcpRequest(call("echo", { text: "x" }), { token, headers });

async function settle<T>(p: Promise<T>, time: FakeTime, stepMs = 50, rounds = 400): Promise<T> {
  let done = false;
  const mark = () => {
    done = true;
  };
  p.then(mark, mark);
  for (let i = 0; i < rounds && !done; i++) {
    await until(() => done || time.pending() > 0);
    // One macrotask first, so work already resolving settles before time moves.
    await new Promise<void>((r) => setImmediate(r));
    if (!done) time.advance(stepMs);
  }
  if (!done) throw new Error("settle: still pending");
  return p;
}

const usageWith = (sinks: CallSink[]): UsageWiring => ({
  sinks,
  keepArgs: false,
  keepOutput: false,
  price: () => ({ costUsd: null, costNote: null }),
  errorClassOf: (err) => (err instanceof Error ? err.name : "x"),
  spend: null,
  serverSha: null,
});

test("an aroundRequest that throws after next() logs serve.request_failed 500, never a 200", async () => {
  const { service, log } = withAuth(TRANSPORT_EMPTY, {
    hooks: {
      aroundRequest: async (_r, next) => {
        await next();
        throw new RangeError("after the fact");
      },
    },
  });
  expect((await service.handle(echo("good:u"), {}))?.status).toBe(500);
  expect(log.names()).not.toContain("app.request");
  expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
    status: 500,
    reason: "threw",
    errorClass: "RangeError",
  });
});

test("an aroundRequest that answers its own response is logged with that status", async () => {
  const { service, log } = withAuth(TRANSPORT_EMPTY, {
    hooks: {
      aroundRequest: async (_r, next) => {
        await next();
        return new Response(null, { status: 202 }) as never;
      },
    },
  });
  expect((await service.handle(echo("good:u"), {}))?.status).toBe(202);
  expect(log.lines.find(([e]) => e === "app.request")?.[1]).toMatchObject({ status: 202 });
});

test("host refusals log serve.host_refused once per source key per minute; the bytes are unchanged", async () => {
  const { service, log, time } = withAuth(TRANSPORT_TEXT);
  const bad = (ip: string) =>
    service.handle(echo("good:u", { host: "wrong.example.test", "x-client-ip": ip }), {
      remoteAddress: "127.0.0.1",
    });
  for (let i = 0; i < 3; i++) {
    const res = await bad("192.0.2.1");
    expect(res?.status).toBe(404);
    expect(await res?.text()).toBe("Not Found");
  }
  await bad("192.0.2.2");
  time.advance(60_000);
  await bad("192.0.2.1");
  expect(log.lines.filter(([e]) => e === "serve.host_refused").map(([, f]) => f)).toEqual([
    { sourceKey: "192.0.2.1", host: "wrong.example.test", origin: "" },
    { sourceKey: "192.0.2.2", host: "wrong.example.test", origin: "" },
    { sourceKey: "192.0.2.1", host: "wrong.example.test", origin: "" },
  ]);
});

test("a deadline with the handler entry is refused at build", () => {
  expect(() => withAuth({ ...HANDLER_JSON, deadlineMs: 1_000 })).toThrow(
    /deadlineMs must be null with entry.kind "handler"/,
  );
});

test("JWKS fetch failed and JWKSTimeout are JWKS failures logged authUnreachable; other throws stay bodies.internal", async () => {
  const { service, log } = withAuth(TRANSPORT_TEXT);
  const statuses: number[] = [];
  for (const token of ["jwksnet", "jwkstimeout", "throw"]) {
    const res = await service.handle(echo(token, { host: "app.example.test" }), {});
    statuses.push(res?.status ?? 0);
  }
  expect(statuses).toEqual([503, 503, 500]);
  expect(
    log.lines
      .filter(([e]) => e === "serve.auth_threw")
      .map(([, f]) => [f.errorClass, f.authUnreachable ?? false, f.jwks ?? false]),
  ).toEqual([
    ["Error", true, true],
    ["JWKSTimeout", true, true],
    ["TypeError", false, false],
  ]);
});

test("the handler entry keeps the latest failure the entry reports, not the first", async () => {
  // Our factory wrapper reports the raw throw first; the SDK then reports it
  // wrapped in an Error. The line carries the latest.
  const { service, log } = withAuth(HANDLER_JSON, {
    registerTools: () => {
      throw "not an Error";
    },
  });
  expect((await service.handle(echo("good:u", { host: "app.example.test" }), {}))?.status).toBe(
    500,
  );
  expect(log.lines.find(([e]) => e === "serve.request_failed")?.[1]).toMatchObject({
    errorClass: "Error",
  });
});

describe("the deadline's edges", () => {
  test("an expiry during an async registerTools never connects or runs the tool", async () => {
    const registered = signal();
    const gate = signal();
    let ran = 0;
    const { service, time, records } = withAuth(TRANSPORT_EMPTY, {
      registerTools: async (server: McpServer) => {
        registerSynthetic(server);
        server.registerTool("spend", {}, async () => {
          ran++;
          return { content: [] };
        });
        registered.resolve();
        await gate.promise;
      },
    });
    const res = service.handle(mcpRequest(call("spend"), { token: "good:u" }), {});
    await registered.promise;
    time.advance(1_000);
    expect((await res)?.status).toBe(500);
    gate.resolve();
    // Let the late registerTools finish and anything it would start run.
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    expect(ran).toBe(0);
    expect(records).toEqual([]);
  });

  test("shutdown counts a dispatch orphaned by its deadline and waits for it before the pool ends", async () => {
    const gate = signal();
    const started = signal();
    const { service, time, records } = withAuth(TRANSPORT_EMPTY, {
      slow: () => {
        started.resolve();
        return gate.promise;
      },
    });
    const res = service.handle(mcpRequest(call("slow"), { token: "good:u" }), {});
    await started.promise;
    time.advance(1_000);
    expect((await res)?.status).toBe(500);
    let rowsAtPoolEnd = -1;
    const done = service.shutdown({
      signal: "SIGTERM",
      server: { stop: () => {}, pending: () => 0 },
      endPool: async () => {
        rowsAtPoolEnd = records.length;
      },
    });
    await until(() => time.pending() > 0); // drain poll: the orphan is pending
    gate.resolve();
    expect(await settle(done, time)).toMatchObject({ drained: true });
    expect(rowsAtPoolEnd).toBe(1);
  });

  test("an orphan still running when the drain window closes: drained is false", async () => {
    const started = signal();
    const { service, time } = withAuth(TRANSPORT_EMPTY, {
      slow: () => {
        started.resolve();
        return new Promise(() => {});
      },
    });
    const res = service.handle(mcpRequest(call("slow"), { token: "good:u" }), {});
    await started.promise;
    time.advance(1_000);
    await res;
    const done = service.shutdown({
      signal: "SIGTERM",
      server: { stop: () => {}, pending: () => 0 },
    });
    expect(await settle(done, time)).toMatchObject({ drained: false });
  });
});

describe("shutdown", () => {
  test("serve.stopped names the forced stop, entry close, each failed flush and the pool's errorClass", async () => {
    const auth = fakeAuth();
    const { service, time, log } = makeService({
      auth,
      acceptCredentials: () => both,
      usage: usageWith([
        { record: () => {}, idle: () => new Promise(() => {}) },
        { record: () => {}, idle: () => Promise.reject(new SyntaxError("flush failed")) },
        { record: () => {} },
      ]),
    });
    const done = service.shutdown({
      signal: "SIGINT",
      server: {
        stop: (force) => {
          if (force) throw new RangeError("stop broke");
        },
        pending: () => 0,
      },
      endPool: async () => {
        throw new TypeError("pool broke");
      },
    });
    expect(await settle(done, time)).toEqual({ drained: true, flushed: false, poolClosed: false });
    expect(log.lines.at(-1)).toEqual([
      "serve.stopped",
      {
        signal: "SIGINT",
        drained: true,
        flushed: false,
        poolClosed: false,
        poolReason: "threw",
        poolMs: 0,
        forced: "threw:RangeError",
        entryClosed: "none",
        flushFailed: ["sink[0]:timeout", "sink[1]:threw:SyntaxError"],
        poolErrorClass: "TypeError",
      },
    ]);
    expect(auth.idled).toBe(1);
  });

  test("is idempotent: a second call returns the same promise and stops once", async () => {
    const { service, time, log } = makeService();
    let stops = 0;
    const server = {
      stop: () => {
        stops++;
      },
      pending: () => 0,
    };
    const first = service.shutdown({ signal: "SIGTERM", server });
    const second = service.shutdown({ signal: "SIGINT", server });
    expect(second).toBe(first);
    await settle(first, time);
    expect(stops).toBe(2); // the graceful stop and the forced one, once each
    expect(log.names().filter((e) => e === "serve.stopped")).toHaveLength(1);
  });
});
