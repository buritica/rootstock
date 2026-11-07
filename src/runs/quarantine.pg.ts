import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgCode, type Sql } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import {
  pendingQuarantine,
  type QuarantineTable,
  quarantine,
  quarantineSafe,
  quarantineTable,
  RootstockRunsError,
  type RunsEvent,
  resolveQuarantine,
} from "./index.ts";

// R-D3 (contract §13.4 QD1–QD6): quarantine on rootstock's table, applied by
// rootstock's own migrations, and on tables of the test's own, once per
// transactor kind.

let main: TestTransactor;
let sql: Sql;
let sc: string;
const { schema, dropAll } = schemaFactory("rs_qd");
const CAPS = { maxPayloadBytes: 1_024, maxReasonChars: 64 };
let T: QuarantineTable;

beforeAll(async () => {
  main = openTestTransactor();
  sql = main.transactor.sql;
  sc = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: sc }));
  T = quarantineTable(CAPS, { schema: sc });
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

function recorder() {
  const events: RunsEvent[] = [];
  return { events, deps: { onEvent: (e: RunsEvent) => events.push(e) } };
}

interface Stored {
  payload: string;
  reason: string;
  status: string;
  resolved: boolean;
  run_id: string | null;
  failed_ms: string;
}

async function row(job: string, externalId: string): Promise<Stored | undefined> {
  const [r] = await sql.unsafe<Stored>(
    `SELECT payload::text AS payload, reason, status, resolved_at IS NOT NULL AS resolved,
            run_id::text AS run_id, floor(extract(epoch FROM failed_at) * 1000)::text AS failed_ms
     FROM "${sc}".quarantine WHERE job = $1 AND external_id = $2`,
    [job, externalId],
  );
  return r;
}

const truthy = (v: unknown) => v === true || v === "t" || v === "true";
const RUN = "0f0e0d0c-0b0a-4908-8706-050403020100";

describe("QD1: put, repeat put, resolve, pending", () => {
  test("QD1 put writes a pending row; a repeat put resets it with the new payload", async () => {
    const r = recorder();
    await quarantine(
      sql,
      T,
      { job: "alpha-sync", externalId: "rec-1", payload: { n: 1 }, reason: "first", runId: RUN },
      r.deps,
    );
    const first = await row("alpha-sync", "rec-1");
    expect(first).toMatchObject({ payload: '{"n": 1}', reason: "first", status: "pending" });
    expect(first?.run_id).toBe(RUN);
    expect(truthy(first?.resolved)).toBe(false);

    expect(
      await resolveQuarantine(sql, T, { job: "alpha-sync", externalIds: ["rec-1"] }, r.deps),
    ).toBe(1);
    const resolved = await row("alpha-sync", "rec-1");
    expect(resolved?.status).toBe("resolved");
    expect(truthy(resolved?.resolved)).toBe(true);

    await sql.unsafe("SELECT pg_sleep(0.01)");
    await quarantine(
      sql,
      T,
      { job: "alpha-sync", externalId: "rec-1", payload: [2], reason: "second" },
      r.deps,
    );
    const again = await row("alpha-sync", "rec-1");
    expect(again).toMatchObject({ payload: "[2]", reason: "second", status: "pending" });
    expect(truthy(again?.resolved)).toBe(false);
    expect(again?.run_id).toBeNull();
    expect(Number(again?.failed_ms)).toBeGreaterThan(Number(first?.failed_ms));
    const [{ n } = { n: "" }] = await sql.unsafe<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${sc}".quarantine WHERE job = 'alpha-sync' AND external_id = 'rec-1'`,
    );
    expect(n).toBe("1");
    expect(r.events).toEqual([
      { type: "runs.quarantined", job: "alpha-sync", externalId: "rec-1", runId: RUN },
      { type: "runs.resolved", job: "alpha-sync", count: 1 },
      { type: "runs.quarantined", job: "alpha-sync", externalId: "rec-1", runId: null },
    ]);
  });

  test("QD1 the reason is cut to maxReasonChars", async () => {
    await quarantine(sql, T, {
      job: "alpha-sync",
      externalId: "rec-long",
      payload: {},
      reason: "x".repeat(200),
    });
    expect((await row("alpha-sync", "rec-long"))?.reason).toBe("x".repeat(64));
  });

  test("QD1 pending lists the job's pending rows, with and without ids; resolve counts only pending", async () => {
    const job = "beta-sync";
    // Inserted in reverse id order, so the order back is by failure time, not id.
    for (const id of ["b-3", "b-2", "b-1"]) {
      await quarantine(sql, T, { job, externalId: id, payload: { id }, reason: `why ${id}` });
      await sql.unsafe("SELECT pg_sleep(0.002)");
    }
    await quarantine(sql, T, {
      job: "gamma-push",
      externalId: "b-1",
      payload: {},
      reason: "other",
    });

    const all = await pendingQuarantine(sql, T, { job });
    expect(all.map((p) => [p.externalId, p.reason])).toEqual([
      ["b-3", "why b-3"],
      ["b-2", "why b-2"],
      ["b-1", "why b-1"],
    ]);
    for (const p of all) {
      expect(p.failedAt).toBeInstanceOf(Date);
      expect(Number.isFinite(p.failedAt.getTime())).toBe(true);
    }
    const some = await pendingQuarantine(sql, T, { job, externalIds: ["b-3", "b-1", "nope"] });
    expect(some.map((p) => p.externalId)).toEqual(["b-3", "b-1"]);
    expect(await pendingQuarantine(sql, T, { job, externalIds: [] })).toEqual([]);

    const r = recorder();
    expect(
      await resolveQuarantine(sql, T, { job, externalIds: ["b-1", "b-2", "nope"] }, r.deps),
    ).toBe(2);
    expect(await resolveQuarantine(sql, T, { job, externalIds: ["b-1"] }, r.deps)).toBe(0);
    expect(r.events).toEqual([{ type: "runs.resolved", job, count: 2 }]);
    expect((await pendingQuarantine(sql, T, { job })).map((p) => p.externalId)).toEqual(["b-3"]);
    expect(
      (await pendingQuarantine(sql, T, { job: "gamma-push" })).map((p) => p.externalId),
    ).toEqual(["b-1"]);
  });
});

describe("QD2: an origin-shaped table through QU1′", () => {
  test("QD2 job column renamed, no run column: put, repeat, resolve, pending", async () => {
    await sql.unsafe(
      `CREATE TABLE "${sc}".origin_failed (
         id serial PRIMARY KEY,
         adapter_id text NOT NULL,
         external_id text NOT NULL,
         payload jsonb NOT NULL,
         reason text NOT NULL,
         status text NOT NULL DEFAULT 'pending',
         failed_at timestamptz NOT NULL DEFAULT now(),
         resolved_at timestamptz,
         UNIQUE (adapter_id, external_id)
       )`,
    );
    const t = quarantineTable(
      { ...CAPS, table: { name: "origin_failed" }, columns: { job: "adapter_id", runId: null } },
      { schema: sc },
    );
    const r = recorder();
    const a = { job: "delta:one", externalId: "o-1", reason: "bad" };
    await quarantine(sql, t, { ...a, payload: { v: 1 }, runId: RUN }, r.deps);
    await resolveQuarantine(sql, t, { job: "delta:one", externalIds: ["o-1"] });
    await quarantine(sql, t, { ...a, payload: { v: 2 } }, r.deps);
    const rows = await sql.unsafe<{ adapter_id: string; payload: string; status: string }>(
      `SELECT adapter_id, payload::text AS payload, status FROM "${sc}".origin_failed`,
    );
    expect(rows).toEqual([{ adapter_id: "delta:one", payload: '{"v": 2}', status: "pending" }]);
    expect(
      (await pendingQuarantine(sql, t, { job: "delta:one" })).map((p) => p.externalId),
    ).toEqual(["o-1"]);
    expect(await resolveQuarantine(sql, t, { job: "delta:one", externalIds: ["o-1"] })).toBe(1);
    expect(await pendingQuarantine(sql, t, { job: "delta:one" })).toEqual([]);
    expect(r.events.map((e) => e.type === "runs.quarantined" && e.runId)).toEqual([null, null]);
  });
});

describe("QD3: the caller's transaction", () => {
  test("QD3 a quarantine in a transaction that rolls back is gone; one that commits stays", async () => {
    const sentinel = new Error("batch failed");
    let err: unknown;
    try {
      await main.transactor.begin(async (tx) => {
        await quarantine(tx, T, {
          job: "alpha-sync",
          externalId: "tx-rolled",
          payload: {},
          reason: "r",
        });
        expect(
          await pendingQuarantine(tx, T, { job: "alpha-sync", externalIds: ["tx-rolled"] }),
        ).toHaveLength(1);
        throw sentinel;
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBe(sentinel);
    expect(await row("alpha-sync", "tx-rolled")).toBeUndefined();

    await main.transactor.begin(async (tx) => {
      await tx.savepoint(async (sp) => {
        await quarantine(sp, T, {
          job: "alpha-sync",
          externalId: "tx-kept",
          payload: {},
          reason: "r",
        });
      });
    });
    expect((await row("alpha-sync", "tx-kept"))?.status).toBe("pending");
  });
});

describe("QD4: quarantineSafe", () => {
  let small: QuarantineTable;
  beforeAll(async () => {
    await sql.unsafe(
      `CREATE TABLE "${sc}".q_small (LIKE "${sc}".quarantine INCLUDING ALL);
       ALTER TABLE "${sc}".q_small ADD CONSTRAINT q_small_payload CHECK (length(payload::text) <= 60)`,
    );
    small = quarantineTable({ ...CAPS, table: { name: "q_small" } }, { schema: sc });
  });

  test("QD4 retries with the minimal payload when the first insert fails", async () => {
    const r = recorder();
    const ok = await quarantineSafe(
      main.transactor,
      small,
      { job: "alpha-sync", externalId: "s-1", payload: { big: "y".repeat(200) }, reason: "r" },
      r.deps,
    );
    expect(ok).toBe(true);
    const [stored] = await sql.unsafe<{ payload: string }>(
      `SELECT payload::text AS payload FROM "${sc}".q_small WHERE external_id = 's-1'`,
    );
    expect(JSON.parse(stored?.payload ?? "null")).toEqual({ externalId: "s-1", truncated: true });
    expect(r.events).toEqual([
      { type: "runs.quarantined", job: "alpha-sync", externalId: "s-1", runId: null },
    ]);
  });

  test("QD4 a payload that fits lands as given", async () => {
    expect(
      await quarantineSafe(main.transactor, small, {
        job: "alpha-sync",
        externalId: "s-2",
        payload: { ok: 1 },
        reason: "r",
      }),
    ).toBe(true);
    const [stored] = await sql.unsafe<{ payload: string }>(
      `SELECT payload::text AS payload FROM "${sc}".q_small WHERE external_id = 's-2'`,
    );
    expect(stored?.payload).toBe('{"ok": 1}');
  });

  test("QD4 returns false when both fail, reporting the second failure", async () => {
    const r = recorder();
    const externalId = `s-${"z".repeat(60)}`;
    const ok = await quarantineSafe(
      main.transactor,
      small,
      { job: "alpha-sync", externalId, payload: { big: "y".repeat(200) }, reason: "r" },
      r.deps,
    );
    expect(ok).toBe(false);
    expect(r.events).toHaveLength(1);
    const e = r.events[0] as Extract<RunsEvent, { type: "runs.record_failed" }>;
    expect(e).toMatchObject({
      type: "runs.record_failed",
      operation: "quarantine",
      job: "alpha-sync",
      code: "23514",
    });
    expect(pgCode(e.error)).toBe("23514");
    const [{ n } = { n: "" }] = await sql.unsafe<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${sc}".q_small WHERE external_id = $1`,
      [externalId],
    );
    expect(n).toBe("0");
  });

  test("QD4 inside an open transaction, a payload the server refuses (22P05) lands the fallback in a fresh savepoint and leaves the transaction usable (§20 A1)", async () => {
    const r = recorder();
    const after = await main.transactor.begin(async (tx) => {
      const ok = await quarantineSafe(
        tx,
        T,
        { job: "alpha-sync", externalId: "nul-1", payload: { text: "a\u0000b" }, reason: "r" },
        r.deps,
      );
      expect(ok).toBe(true);
      const [n] = await tx.unsafe<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${sc}".quarantine WHERE external_id = 'nul-1'`,
      );
      return n?.n;
    });
    expect(after).toBe("1");
    const stored = await row("alpha-sync", "nul-1");
    expect(JSON.parse(stored?.payload ?? "null")).toEqual({ externalId: "nul-1", truncated: true });
    expect(r.events).toEqual([
      { type: "runs.quarantined", job: "alpha-sync", externalId: "nul-1", runId: null },
    ]);
  });

  test("QD4 a missing table refuses NOTABLE at once, from every call", async () => {
    const missing = quarantineTable(
      { ...CAPS, table: { name: "no_such_quarantine" } },
      { schema: sc },
    );
    const a = { job: "alpha-sync", externalId: "m-1", payload: {}, reason: "r" };
    const r = recorder();
    for (const call of [
      () => quarantine(sql, missing, a, r.deps),
      () => quarantineSafe(main.transactor, missing, a, r.deps),
      () => resolveQuarantine(sql, missing, { job: "alpha-sync", externalIds: ["m-1"] }, r.deps),
      () => pendingQuarantine(sql, missing, { job: "alpha-sync" }),
    ]) {
      let err: unknown;
      try {
        await call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RootstockRunsError);
      expect((err as RootstockRunsError).code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
      expect((err as Error).message).toBe(
        `rootstock runs: ${sc}.no_such_quarantine does not exist — run the migrations (the table ships with rootstock 0.8.0, or is your own)`,
      );
      expect(pgCode((err as Error).cause)).toBe("42P01");
    }
    expect(r.events).toEqual([]);
  });
});

describe("QD5: the unique index is required", () => {
  test("QD5 a table without the unique index on (job, externalId) fails 42P10 on the first put", async () => {
    await sql.unsafe(
      `CREATE TABLE "${sc}".q_no_index (LIKE "${sc}".quarantine INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
    );
    const t = quarantineTable({ ...CAPS, table: { name: "q_no_index" } }, { schema: sc });
    const r = recorder();
    let err: unknown;
    try {
      await quarantine(
        sql,
        t,
        { job: "alpha-sync", externalId: "u-1", payload: {}, reason: "r" },
        r.deps,
      );
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(RootstockRunsError);
    expect(pgCode(err)).toBe("42P10");
    expect(r.events).toEqual([]);
  });
});

describe("QD6: payload over maxPayloadBytes", () => {
  test("QD6 refuses INPUT before any query", async () => {
    // A table that does not exist: had a query been sent, the refusal would be NOTABLE.
    const missing = quarantineTable(
      { ...CAPS, table: { name: "no_such_quarantine" } },
      { schema: sc },
    );
    const r = recorder();
    for (const t of [missing, T]) {
      let err: unknown;
      try {
        await quarantine(
          sql,
          t,
          { job: "alpha-sync", externalId: "big-1", payload: "p".repeat(1_023), reason: "r" },
          r.deps,
        );
      } catch (e) {
        err = e;
      }
      expect((err as RootstockRunsError).code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
      expect((err as Error).message).toBe(
        'rootstock runs: quarantine("big-1"): payload is 1025 bytes, over the 1024 cap',
      );
    }
    expect(await row("alpha-sync", "big-1")).toBeUndefined();
    expect(r.events).toEqual([]);
  });
});
