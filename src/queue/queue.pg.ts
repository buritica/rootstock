import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzleTransactor, pgCode, type Sql } from "../db/index.ts";
import { openTestClient } from "../db/test-client.pg-support.ts";
import {
  openPooled,
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import { QUEUE_INPUT } from "./fixtures.test-support.ts";
import {
  ack,
  claim,
  depth,
  enqueue,
  fail,
  listDead,
  type QueueEvent,
  type QueueSlice,
  queueSlice,
  RootstockQueueError,
  retryDead,
} from "./index.ts";

// R-C5 (contract §4.8): the queue protocol against a real server, once per
// transactor kind, each case on rootstock's own tables in a schema of its
// own. Time moves by rewriting not_before, claimed_at and enqueued_at.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_q");

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

interface Q {
  s: QueueSlice;
  T: string;
  events: QueueEvent[];
  hooks: { onEvent: (e: QueueEvent) => void };
  /** Enqueue with the defaults of a plain `put`. */
  put: (key: string, over?: Record<string, unknown>) => Promise<string>;
  /** A row's columns, timestamps as seconds from the database's clock. */
  row: (key: string) => Promise<Record<string, unknown> | undefined>;
  types: () => string[];
}

async function fresh(): Promise<Q> {
  const sc = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: sc }));
  const s = queueSlice(QUEUE_INPUT, { schema: sc });
  const events: QueueEvent[] = [];
  const hooks = { onEvent: (e: QueueEvent) => events.push(e) };
  const T = `"${sc}".work_queue`;
  return {
    s,
    T,
    events,
    hooks,
    put: (key, over = {}) =>
      enqueue(
        main.transactor,
        s,
        {
          key,
          source: key.split(":")[0] as string,
          kind: "put",
          payload: {},
          debounceSeconds: 0,
          ...over,
        },
        hooks,
      ),
    row: async (key) => {
      const [r] = await sql.unsafe(
        `SELECT kind, payload::text AS payload, attempts::text AS attempts, last_error, claimed_by,
                dead_at IS NOT NULL AS dead, claimed_at IS NOT NULL AS claimed,
                extract(epoch FROM (not_before - clock_timestamp()))::float8::text AS nb,
                extract(epoch FROM (clock_timestamp() - enqueued_at))::float8::text AS age
         FROM ${T} WHERE key = $1`,
        [key],
      );
      if (r === undefined) return undefined;
      return {
        ...r,
        payload: JSON.parse(String(r.payload)),
        attempts: Number(r.attempts),
        nb: Number(r.nb),
        age: Number(r.age),
      };
    },
    types: () => events.map((e) => e.type),
  };
}

const W = "worker-a";
const near = (actual: unknown, expected: number, within = 2) => {
  expect(Math.abs(Number(actual) - expected)).toBeLessThanOrEqual(within);
};

describe("QD1: enqueue", () => {
  test("insert, coalesce, and every result", async () => {
    const q = await fresh();
    expect(await q.put("alpha:1", { debounceSeconds: 60 })).toBe("enqueued");
    near((await q.row("alpha:1"))?.nb, 60);
    expect(await q.put("alpha:1", { debounceSeconds: 30 })).toBe("enqueued");
    // A shorter debounce never pulls a row earlier.
    near((await q.row("alpha:1"))?.nb, 60);
    await sql.unsafe(`UPDATE ${q.T} SET dead_at = clock_timestamp() WHERE key = 'alpha:1'`);
    await q.put("alpha:1");
    expect((await q.row("alpha:1"))?.dead).toBe(true);
    const enqueued = q.events.filter((e) => e.type === "queue.enqueued");
    expect(enqueued.map((e) => e.type === "queue.enqueued" && e.result)).toEqual([
      "inserted",
      "coalesced",
      "on_dead",
    ]);
    expect(enqueued[0]).toEqual({
      type: "queue.enqueued",
      key: "alpha:1",
      source: "alpha",
      kind: "put",
      debounceSeconds: 60,
      result: "inserted",
    });
  });

  test("the slide: inside the ceiling, capped by it, and no ceiling once attempts > 0", async () => {
    const q = await fresh();
    await q.put("alpha:in", { debounceSeconds: 60 });
    await sql.unsafe(`UPDATE ${q.T} SET enqueued_at = enqueued_at - interval '10 minutes',
                        not_before = not_before - interval '10 minutes' WHERE key = 'alpha:in'`);
    await q.put("alpha:in", { debounceSeconds: 60 });
    near((await q.row("alpha:in"))?.nb, 60);

    await q.put("alpha:cap", { debounceSeconds: 60 });
    await sql.unsafe(`UPDATE ${q.T} SET enqueued_at = enqueued_at - interval '870 seconds',
                        not_before = not_before - interval '870 seconds' WHERE key = 'alpha:cap'`);
    await q.put("alpha:cap", { debounceSeconds: 60 });
    near((await q.row("alpha:cap"))?.nb, 30);

    await q.put("alpha:retry", { debounceSeconds: 60 });
    await sql.unsafe(`UPDATE ${q.T} SET attempts = 1, enqueued_at = enqueued_at - interval '870 seconds',
                        not_before = not_before - interval '870 seconds' WHERE key = 'alpha:retry'`);
    await q.put("alpha:retry", { debounceSeconds: 60 });
    near((await q.row("alpha:retry"))?.nb, 60);

    // A caller's maxSlideSeconds below the ceiling caps sooner.
    await q.put("alpha:short", { debounceSeconds: 60 });
    await sql.unsafe(`UPDATE ${q.T} SET enqueued_at = enqueued_at - interval '50 seconds',
                        not_before = not_before - interval '50 seconds' WHERE key = 'alpha:short'`);
    await q.put("alpha:short", { debounceSeconds: 60, maxSlideSeconds: 70 });
    near((await q.row("alpha:short"))?.nb, 20);
  });

  test("the sticky kind wins and keeps its payload", async () => {
    const q = await fresh();
    await q.put("alpha:d", { kind: "drop", payload: { d: 1 } });
    await q.put("alpha:d", { kind: "put", payload: { p: 1 } });
    expect(await q.row("alpha:d")).toMatchObject({ kind: "drop", payload: { d: 1 } });

    await q.put("alpha:p", { kind: "put", payload: { p: 1 } });
    await q.put("alpha:p", { kind: "drop", payload: { d: 2 } });
    expect(await q.row("alpha:p")).toMatchObject({ kind: "drop", payload: { d: 2 } });

    await q.put("alpha:pp", { payload: { p: 1 } });
    await q.put("alpha:pp", { payload: { p: 2 } });
    expect(await q.row("alpha:pp")).toMatchObject({ kind: "put", payload: { p: 2 } });
  });

  test("debounceSeconds clamps to 0..maxDebounceSeconds", async () => {
    const q = await fresh();
    await q.put("alpha:neg", { debounceSeconds: -5 });
    near((await q.row("alpha:neg"))?.nb, 0);
    await q.put("alpha:big", { debounceSeconds: 1e6 });
    near((await q.row("alpha:big"))?.nb, 900);
    const clamped = q.events.map((e) => e.type === "queue.enqueued" && e.debounceSeconds);
    expect(clamped).toEqual([0, 900]);
  });
});

describe("QD2: claim", () => {
  test("order by not_before, then key, with ties broken by key", async () => {
    const q = await fresh();
    for (const k of ["alpha:c", "alpha:b", "alpha:a", "alpha:late", "alpha:early"]) await q.put(k);
    await sql.unsafe(
      `UPDATE ${q.T} SET not_before = now() - interval '1 minute' WHERE key IN ('alpha:c', 'alpha:b', 'alpha:a')`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET not_before = now() - interval '2 minutes' WHERE key = 'alpha:early'`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET not_before = now() - interval '30 seconds' WHERE key = 'alpha:late'`,
    );
    await q.put("beta:x");
    const rows = await claim(sql, q.s, { source: "alpha", limit: 10, worker: W }, q.hooks);
    const order = ["alpha:early", "alpha:a", "alpha:b", "alpha:c", "alpha:late"];
    expect(rows.map((r) => r.key)).toEqual(order);
    expect(
      q.events.filter((e) => e.type === "queue.claimed").map((e) => (e as { key: string }).key),
    ).toEqual(order);
    const first = rows[0];
    expect(first).toMatchObject({
      source: "alpha",
      kind: "put",
      payload: {},
      attempts: 0,
      claimedBy: W,
    });
    expect(first?.notBefore).toBeInstanceOf(Date);
    expect(first?.claimedAt).toBeInstanceOf(Date);
  });

  test("the limit clamps; a fresh claim is not retaken; drained fires at zero", async () => {
    const q = await fresh();
    await sql.unsafe(
      `INSERT INTO ${q.T} (key, source, kind, not_before)
       SELECT 'alpha:' || i, 'alpha', 'put', now() - interval '1 minute' FROM generate_series(1, 503) i`,
    );
    expect((await claim(sql, q.s, { source: "alpha", limit: 0, worker: W }, q.hooks)).length).toBe(
      1,
    );
    expect(
      (await claim(sql, q.s, { source: "alpha", limit: Number.NaN, worker: W }, q.hooks)).length,
    ).toBe(1);
    expect(
      (await claim(sql, q.s, { source: "alpha", limit: 1e6, worker: W }, q.hooks)).length,
    ).toBe(500);
    expect((await claim(sql, q.s, { source: "alpha", limit: 10, worker: W }, q.hooks)).length).toBe(
      1,
    );
    expect(await claim(sql, q.s, { source: "alpha", limit: 10, worker: W }, q.hooks)).toEqual([]);
    expect(await claim(sql, q.s, { source: "gamma", limit: 10, worker: W }, q.hooks)).toEqual([]);
    const drained = q.events.filter((e) => e.type === "queue.drained");
    expect(drained.map((e) => e.type === "queue.drained" && [e.limit, e.claimed])).toEqual([
      [1, 1],
      [1, 1],
      [500, 500],
      [10, 1],
      [10, 0],
      [10, 0],
    ]);
    expect(drained[4]).toEqual({
      type: "queue.drained",
      source: "alpha",
      worker: W,
      limit: 10,
      claimed: 0,
      deadLettered: 0,
    });
  });

  test("an expired claim is reclaimed with an attempt charged, and dead-letters at maxAttempts", async () => {
    const q = await fresh();
    for (const k of ["alpha:r", "alpha:boom", "alpha:quiet"]) await q.put(k);
    await claim(sql, q.s, { source: "alpha", limit: 10, worker: "worker-old" });
    await sql.unsafe(`UPDATE ${q.T} SET claimed_at = claimed_at - interval '31 minutes'`);
    await sql.unsafe(
      `UPDATE ${q.T} SET attempts = 7, last_error = 'Boom' WHERE key = 'alpha:boom'`,
    );
    await sql.unsafe(`UPDATE ${q.T} SET attempts = 7 WHERE key = 'alpha:quiet'`);
    const rows = await claim(sql, q.s, { source: "alpha", limit: 10, worker: W }, q.hooks);
    expect(rows.map((r) => [r.key, r.attempts])).toEqual([["alpha:r", 1]]);
    expect(q.events).toContainEqual({
      type: "queue.reclaimed",
      key: "alpha:r",
      source: "alpha",
      kind: "put",
      attempts: 1,
      worker: W,
      from: "worker-old",
    });
    expect(q.events).toContainEqual({
      type: "queue.dead",
      key: "alpha:boom",
      source: "alpha",
      kind: "put",
      attempts: 8,
      worker: W,
      error: "Boom",
    });
    expect(q.events).toContainEqual({
      type: "queue.dead",
      key: "alpha:quiet",
      source: "alpha",
      kind: "put",
      attempts: 8,
      worker: W,
      error: "ExpiredClaim",
    });
    expect(await q.row("alpha:boom")).toMatchObject({
      dead: true,
      claimed: false,
      claimed_by: null,
    });
    expect((await q.row("alpha:quiet"))?.last_error).toBe("ExpiredClaim");
    expect(q.events.at(-1)).toMatchObject({ type: "queue.drained", claimed: 1, deadLettered: 2 });
  });

  test("a reclaim at maxAttempts - 2 charges an attempt and does not dead-letter", async () => {
    const q = await fresh();
    await q.put("alpha:edge");
    await claim(sql, q.s, { source: "alpha", limit: 1, worker: "worker-old" });
    await sql.unsafe(
      `UPDATE ${q.T} SET claimed_at = claimed_at - interval '31 minutes', attempts = 6`,
    );
    const rows = await claim(sql, q.s, { source: "alpha", limit: 1, worker: W }, q.hooks);
    expect(rows.map((r) => [r.key, r.attempts, r.claimedBy])).toEqual([["alpha:edge", 7, W]]);
    expect(q.types().slice(1)).toEqual(["queue.reclaimed", "queue.claimed", "queue.drained"]);
    expect(await q.row("alpha:edge")).toMatchObject({
      dead: false,
      claimed: true,
      claimed_by: W,
      attempts: 7,
      last_error: "ExpiredClaim",
    });
  });
});

describe("QD3: concurrent claimers", () => {
  test("two claimers on their own clients never get the same key across 200 rows", async () => {
    const q = await fresh();
    await sql.unsafe(
      `INSERT INTO ${q.T} (key, source, kind, not_before)
       SELECT 'alpha:' || i, 'alpha', 'put', now() - interval '1 minute' FROM generate_series(1, 200) i`,
    );
    const a = openPooled(2);
    const b = openPooled(2);
    try {
      const drain = async (t: TestTransactor, worker: string) => {
        const got: string[] = [];
        for (;;) {
          const rows = await claim(t.transactor.sql, q.s, { source: "alpha", limit: 7, worker });
          if (rows.length === 0) return got;
          got.push(...rows.map((r) => r.key));
        }
      };
      const [x, y] = await Promise.all([drain(a, "worker-x"), drain(b, "worker-y")]);
      expect(x.length + y.length).toBe(200);
      expect(new Set([...x, ...y]).size).toBe(200);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("QD3: a held claim", () => {
  // The SKIP LOCKED detector: without it the second claimer blocks on the
  // first's uncommitted row locks. The 200-row duplicate check above stays
  // green either way, because a blocked FOR UPDATE re-checks and skips.
  test("a claimer takes other rows at once while another's claim is uncommitted", async () => {
    const q = await fresh();
    await sql.unsafe(
      `INSERT INTO ${q.T} (key, source, kind, not_before)
       SELECT 'alpha:' || i, 'alpha', 'put', now() - interval '1 minute' FROM generate_series(1, 10) i`,
    );
    const a = openSecond();
    const b = openSecond();
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let claimed!: (keys: string[]) => void;
    const aKeys = new Promise<string[]>((r) => {
      claimed = r;
    });
    const holding = a.transactor.begin(async (tx) => {
      claimed(
        (await claim(tx, q.s, { source: "alpha", limit: 5, worker: "worker-x" })).map((r) => r.key),
      );
      await hold;
    });
    try {
      const held = await aKeys;
      const bClaim = claim(b.transactor.sql, q.s, {
        source: "alpha",
        limit: 10,
        worker: "worker-y",
      });
      const first = await Promise.race([bClaim, Bun.sleep(1500).then(() => "blocked" as const)]);
      release();
      await holding;
      const bKeys = (await bClaim).map((r) => r.key);
      expect(first).not.toBe("blocked");
      expect(bKeys.length).toBe(5);
      expect(bKeys.filter((k) => held.includes(k))).toEqual([]);
    } finally {
      release();
      await holding.catch(() => {});
      await a.close();
      await b.close();
    }
  });
});

describe("QD4: ack", () => {
  test("deleted, released, missing", async () => {
    const q = await fresh();
    await q.put("alpha:1");
    await q.put("alpha:2");
    await claim(sql, q.s, { source: "alpha", limit: 10, worker: W });
    q.events.length = 0;
    expect(await ack(sql, q.s, { key: "alpha:1", worker: W }, q.hooks)).toBe("deleted");
    expect(await q.row("alpha:1")).toBeUndefined();
    const acked = q.events[0];
    expect(acked).toMatchObject({
      type: "queue.acked",
      key: "alpha:1",
      source: "alpha",
      kind: "put",
      worker: W,
      result: "deleted",
    });
    expect(typeof (acked as { enqueuedAt: unknown }).enqueuedAt).toBe("string");
    expect(typeof (acked as { queuedMs: unknown }).queuedMs).toBe("number");

    await sql.unsafe(`UPDATE ${q.T} SET attempts = 2, last_error = 'Old',
                        enqueued_at = enqueued_at - interval '1 hour' WHERE key = 'alpha:2'`);
    await q.put("alpha:2");
    expect(await ack(sql, q.s, { key: "alpha:2", worker: W }, q.hooks)).toBe("released");
    const released = await q.row("alpha:2");
    expect(released).toMatchObject({
      attempts: 0,
      last_error: null,
      claimed: false,
      claimed_by: null,
    });
    expect(Number(released?.age)).toBeLessThan(5);

    expect(await ack(sql, q.s, { key: "alpha:2", worker: "worker-b" }, q.hooks)).toBe("missing");
    expect(q.events.at(-1)).toEqual({
      type: "queue.lost",
      key: "alpha:2",
      worker: "worker-b",
      operation: "ack",
    });
  });

  test("an enqueue in the claim's own transaction still releases", async () => {
    const q = await fresh();
    await q.put("alpha:t");
    const result = await main.transactor.begin(async (tx) => {
      await claim(tx, q.s, { source: "alpha", limit: 1, worker: W });
      await enqueue(tx, q.s, {
        key: "alpha:t",
        source: "alpha",
        kind: "put",
        payload: { v: 2 },
        debounceSeconds: 0,
      });
      return ack(tx, q.s, { key: "alpha:t", worker: W });
    });
    expect(result).toBe("released");
    expect((await q.row("alpha:t"))?.payload).toEqual({ v: 2 });
  });
});

describe("QD5: fail", () => {
  test("the backoff ladder, then dead on the eighth failure", async () => {
    const q = await fresh();
    await q.put("alpha:f");
    const offsets: number[] = [];
    const results: string[] = [];
    for (let i = 1; i <= 8; i += 1) {
      await sql.unsafe(
        `UPDATE ${q.T} SET not_before = now() - interval '1 second' WHERE key = 'alpha:f'`,
      );
      expect((await claim(sql, q.s, { source: "alpha", limit: 1, worker: W })).length).toBe(1);
      const r = await fail(sql, q.s, { key: "alpha:f", worker: W, errorClass: "Timeout" }, q.hooks);
      expect(r.attempts).toBe(i);
      results.push(r.result);
      offsets.push(Number((await q.row("alpha:f"))?.nb) / 60);
    }
    [1, 5, 30, 120, 240, 480, 480, 480].forEach((m, i) => {
      near(offsets[i], m, 1);
    });
    expect(results).toEqual([...Array(7).fill("failed"), "dead"]);
    expect(await q.row("alpha:f")).toMatchObject({
      dead: true,
      last_error: "Timeout",
      attempts: 8,
    });
    expect(q.events.slice(-2)).toEqual([
      {
        type: "queue.failed",
        key: "alpha:f",
        source: "alpha",
        kind: "put",
        worker: W,
        attempts: 8,
        error: "Timeout",
      },
      {
        type: "queue.dead",
        key: "alpha:f",
        source: "alpha",
        kind: "put",
        attempts: 8,
        worker: W,
        error: "Timeout",
      },
    ]);
    expect(
      await fail(sql, q.s, { key: "alpha:f", worker: "worker-b", errorClass: "X" }, q.hooks),
    ).toEqual({
      result: "missing",
      attempts: 0,
    });
    expect(q.events.at(-1)).toEqual({
      type: "queue.lost",
      key: "alpha:f",
      worker: "worker-b",
      operation: "fail",
      error: "X",
    });
  });
});

describe("QD6: retryDead, listDead, depth", () => {
  test("retryDead on dead, live and unknown keys", async () => {
    const q = await fresh();
    await q.put("alpha:dead");
    await q.put("alpha:live");
    await sql.unsafe(
      `UPDATE ${q.T} SET dead_at = clock_timestamp(), attempts = 8, last_error = 'X' WHERE key = 'alpha:dead'`,
    );
    q.events.length = 0;
    expect(await retryDead(sql, q.s, "alpha:dead", q.hooks)).toBe(true);
    expect(await q.row("alpha:dead")).toMatchObject({ dead: false, attempts: 0, last_error: null });
    expect(await retryDead(sql, q.s, "alpha:live", q.hooks)).toBe(false);
    expect(await retryDead(sql, q.s, "alpha:none", q.hooks)).toBe(false);
    expect(q.events).toEqual([
      { type: "queue.retried", key: "alpha:dead", source: "alpha", kind: "put" },
      { type: "queue.retry_noop", key: "alpha:live" },
      { type: "queue.retry_noop", key: "alpha:none" },
    ]);
  });

  test("listDead: newest first, by source, limited", async () => {
    const q = await fresh();
    for (const k of ["alpha:1", "alpha:2", "beta:1", "alpha:live"]) await q.put(k);
    await sql.unsafe(
      `UPDATE ${q.T} SET dead_at = now() - interval '3 hours', attempts = 8, last_error = 'A' WHERE key = 'alpha:1'`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET dead_at = now() - interval '1 hour', attempts = 8 WHERE key = 'alpha:2'`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET dead_at = now() - interval '2 hours', attempts = 3 WHERE key = 'beta:1'`,
    );
    const all = await listDead(sql, q.s);
    expect(all.map((r) => r.key)).toEqual(["alpha:2", "beta:1", "alpha:1"]);
    expect(all[2]).toMatchObject({ source: "alpha", kind: "put", attempts: 8, lastError: "A" });
    expect(all[2]?.deadAt).toBeInstanceOf(Date);
    expect(all[2]?.enqueuedAt).toBeInstanceOf(Date);
    expect((await listDead(sql, q.s, { source: "alpha" })).map((r) => r.key)).toEqual([
      "alpha:2",
      "alpha:1",
    ]);
    expect((await listDead(sql, q.s, { limit: 1 })).map((r) => r.key)).toEqual(["alpha:2"]);
    expect((await listDead(sql, q.s, { limit: 0 })).length).toBe(1);
  });

  test("depth on an empty and a mixed table", async () => {
    const q = await fresh();
    expect(await depth(sql, q.s)).toEqual([]);
    for (const k of ["alpha:due", "alpha:later", "alpha:claimed", "alpha:dead", "beta:due"])
      await q.put(k);
    await sql.unsafe(
      `UPDATE ${q.T} SET not_before = now() - interval '6 minutes', enqueued_at = now() - interval '2 hours' WHERE key = 'alpha:due'`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET not_before = now() + interval '1 hour' WHERE key = 'alpha:later'`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET claimed_at = now(), claimed_by = 'w' WHERE key = 'alpha:claimed'`,
    );
    await sql.unsafe(
      `UPDATE ${q.T} SET dead_at = now() - interval '3 hours' WHERE key = 'alpha:dead'`,
    );
    const [alpha, beta] = await depth(sql, q.s);
    expect(alpha).toMatchObject({ source: "alpha", queued: 3, due: 1, claimed: 1, dead: 1 });
    near(alpha?.oldestDueMinutes, 6, 0.5);
    near(alpha?.oldestWaitHours, 2, 0.05);
    near(alpha?.oldestDeadHours, 3, 0.05);
    expect(alpha?.oldestNotBefore).toBeInstanceOf(Date);
    expect(beta).toMatchObject({
      source: "beta",
      queued: 1,
      due: 1,
      claimed: 0,
      dead: 0,
      oldestDeadHours: null,
    });
  });
});

describe("QD7: contention", () => {
  test("an enqueue behind a held row lock returns contended within the lock timeout", async () => {
    const q = await fresh();
    await q.put("alpha:busy", { payload: { v: 1 } });
    const holder = openSecond();
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holding = holder.transactor.begin(async (tx) => {
      await tx.unsafe(`SELECT key FROM ${q.T} WHERE key = 'alpha:busy' FOR UPDATE`);
      locked();
      await tx.unsafe("SELECT pg_sleep(3)");
    });
    try {
      await isLocked;
      const started = Date.now();
      expect(await q.put("alpha:busy", { payload: { v: 2 } })).toBe("contended");
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(1900);
      expect(took).toBeLessThan(2900);
      expect(q.events.at(-1)).toEqual({
        type: "queue.contended",
        key: "alpha:busy",
        source: "alpha",
        kind: "put",
      });
    } finally {
      await holding;
      await holder.close();
    }
    expect((await q.row("alpha:busy"))?.payload).toEqual({ v: 1 });
  });
});

describe("QD8: enqueue inside a caller's transaction", () => {
  test("lock_timeout is left as it was and the caller's transaction commits", async () => {
    const q = await fresh();
    const setting = await main.transactor.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '7s'");
      await enqueue(tx, q.s, {
        key: "alpha:tx",
        source: "alpha",
        kind: "put",
        payload: {},
        debounceSeconds: 0,
      });
      const [r] = await tx.unsafe("SELECT current_setting('lock_timeout') AS v");
      return r?.v;
    });
    expect(setting).toBe("7s");
    expect(await q.row("alpha:tx")).toBeDefined();
  });

  test("a contended enqueue leaves the caller's transaction usable, lock_timeout unchanged", async () => {
    const q = await fresh();
    await q.put("alpha:held", { payload: { v: 1 } });
    const holder = openSecond();
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const holding = holder.transactor.begin(async (tx) => {
      await tx.unsafe(`SELECT key FROM ${q.T} WHERE key = 'alpha:held' FOR UPDATE`);
      locked();
      await hold;
    });
    try {
      await isLocked;
      const after = await main.transactor.begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = '7s'");
        const r = await enqueue(
          tx,
          q.s,
          {
            key: "alpha:held",
            source: "alpha",
            kind: "put",
            payload: { v: 2 },
            debounceSeconds: 0,
          },
          q.hooks,
        );
        const [lt] = await tx.unsafe("SELECT current_setting('lock_timeout') AS v");
        await tx.unsafe(
          `INSERT INTO ${q.T} (key, source, kind) VALUES ('alpha:after', 'alpha', 'put')`,
        );
        return { r, lockTimeout: lt?.v };
      });
      expect(after).toEqual({ r: "contended", lockTimeout: "7s" });
      expect(q.events.at(-1)).toMatchObject({ type: "queue.contended", key: "alpha:held" });
    } finally {
      release();
      await holding;
      await holder.close();
    }
    expect(await q.row("alpha:after")).toBeDefined();
    expect((await q.row("alpha:held"))?.payload).toEqual({ v: 1 });
  });

  test("under drizzle, through a transactor built over a drizzle transaction", async () => {
    const client = openTestClient();
    if (client.kind !== "drizzle") {
      await client.close();
      return;
    }
    const q = await fresh();
    try {
      const setting = await client.client.transaction(async (dtx) => {
        const t = drizzleTransactor(dtx as never, { sql: drizzleSql });
        await t.sql.unsafe("SET LOCAL lock_timeout = '7s'");
        await enqueue(t, q.s, {
          key: "alpha:dz",
          source: "alpha",
          kind: "put",
          payload: {},
          debounceSeconds: 0,
        });
        const [r] = await t.sql.unsafe("SELECT current_setting('lock_timeout') AS v");
        return r?.v;
      });
      expect(setting).toBe("7s");
      expect(await q.row("alpha:dz")).toBeDefined();
    } finally {
      await client.close();
    }
  });
});

describe("QD9: a missing table", () => {
  test("every function refuses NOTABLE, naming the table", async () => {
    const s = queueSlice({ ...QUEUE_INPUT, table: { schema: "rs_missing" } });
    const calls: [string, () => Promise<unknown>][] = [
      [
        "enqueue",
        () =>
          enqueue(main.transactor, s, {
            key: "alpha:1",
            source: "alpha",
            kind: "put",
            payload: {},
            debounceSeconds: 0,
          }),
      ],
      ["claim", () => claim(sql, s, { source: "alpha", limit: 1, worker: W })],
      ["ack", () => ack(sql, s, { key: "alpha:1", worker: W })],
      ["fail", () => fail(sql, s, { key: "alpha:1", worker: W, errorClass: "X" })],
      ["retryDead", () => retryDead(sql, s, "alpha:1")],
      ["listDead", () => listDead(sql, s)],
      ["depth", () => depth(sql, s)],
    ];
    for (const [fn, call] of calls) {
      let err: unknown;
      try {
        await call();
      } catch (e) {
        err = e;
      }
      expect(err, fn).toBeInstanceOf(RootstockQueueError);
      const e = err as RootstockQueueError;
      expect(e.code, fn).toBe("ERR_ROOTSTOCK_QUEUE_NOTABLE");
      expect(e.table, fn).toBe("rs_missing.work_queue");
      expect(e.message, fn).toBe(
        "rootstock queue: rs_missing.work_queue does not exist — run the migrations (the table ships with rootstock 0.6.0, or is your own)",
      );
      expect(pgCode(e.cause), fn).toBe("42P01");
    }
  });
});
