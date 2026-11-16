import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { getMigrations } from "better-auth/db/migration";
import * as z from "zod/v4";
import { defineRootstockConfig } from "./config/index.ts";
import type { Sql } from "./db/index.ts";
import {
  openTestClientAt,
  type TestClient,
  testDatabaseUrlFor,
} from "./db/test-client.pg-support.ts";
import {
  openTestTransactor,
  openTestTransactorAt,
  type TestTransactor,
} from "./db/transactor.pg-support.ts";
import { applyRootstockMigrations, migrationStatus, rootstockSource } from "./migrate/index.ts";
import { type AuthLayer, type AuthOptions, defineAuth } from "./serve/auth/index.ts";
import {
  type Caller,
  type Clock,
  createMcpService,
  currentCall,
  dbProbe,
  defineToolScopes,
  expandScopes,
  type Limits,
  type LogEvent,
  liveness,
  migrationsProbe,
  readiness,
  SERVE_HARDENING,
  type ServeProfile,
  type ServeSlice,
  type Timers,
} from "./serve/index.ts";
import {
  createSpendCeiling,
  postgresCallLog,
  postgresSpendStore,
  type UsageSlice,
  usageWiring,
} from "./usage/index.ts";

// R-O1 (W5 contract §10): serve, serve/auth and usage composed end to end, once
// per transactor kind, in a throwaway database of its own: rootstock's
// migrations, real Better Auth on that database serving its routes through the
// service, one authenticated call per tool, the call log rows, the spend total
// and its refusal, readiness, and a shutdown that flushes the call log.
// Every tool, name, address and token here is synthetic.

const DATABASE = `rs_o1_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const ORIGIN = "https://app.example.test";
// Generated for this test; it signs nothing outside it.
const SECRET = "Qm7vT2xK9pLr4Nw8Zc3Hs6Jd1Fg5Ba0Ye";
const TOKEN = "synthetic-static-token";

let admin: TestTransactor;
let main: TestTransactor;
let locker: TestTransactor;
let authClient: TestClient;
/** Ends the table lock the flush case holds, so a failed case still lets afterAll close. */
let unlock = () => {};

const clock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };
const timers: Timers = {
  set(ms, fn) {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};
const events: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
const log: LogEvent = (event, fields) => {
  events.push({ event, fields });
};

beforeAll(async () => {
  admin = openTestTransactor();
  await admin.transactor.sql.unsafe(`CREATE DATABASE "${DATABASE}"`);
  const url = testDatabaseUrlFor(DATABASE);
  main = openTestTransactorAt(url);
  locker = openTestTransactorAt(url);
  authClient = openTestClientAt(url);
});

afterAll(async () => {
  unlock();
  for (const c of [main, locker, authClient]) await c?.close();
  await admin.transactor.sql.unsafe(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  await admin.close();
});

/** The driver client a consumer hands rootstock (the drizzle kind passes its postgres.js client). */
const rawSql = (c: TestClient): Sql =>
  (c.kind === "drizzle" ? c.client.$client : c.client) as unknown as Sql;

/**
 * The `pg` Pool subset Better Auth's Kysely dialect uses, over one driver
 * client: one checkout at a time, so a transaction Better Auth opens on a
 * checkout owns the client's single backend until it is released.
 */
function poolOver(sql: Sql) {
  let tail: Promise<void> = Promise.resolve();
  return {
    async connect() {
      const previous = tail;
      let release = () => {};
      tail = new Promise((r) => {
        release = r;
      });
      await previous;
      return {
        async query(text: string, params: readonly unknown[] = []) {
          // ISO text for a Date: the drizzle kind's postgres.js client sends
          // timestamps through unchanged, so it cannot take a Date itself.
          const values = params.map((v) => (v instanceof Date ? v.toISOString() : v));
          const rows = (await sql.unsafe(text, values)) as unknown[] & {
            command?: string;
            count?: number;
          };
          return { rows: [...rows], rowCount: rows.count ?? rows.length, command: rows.command };
        },
        release: () => release(),
      };
    },
    async end() {},
  };
}

/** A pool whose checkout never completes: a Better Auth built on it waits at startup. */
const poolNeverAnswering = () => ({
  connect: () => new Promise<never>(() => {}),
  async end() {},
});

const TOOL_SCOPES = defineToolScopes({
  id: "composition",
  tools: { echo: "mcp:tools", spend: "mcp:tools" },
  implies: { "mcp:tools": ["mcp:tools"] },
});

class SpendCeilingReached extends Error {
  override name = "SpendCeilingReached";
}

/** A JSON-response transport profile, its numbers from the serve slice. */
function profileFrom(serve: ServeSlice): ServeProfile {
  return {
    id: serve.id,
    mcpPath: "/mcp",
    methods: { get: "auth-then-405", other: "auth-then-entry" },
    passUnknown: false,
    authPrefixes: { api: ["/api/auth/"], wellKnown: ["/.well-known/"] },
    entry: { kind: "transport", json: true },
    bodyLimit: serve.bodyLimit,
    deadlineMs: serve.deadlineMs,
    unknownTool: "isError",
    requireCaller: true,
    oauthScopes: ["mcp:tools"],
    hostCheck: false,
    delegated: false,
    clientIpHeader: "cf-connecting-ip",
    bodies: {
      unauthorizedNoSub: "jsonrpc-401",
      jwksFailure: "503-retry",
      notFound: "text-not-found",
      internal: "text-500",
      tooLarge: "jsonrpc-413",
      parseError: "jsonrpc-400",
    },
    logNames: {},
    shutdown: serve.shutdown,
  };
}

/** The serve slice's limit numbers, with the wording only the consumer owns. */
function limitsFrom(serve: ServeSlice): Limits {
  const { limits } = serve;
  return {
    refusal: limits.refusal,
    serving: limits.serving,
    perTool: limits.perTool,
    concurrency: Object.fromEntries(
      Object.entries(limits.concurrency).map(([name, g]) => [
        name,
        { ...g, busy: (tool: string) => `${tool} is busy` },
      ]),
    ),
    turnBudget:
      limits.turnBudget === null
        ? null
        : { ...limits.turnBudget, exhausted: (spent: number) => `budget spent (${spent})` },
    logIntervalMs: limits.logIntervalMs,
  };
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { text: z.string() } },
    async ({ text }) => {
      currentCall().setResultIds([text]);
      return { content: [{ type: "text", text }] };
    },
  );
  server.registerTool("spend", { description: "spend" }, async () => {
    const call = currentCall();
    await call.assertWithinSpend();
    call.meter({ model: "model-a", input: 40, output: 20 });
    return { content: [{ type: "text", text: "spent" }] };
  });
}

const callBody = (id: number, name: string, args?: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, ...(args === undefined ? {} : { arguments: args }) },
  });

const mcpPost = (body: string, token: string | null = TOKEN) =>
  new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body,
  });

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("serve, serve/auth and usage composed (W5 R-O1)", () => {
  test("an authenticated call is logged and charged, the ceiling refuses, Better Auth serves its routes, shutdown flushes", async () => {
    const config = defineRootstockConfig({
      client: {
        profiles: {
          app: {
            max: 1,
            maxCeiling: 1,
            idleTimeoutSeconds: "driver-default",
            maxLifetimeSeconds: "never",
            connectTimeoutSeconds: "driver-default",
            prepare: "driver-default",
            keepAliveSeconds: "driver-default",
            statementTimeoutMs: 0,
            readOnly: false,
          },
        },
      },
      migrate: {},
      concurrency: { widths: { fetch: { default: 1, max: 1 } } },
      usage: {
        callLog: { maxBuffered: 100, maxBatch: 10 },
        keepArgs: true,
        keepOutput: true,
        spend: { unit: "tokens", ceiling: 100, store: { kind: "rootstock" } },
      },
      serve: {
        id: "composition.http",
        bodyLimit: { oauth: 65_536, bearer: 65_536, local: 65_536, none: 65_536 },
        deadlineMs: 10_000,
        idleTimeout: SERVE_HARDENING.idleTimeout,
        shutdown: { drainMs: 1_000, forceMs: 200, poolEndTimeoutS: 1, flushMs: 5_000 },
        limits: {
          refusal: { capacity: 20, refillPerSecond: 2, maxKeys: 64 },
          serving: { capacity: 100, refillPerSecond: 20, maxKeys: 64 },
          perTool: {},
          concurrency: {},
          turnBudget: null,
          logIntervalMs: 1_000,
        },
        probes: { timeoutMs: 2_000, cacheTtlMs: 0, pendingMaxMs: 5_000 },
      },
    });
    expect(config.invariants).toEqual(["serve-deadline-idle", "serve-probe-timeout"]);
    const serve = config.serve as ServeSlice;
    const usage = config.usage as UsageSlice;
    const callLogTable = usage.callLog?.table;
    const spendShape = usage.spend?.store;
    if (callLogTable === undefined || spendShape === undefined || usage.spend === null) {
      throw new Error("the usage slice lost its call log or spend");
    }
    // Every omitted schema is the one rootstock migrates: rootstock.mcp_calls, rootstock.spend.
    expect(callLogTable).toEqual({ schema: "rootstock", name: "mcp_calls" });
    expect(spendShape).toEqual({ kind: "rootstock", schema: "rootstock" });

    // Rootstock's own migrations, then Better Auth's tables, both in the throwaway database.
    const report = await applyRootstockMigrations(main.transactor, config.migrate);
    expect(report.schema).toBe("rootstock");
    expect(report.applied.length).toBeGreaterThan(0);

    const authOptions = (database: unknown): AuthOptions => ({
      baseURL: ORIGIN,
      baseUrlRule: "as-is",
      secret: SECRET,
      database,
      signIn: {
        kind: "magicLink",
        allow: { kind: "invited" },
        send: async () => {},
        sendLimit: { max: 1, windowMs: 60_000, releaseOnFailure: true },
      },
      registration: { dcr: false },
      clientPrivileges: "unset",
      redirects: { kind: "listed", hosts: ["client.example.test"], loopback: "if-listed" },
      extraScopes: [],
      rateLimit: { window: 60, max: 100, rules: {} },
      ipAddressHeaders: ["cf-connecting-ip"],
      pages: { login: () => "<p>sign in</p>", consent: () => "<p>consent</p>" },
      pageHeaders: {},
      authHeaders: { "x-frame-options": "DENY" },
      assets: {},
      clock,
      timers,
      log,
    });
    // Better Auth checks its schema and seeds the resource row as soon as it
    // is built, so its tables come first, planned from the same options (a
    // consumer runs Better Auth's migrate at deploy). The twin layer's own
    // store never answers, so its startup waits and touches nothing.
    const twin = defineAuth(authOptions(poolNeverAnswering()));
    const plan = await getMigrations({
      ...twin.instance.options,
      database: poolOver(rawSql(authClient)),
    } as typeof twin.instance.options);
    await plan.runMigrations();
    expect(plan.toBeCreated.map((t) => t.table)).toEqual(
      expect.arrayContaining(["user", "session", "jwks", "oauthResource"]),
    );
    const auth: AuthLayer = defineAuth(authOptions(poolOver(rawSql(authClient))));

    const sql = main.transactor.sql;
    const sink = postgresCallLog({
      sql,
      table: callLogTable,
      maxBuffered: usage.callLog?.maxBuffered ?? 0,
      maxBatch: usage.callLog?.maxBatch ?? 0,
      log,
    });
    const spend = createSpendCeiling({
      store: postgresSpendStore({ sql, shape: spendShape }),
      unit: usage.spend.unit,
      ceiling: usage.spend.ceiling,
      prices: null,
      refusal: (used, ceiling) => `daily ceiling reached: ${used} of ${ceiling}`,
      errorClass: SpendCeilingReached,
      clock,
      log,
    });
    const caller: Caller = {
      name: "agent-1",
      kind: "bearer",
      scopes: expandScopes(TOOL_SCOPES, ["mcp:tools"]),
    };
    let ids = 0;
    const service = createMcpService({
      profile: profileFrom(serve),
      serverInfo: { name: "composition", version: "0.0.0" },
      registerTools,
      auth,
      // A static bearer stands in for the OAuth dance; anything else reaches Better Auth's verify.
      credentials: (req) =>
        req.headers.get("authorization") === `Bearer ${TOKEN}` ? caller : undefined,
      toolScopes: TOOL_SCOPES,
      limits: limitsFrom(serve),
      usage: usageWiring({
        sinks: [sink],
        keepArgs: usage.keepArgs,
        keepOutput: usage.keepOutput,
        prices: null,
        spend,
        serverSha: "abc123",
      }),
      hooks: {},
      clock,
      timers,
      randomId: () => `req-${++ids}`,
      log,
    });
    const handle = async (req: Request): Promise<Response> => {
      const res = await service.handle(req, { remoteAddress: "127.0.0.1" });
      if (res === null) throw new Error(`the service passed ${req.url} on`);
      return res;
    };

    // Better Auth's routes, served through the service from the real store.
    const meta = await handle(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
    );
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { issuer?: unknown }).issuer).toBeString();
    const jwks = await handle(new Request(`${ORIGIN}/api/auth/jwks`));
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get("x-frame-options")).toBe("DENY");
    const keys = ((await jwks.json()) as { keys: { kid?: unknown }[] }).keys;
    expect(keys.length).toBeGreaterThan(0);
    const [stored] = await sql.unsafe<{ n: number }>(`SELECT count(*)::int AS n FROM "jwks"`);
    expect(stored?.n).toBe(keys.length);
    await auth.assertStoreReady();

    // No credential: Better Auth's own verify answers the OAuth challenge.
    const challenge = await handle(mcpPost(callBody(1, "echo", { text: "x" }), null));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain("resource_metadata");

    // The authenticated calls.
    const echo = await handle(mcpPost(callBody(2, "echo", { text: "hello" })));
    expect(echo.status).toBe(200);
    expect(await echo.json()).toMatchObject({
      id: 2,
      result: { content: [{ type: "text", text: "hello" }] },
    });
    for (const id of [3, 4]) {
      const res = await handle(mcpPost(callBody(id, "spend")));
      expect(await res.json()).toMatchObject({ id, result: { content: [{ text: "spent" }] } });
    }
    // 120 of 100 tokens spent: the next check refuses, before the tool spends anything.
    const refused = await handle(mcpPost(callBody(5, "spend")));
    expect(await refused.json()).toMatchObject({
      id: 5,
      result: { isError: true, content: [{ text: "daily ceiling reached: 120 of 100" }] },
    });
    const spendTotal = async () => {
      const rows = await sql.unsafe<{ used: string }>(
        `SELECT used::text AS used FROM rootstock.spend WHERE caller = $1 AND unit = 'tokens'`,
        ["agent-1"],
      );
      return rows.map((r) => r.used);
    };
    await until("both spend writes", async () => (await spendTotal())[0] === "120");
    expect(await spendTotal()).toEqual(["120"]);

    // The call log cannot write while another session holds its table.
    const held = new Promise<void>((r) => {
      unlock = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const blocker = locker.transactor.begin(async (tx) => {
      await tx.unsafe("LOCK TABLE rootstock.mcp_calls IN ACCESS EXCLUSIVE MODE");
      locked();
      await held;
    });
    await isLocked;
    const late = await handle(mcpPost(callBody(6, "echo", { text: "late" })));
    expect(late.status).toBe(200);

    let shutdownDone = false;
    const stopping = service
      .shutdown({ signal: "SIGTERM", server: { stop: () => {}, pending: () => 0 } })
      .then((r) => {
        shutdownDone = true;
        return r;
      });
    await Bun.sleep(100);
    expect(shutdownDone).toBe(false);
    unlock();
    await blocker;
    expect(await stopping).toEqual({ drained: true, flushed: true, poolClosed: false });

    // Every record landed before shutdown answered; nothing else waited for them.
    const rows = await sql.unsafe<Record<string, unknown>>(
      `SELECT tool, caller, ok, error_class, args::text AS args, result_ids::text AS result_ids,
              tokens::text AS tokens, cost_usd, cost_note, output_text, server_sha
       FROM rootstock.mcp_calls ORDER BY created_at, id`,
    );
    const byTool = rows.map((r) => [r.tool, r.ok, r.error_class]);
    expect(byTool).toHaveLength(5);
    expect(byTool).toEqual(
      expect.arrayContaining([
        ["echo", true, null],
        ["spend", true, null],
        ["spend", false, "SpendCeilingReached"],
      ]),
    );
    expect(rows.find((r) => r.result_ids === '["hello"]')).toMatchObject({
      tool: "echo",
      caller: "agent-1",
      args: '{"text": "hello"}',
      tokens: null,
      cost_usd: null,
      cost_note: null,
      output_text: "hello",
      server_sha: "abc123",
    });
    expect(rows.find((r) => r.tool === "spend" && r.ok === true)).toMatchObject({
      tokens: '{"model-a": {"input": 40, "output": 20}}',
      cost_usd: null,
      cost_note: "unpriced:model-a",
    });
    expect(rows.some((r) => r.result_ids === '["late"]')).toBe(true);
    // No call log or spend write failed; the one usage line is the refusal.
    expect(events.filter((e) => e.event.startsWith("usage."))).toEqual([
      {
        event: "usage.spend_refused",
        fields: { caller: "agent-1", ceiling: 100, unit: "tokens", used: 120 },
      },
    ]);

    // Readiness over the same database: rootstock's migrations are current.
    const ready = readiness({
      sha: "abc123",
      db: dbProbe(sql),
      probes: {
        migrations: {
          read: migrationsProbe(() =>
            migrationStatus(sql, config.migrate, [rootstockSource(config.migrate)]),
          ),
          gates: true,
        },
      },
      headers: { "content-type": "application/json" },
      timing: serve.probes,
      clock,
      timers,
      log,
    });
    const readyRes = await ready();
    expect(readyRes.status).toBe(200);
    expect(await readyRes.json()).toMatchObject({
      status: "ok",
      sha: "abc123",
      db: "ok",
      migrations: { ok: true, behind: [], ahead: [], tampered: [] },
    });
    const live = liveness({ fields: { status: "ok" }, headers: {} })();
    expect(await live.json()).toEqual({ status: "ok" });
  });
});
