import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Socket, SQL } from "bun";
import postgres from "postgres";
import { bunSqlOptions, postgresJsOptions, type Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import { killBackend, LOCK_CLIENT, lockDriver, testUrl } from "./fixtures.pg-support.ts";
import {
  acquireRunLock,
  type LockDeps,
  type LockEvent,
  type LockSession,
  type LockSlice,
  lockSlice,
  locksHeld,
  RootstockLockError,
} from "./index.ts";
import { bunSqlLockSession, postgresJsLockSession } from "./session.ts";

// #41: a gate probe that stalls recovers on a fresh session. The lock session
// goes through a TCP proxy that can black-hole a connection the way a silently
// dropped socket does: bytes stop in both directions and nothing errors.

let main: TestTransactor;
let admin: TestTransactor;
let adminSql: Sql;
const { schema, dropAll } = schemaFactory("rs_st");
const driver = lockDriver();
let slice: LockSlice;

interface Link {
  frozen: boolean;
  /** Whether the proxy ends the server side when the client side closes. */
  forwardClose: boolean;
  upstream?: Socket<undefined>;
  pending: Uint8Array[];
}

/** A byte-forwarding proxy to the test server; `freeze` black-holes every connection open now. */
interface Proxy {
  url: string;
  freeze(opts: { forwardClose: boolean }): void;
  stop(): void;
}

function startProxy(): Proxy {
  const target = new URL(testUrl());
  const links = new Set<Link>();
  const byClient = new WeakMap<Socket<undefined>, Link>();
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        const link: Link = { frozen: false, forwardClose: true, pending: [] };
        links.add(link);
        byClient.set(client, link);
        link.upstream = await Bun.connect<undefined>({
          hostname: target.hostname,
          port: Number(target.port || 5432),
          socket: {
            data(_, buf) {
              if (!link.frozen) client.write(buf);
            },
            close() {
              if (!link.frozen) client.end();
            },
            error() {},
          },
        });
        for (const buf of link.pending.splice(0)) link.upstream.write(buf);
      },
      data(client, buf) {
        const link = byClient.get(client);
        if (link === undefined || link.frozen) return;
        if (link.upstream === undefined) link.pending.push(new Uint8Array(buf));
        else link.upstream.write(buf);
      },
      close(client) {
        const link = byClient.get(client);
        if (link?.forwardClose) link.upstream?.end();
      },
      error() {},
    },
  });
  const url = new URL(testUrl());
  url.hostname = "127.0.0.1";
  url.port = String(server.port);
  return {
    url: url.toString(),
    freeze({ forwardClose }) {
      for (const link of links) {
        link.frozen = true;
        link.forwardClose = forwardClose;
      }
    },
    stop() {
      for (const link of links) link.upstream?.end();
      server.stop(true);
    },
  };
}

function open(url: string): () => LockSession {
  return () =>
    driver === "bun-sql"
      ? bunSqlLockSession(new SQL(url, { ...bunSqlOptions(LOCK_CLIENT, "lock"), max: 1 }), slice)
      : postgresJsLockSession(
          postgres(url, {
            ...(postgresJsOptions(LOCK_CLIENT, "lock") as postgres.Options<Record<string, never>>),
            max: 1,
            onnotice: () => {},
          }),
          slice,
        );
}

function deps(events: LockEvent[]): LockDeps {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    randomUUID: () => crypto.randomUUID(),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    onEvent: (e) => events.push(e),
  };
}

const acquiredPid = (events: LockEvent[]) => {
  const e = events.find((x) => x.type === "lock.acquired");
  return e?.type === "lock.acquired" ? e.pid : -1;
};

async function backendAlive(pid: number): Promise<boolean> {
  const rows = await adminSql.unsafe("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
  return rows.length > 0;
}

beforeAll(async () => {
  main = openTestTransactor();
  admin = openSecond();
  adminSql = admin.transactor.sql;
  const s = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: s }));
  slice = lockSlice({
    table: { schema: s },
    profile: "lock",
    names: ["stall-a", "stall-b", "stall-c"],
    heartbeatSeconds: 5,
    probeStallSeconds: 6,
    maxRecoveries: 3,
    endTimeoutSeconds: 1,
    wait: { maxMs: 0, pollIntervalMs: 50 },
  });
});

afterAll(async () => {
  await dropAll(main.transactor.sql);
  await admin.close();
  await main.close();
});

describe("#41: a stalled probe recovers on a fresh session", () => {
  test("S1: a stalled backend that hears the close frees the lock, and the fresh session takes it", async () => {
    const proxy = startProxy();
    const events: LockEvent[] = [];
    const lock = await acquireRunLock(open(proxy.url), slice, "stall-a", deps(events));
    try {
      const old = acquiredPid(events);
      proxy.freeze({ forwardClose: true });
      await lock.ensureExclusive();
      const recovered = events.find((e) => e.type === "lock.recovered");
      expect(recovered?.type === "lock.recovered" && recovered.pid).not.toBe(old);
      expect(await backendAlive(old)).toBe(false);
      await lock.ensureExclusive();
      expect((await locksHeld(adminSql, ["stall-a"])).get("stall-a")).toBe(true);
    } finally {
      await lock.release();
      proxy.stop();
    }
    expect((await locksHeld(adminSql, ["stall-a"])).get("stall-a")).toBe(false);
  }, 30_000);

  test("S2: a black-holed backend the server ends during the poll is outwaited", async () => {
    const proxy = startProxy();
    const events: LockEvent[] = [];
    const lock = await acquireRunLock(open(proxy.url), slice, "stall-b", deps(events));
    try {
      const old = acquiredPid(events);
      proxy.freeze({ forwardClose: false });
      const gate = lock.ensureExclusive();
      // Probe stall (6 s) plus the bounded close (1 s), then the server reaps.
      await Bun.sleep(7_500);
      expect(await backendAlive(old)).toBe(true);
      await killBackend(adminSql, old);
      await gate;
      expect(events.map((e) => e.type)).toContain("lock.recovered");
      await lock.ensureExclusive();
    } finally {
      await lock.release();
      proxy.stop();
    }
  }, 30_000);

  test("S3: a black hole the server does not end within the stall refuses UNVERIFIABLE", async () => {
    const proxy = startProxy();
    const events: LockEvent[] = [];
    const lock = await acquireRunLock(open(proxy.url), slice, "stall-c", deps(events));
    const old = acquiredPid(events);
    try {
      proxy.freeze({ forwardClose: false });
      let err: unknown;
      try {
        await lock.ensureExclusive();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RootstockLockError);
      expect((err as RootstockLockError).code).toBe("ERR_ROOTSTOCK_LOCK_UNVERIFIABLE");
      expect(events.at(-1)).toMatchObject({ type: "lock.recovery_refused", reason: "held" });
      // The run never held a second level anywhere: only the stalled backend holds it.
      expect((await locksHeld(adminSql, ["stall-c"])).get("stall-c")).toBe(true);
    } finally {
      await lock.release();
      await killBackend(adminSql, old);
      proxy.stop();
    }
    expect((await locksHeld(adminSql, ["stall-c"])).get("stall-c")).toBe(false);
  }, 30_000);
});
