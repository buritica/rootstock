import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import {
  openSecond,
  openTestTransactor,
  type TestTransactor,
} from "../db/transactor.pg-support.ts";
import { lockErrorCode, type RunLock } from "../lock/index.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import { QUEUE_INPUT } from "../queue/fixtures.test-support.ts";
import {
  enqueue,
  type QueueEvent,
  type QueueRow,
  type QueueSlice,
  type QueueSliceInput,
  queueSlice,
} from "../queue/index.ts";
import { runsInput } from "../runs/fixtures.test-support.ts";
import { type Run, runsSlice, startRun } from "../runs/index.ts";
import { drainQueue } from "./drain.ts";
import { runnerLockSlice, takeLock } from "./fixtures.pg-support.ts";
import type {
  DrainFailure,
  DrainInput,
  DrainOutcome,
  DrainReport,
  RunnerEvent,
  SourceDrain,
} from "./types.ts";

// R-D11 (contract §9): the drain against a real queue table and the real
// lock, once per transactor kind, each case in a schema of its own.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_drain");
const held: RunLock[] = [];

beforeAll(() => {
  main = openTestTransactor();
  sql = main.transactor.sql;
});

afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

const W = "worker-a";
const LOCKS: Record<string, string> = { alpha: "alpha-sync", beta: "beta-sync" };

interface Env {
  sc: string;
  s: QueueSlice;
  T: string;
  events: (RunnerEvent | QueueEvent)[];
  starts: string[];
  settles: { source: string; drain: SourceDrain; failure?: DrainFailure }[];
  put: (key: string) => Promise<void>;
  takeLock: (name: string) => Promise<RunLock>;
  row: (key: string) => Promise<Record<string, unknown> | undefined>;
}

async function fresh(over: Partial<QueueSliceInput> = {}): Promise<Env> {
  const sc = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: sc }));
  const s = queueSlice({ ...QUEUE_INPUT, ...over }, { schema: sc });
  const lock = runnerLockSlice(sc);
  const T = `"${sc}".work_queue`;
  return {
    sc,
    s,
    T,
    events: [],
    starts: [],
    settles: [],
    put: async (key) => {
      await enqueue(main.transactor, s, {
        key,
        source: key.split(":")[0] as string,
        kind: "put",
        payload: {},
        debounceSeconds: 0,
      });
    },
    takeLock: async (name) => {
      const l = await takeLock(lock, name);
      held.push(l);
      return l;
    },
    row: async (key) => {
      const [r] = await sql.unsafe(
        `SELECT attempts::text AS attempts, last_error, claimed_by, dead_at IS NOT NULL AS dead,
                claimed_at IS NOT NULL AS claimed
         FROM ${T} WHERE key = $1`,
        [key],
      );
      return r === undefined ? undefined : { ...r, attempts: Number(r.attempts) };
    },
  };
}

class FatalError extends Error {
  override name = "FatalError";
}
class Archived extends Error {
  override name = "Archived";
  readonly archivedParts: number;
  constructor(archivedParts: number) {
    super("archived then threw");
    this.archivedParts = archivedParts;
  }
}

type Handler = (row: QueueRow) => Promise<DrainOutcome>;

async function drain(
  env: Env,
  handlers: Partial<Record<"alpha" | "beta", Handler>>,
  over: Partial<DrainInput<string, RunLock>> = {},
): Promise<DrainReport> {
  const lockSlice = runnerLockSlice(env.sc);
  return drainQueue<string, RunLock>(
    {
      tx: main.transactor,
      queue: env.s,
      sources: (["alpha", "beta"] as const).map((source) => ({
        source,
        lockName: LOCKS[source] as string,
        ...(handlers[source]
          ? { handle: (row: QueueRow) => (handlers[source] as Handler)(row) }
          : {}),
      })),
      worker: W,
      limit: 100,
      maxArchivals: 50,
      minRowsForAllFailed: 2,
      contendedBrake: 3,
      acquire: (src) => takeLock(lockSlice, src.lockName),
      isHeld: (err) => lockErrorCode(err) === "ERR_ROOTSTOCK_LOCK_HELD",
      isFatal: (err) => err instanceof FatalError,
      errorClassOf: (err) => (err instanceof Error ? err.name : "Error"),
      heldClass: { capped: "HeldCapped", interrupted: "HeldInterrupted", aborted: "HeldAborted" },
      archivedBefore: (err) => (err instanceof Archived ? err.archivedParts : 0),
      interrupted: () => false,
      record: {
        start: async (_lock, source) => {
          env.starts.push(source);
          return `rec-${source}`;
        },
        settle: async (record, s) => {
          env.settles.push({ source: String(record).replace("rec-", ""), ...s });
        },
      },
      ...over,
    },
    { onEvent: (e) => env.events.push(e), queueHooks: { onEvent: (e) => env.events.push(e) } },
  );
}

const ok: Handler = async () => ({});

/** A second session holding the row locks of `keys` until `done()` (idempotent). */
async function holdRows(env: Env, keys: string[]) {
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
    await tx.unsafe(
      `SELECT key FROM ${env.T} WHERE key IN (SELECT jsonb_array_elements_text($1::text::jsonb)) FOR UPDATE`,
      [JSON.stringify(keys)],
    );
    locked();
    await hold;
  });
  await isLocked;
  let closed = false;
  return {
    async done() {
      if (closed) return;
      closed = true;
      release();
      await holding;
      await holder.close();
    },
  };
}
const types = (env: Env) =>
  env.events.filter((e) => e.type.startsWith("drain.")).map((e) => e.type);

describe("DR1/DR2 nothing to do", () => {
  test("a held lock skips the source: no claim, no record", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.takeLock("alpha-sync");
    const report = await drain(env, { alpha: ok });
    expect(report.status).toBe(0);
    expect(report.drains[0]).toMatchObject({ source: "alpha", skippedLocked: 1, handled: 0 });
    expect(env.starts).toEqual([]);
    expect(await env.row("alpha:1")).toMatchObject({ claimed: false });
  });

  test("an empty claim starts no record; a source without a handler is never claimed", async () => {
    const env = await fresh();
    await env.put("beta:1");
    const report = await drain(env, { alpha: ok });
    expect(report.status).toBe(0);
    expect(env.starts).toEqual([]);
    expect(types(env)).toEqual(["drain.empty", "drain.no_handler", "drain.done"]);
    expect(await env.row("beta:1")).toMatchObject({ claimed: false });
  });
});

describe("DR3 a clean drain", () => {
  test("every row acked, the record settled once with no failure", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.put("alpha:2");
    await env.put("beta:1");
    const report = await drain(env, { alpha: async () => ({ excluded: true }), beta: ok });
    expect(report.status).toBe(0);
    expect(report.drains.map((d) => [d.source, d.handled, d.acked, d.excluded])).toEqual([
      ["alpha", 2, 2, 2],
      ["beta", 1, 1, 0],
    ]);
    expect(env.settles.map((s) => [s.source, s.failure])).toEqual([
      ["alpha", undefined],
      ["beta", undefined],
    ]);
    expect(await env.row("alpha:1")).toBeUndefined();
  });
});

describe("DR4 the archival cap", () => {
  test("trips mid-batch: held rows failed with the capped class, later sources stopped", async () => {
    const env = await fresh();
    for (const k of ["alpha:1", "alpha:2", "alpha:3", "beta:1"]) await env.put(k);
    const report = await drain(
      env,
      { alpha: async () => ({ archived: 3 }), beta: ok },
      { maxArchivals: 5 },
    );
    expect(report.status).toBe(1);
    expect(report.archived).toBe(6);
    expect(report.drains).toHaveLength(1);
    expect(report.drains[0]).toMatchObject({ handled: 2, acked: 2, failed: 1, archived: 6 });
    expect(env.settles[0]?.failure).toEqual({
      kind: "capped",
      archived: 6,
      cap: 5,
      jammed: false,
      leftClaimed: 0,
    });
    expect(await env.row("alpha:3")).toMatchObject({ last_error: "HeldCapped", claimed: false });
    expect(env.events).toContainEqual({
      type: "drain.sources_stopped",
      source: "beta",
      reason: "archival-cap",
    });
  });

  test("DR12 a throwing handler's archived parts are charged", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.put("alpha:2");
    const report = await drain(
      env,
      {
        alpha: async () => {
          throw new Archived(4);
        },
      },
      { maxArchivals: 4 },
    );
    expect(report.archived).toBe(4);
    expect(env.settles[0]?.failure?.kind).toBe("capped");
  });
});

describe("DR5 interrupt", () => {
  test("between rows: the rest failed with the interrupted class", async () => {
    const env = await fresh();
    for (const k of ["alpha:1", "alpha:2", "alpha:3"]) await env.put(k);
    let handled = 0;
    const report = await drain(
      env,
      {
        alpha: async () => {
          handled += 1;
          return {};
        },
      },
      { interrupted: () => handled >= 1 },
    );
    expect(report.status).toBe(1);
    expect(report.drains[0]).toMatchObject({ handled: 1, acked: 1, failed: 2 });
    expect(env.settles[0]?.failure).toEqual({ kind: "interrupted", jammed: false, leftClaimed: 0 });
    expect(await env.row("alpha:2")).toMatchObject({ last_error: "HeldInterrupted" });
  });

  test("between sources: the next source is not drained", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.put("beta:1");
    let calls = 0;
    const report = await drain(env, { alpha: ok, beta: ok }, { interrupted: () => calls++ >= 2 });
    expect(report.status).toBe(1);
    expect(env.events).toContainEqual({
      type: "drain.sources_stopped",
      source: "beta",
      reason: "interrupted",
    });
  });
});

describe("DR6 a fatal handler error", () => {
  test("the rest are failed aborted, failure fatal, drain.aborted", async () => {
    const env = await fresh();
    for (const k of ["alpha:1", "alpha:2", "alpha:3"]) await env.put(k);
    const fatal = new FatalError("lost it");
    const report = await drain(env, {
      alpha: async (row) => {
        if (row.key === "alpha:1") throw fatal;
        return {};
      },
    });
    expect(report.status).toBe(1);
    expect(report.drains[0]).toMatchObject({ handled: 1, failed: 3 });
    expect(env.settles[0]?.failure).toEqual({ kind: "fatal", error: fatal });
    expect(await env.row("alpha:1")).toMatchObject({ last_error: "FatalError" });
    expect(await env.row("alpha:2")).toMatchObject({ last_error: "HeldAborted" });
    expect(types(env)).toContain("drain.aborted");
  });
});

describe("DR8/DR9/DR11 failure kinds and order", () => {
  test("one failing row is not all-failed; two are", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    const boom = async (): Promise<DrainOutcome> => {
      throw new Error("boom");
    };
    expect((await drain(env, { alpha: boom })).status).toBe(0);
    const env2 = await fresh();
    await env2.put("alpha:1");
    await env2.put("alpha:2");
    const report = await drain(env2, { alpha: boom });
    expect(report.status).toBe(1);
    expect(env2.settles[0]?.failure).toEqual({ kind: "all-failed", handled: 2 });
  });

  test("a dead-lettered row fails the drain as dead", async () => {
    const env = await fresh({ maxAttempts: 1 });
    await env.put("alpha:1");
    await env.put("alpha:2");
    const report = await drain(env, {
      alpha: async (row) => {
        if (row.key === "alpha:1") throw new Error("bad file");
        return {};
      },
    });
    expect(report.status).toBe(1);
    expect(env.settles[0]?.failure).toEqual({ kind: "dead", dead: 1 });
    expect(await env.row("alpha:1")).toMatchObject({ dead: true });
  });

  test("capped outranks all-failed", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.put("alpha:2");
    await drain(
      env,
      {
        alpha: async () => {
          throw new Archived(10);
        },
      },
      { maxArchivals: 5 },
    );
    expect(env.settles[0]?.failure?.kind).toBe("capped");
  });
});

describe("DR7 contention", () => {
  test("contendedBrake acks in a row jam the drain; the rest stay claimed", async () => {
    const env = await fresh({ ackLockTimeoutMs: 200 });
    for (const k of ["alpha:1", "alpha:2", "alpha:3", "alpha:4"]) await env.put(k);
    const holder = openSecond();
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    // Claim skips locked rows, so the holder locks them only once they are claimed.
    let holding: Promise<void> | undefined;
    const lockAll: Handler = async () => {
      holding ??= holder.transactor.begin(async (tx) => {
        await tx.unsafe(`SELECT key FROM ${env.T} FOR UPDATE`);
        locked();
        await hold;
      });
      await isLocked;
      return {};
    };
    try {
      const report = await drain(env, { alpha: lockAll }, { contendedBrake: 2 });
      expect(report.status).toBe(1);
      expect(report.drains[0]).toMatchObject({ handled: 2, acked: 0, contended: 2, jammed: 2 });
      expect(env.settles[0]?.failure).toEqual({ kind: "jammed", leftClaimed: 4 });
      expect(types(env).filter((t) => t === "drain.row_contended")).toHaveLength(2);
    } finally {
      release();
      await holding;
      await holder.close();
    }
    expect(await env.row("alpha:3")).toMatchObject({ claimed: true, attempts: 0 });
  });
});

describe("DR10 the queue throws", () => {
  test("settled once with the queue failure; a settle throw after a clean drain does not settle twice", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    // The table vanishes under the drain: the ack throws.
    const report = await drain(env, {
      alpha: async () => {
        await sql.unsafe(`ALTER TABLE ${env.T} RENAME TO gone`);
        return {};
      },
    });
    expect(report.status).toBe(1);
    expect(env.settles).toHaveLength(1);
    expect(env.settles[0]?.failure?.kind).toBe("queue");

    const env2 = await fresh();
    await env2.put("alpha:1");
    let settles = 0;
    const report2 = await drain(
      env2,
      { alpha: ok },
      {
        record: {
          start: async () => "r",
          settle: async () => {
            settles += 1;
            throw new Error("fact failed");
          },
        },
      },
    );
    expect(report2.status).toBe(1);
    expect(settles).toBe(1);
  });
});

describe("drain context", () => {
  test("extend extends this row's claim and the record reaches the handler", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    const seen: unknown[] = [];
    await drainQueue<string, RunLock>(
      {
        tx: main.transactor,
        queue: env.s,
        sources: [
          {
            source: "alpha",
            lockName: "alpha-sync",
            handle: async (_row, ctx) => {
              seen.push(ctx.record, await ctx.extend());
              await ctx.ensureExclusive();
              return {};
            },
          },
        ],
        worker: W,
        limit: 10,
        maxArchivals: 50,
        minRowsForAllFailed: 2,
        contendedBrake: 3,
        acquire: (src) => takeLock(runnerLockSlice(env.sc), src.lockName),
        isHeld: () => false,
        isFatal: () => false,
        errorClassOf: () => "Error",
        heldClass: { capped: "a", interrupted: "b", aborted: "c" },
        interrupted: () => false,
        record: { start: async () => "the-record", settle: async () => {} },
      },
      {},
    );
    expect(seen).toEqual(["the-record", "extended"]);
  });
});

describe("acquire", () => {
  test("a refusal isHeld does not recognise propagates", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    const boom = new Error("lock table missing");
    const err = await drain(
      env,
      { alpha: ok },
      {
        acquire: async () => {
          throw boom;
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(await env.row("alpha:1")).toMatchObject({ claimed: false });
  });
});

describe("composition with the run record (F27)", () => {
  test("a killed drain's running row is settled by the next drain that claims rows, not by an empty one", async () => {
    const env = await fresh();
    const runs = runsSlice(runsInput(), { schema: env.sc });
    const runsDeps = { now: () => Date.now(), randomUUID: () => crypto.randomUUID() };
    const statusOf = async (id: string) =>
      (
        await sql.unsafe<{ status: string }>(`SELECT status FROM "${env.sc}".runs WHERE id = $1`, [
          id,
        ])
      )[0]?.status;
    // A drain that died with its record open: the lock's session is gone, the row says running.
    const dead = await env.takeLock("alpha-sync");
    const killed = await startRun(
      sql,
      runs,
      { job: "alpha-sync", mode: "incremental", lock: dead },
      runsDeps,
    );
    await dead.release();
    const record = {
      start: (lock: RunLock) =>
        startRun(sql, runs, { job: "alpha-sync", mode: "incremental", lock }, runsDeps),
      settle: async (r: Run | null, x: { failure?: DrainFailure }) => {
        await r?.finish(x.failure === undefined ? "ok" : "failed");
      },
    };
    const only = (over: Partial<DrainInput<Run, RunLock>>) =>
      drainQueue<Run, RunLock>(
        {
          tx: main.transactor,
          queue: env.s,
          sources: [{ source: "alpha", lockName: "alpha-sync", handle: ok }],
          worker: W,
          limit: 10,
          maxArchivals: 50,
          minRowsForAllFailed: 2,
          contendedBrake: 3,
          acquire: (src) => takeLock(runnerLockSlice(env.sc), src.lockName),
          isHeld: () => false,
          isFatal: () => false,
          errorClassOf: () => "Error",
          heldClass: { capped: "a", interrupted: "b", aborted: "c" },
          interrupted: () => false,
          record,
          ...over,
        },
        {},
      );
    // An empty drain starts no record, so the killed row stays running.
    expect((await only({})).drains[0]).toMatchObject({ handled: 0 });
    expect(await statusOf(killed.id)).toBe("running");
    // The next drain that claims rows starts a record under the lock: that settles it.
    await env.put("alpha:1");
    expect((await only({})).drains[0]).toMatchObject({ handled: 1, acked: 1 });
    expect(await statusOf(killed.id)).toBe("interrupted");
  });
});

describe("DR11 failure precedence", () => {
  test("fatal beats capped", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.put("alpha:2");
    const fatal = new FatalError("lost it");
    const report = await drain(
      env,
      {
        alpha: async () => {
          throw fatal;
        },
      },
      { maxArchivals: 5, archivedBefore: () => 10 },
    );
    expect(report.status).toBe(1);
    expect(types(env)).toContain("drain.archival_cap");
    expect(env.settles[0]?.failure).toEqual({ kind: "fatal", error: fatal });
  });

  // Row 1 is handled while a second session locks rows 2 and 3: row 2's held
  // fail is contended (the brake at 1 jams), row 3 is left claimed.
  const jamAfterFirst = async (
    env: Env,
    outcome: DrainOutcome,
    over: Partial<DrainInput<string, RunLock>>,
  ) => {
    for (const k of ["alpha:1", "alpha:2", "alpha:3"]) await env.put(k);
    let hold: Awaited<ReturnType<typeof holdRows>> | undefined;
    try {
      return await drain(
        env,
        {
          alpha: async () => {
            hold = await holdRows(env, ["alpha:2", "alpha:3"]);
            return outcome;
          },
        },
        { contendedBrake: 1, ...over },
      );
    } finally {
      await hold?.done();
    }
  };

  test("interrupted beats jammed, and says it jammed", async () => {
    const env = await fresh({ ackLockTimeoutMs: 200 });
    // Asked before the source, before row 1, then before row 2: true there.
    let calls = 0;
    const report = await jamAfterFirst(env, {}, { interrupted: () => calls++ >= 2 });
    expect(report.status).toBe(1);
    expect(report.drains[0]).toMatchObject({ handled: 1, acked: 1, contended: 1, jammed: 1 });
    expect(env.settles[0]?.failure).toEqual({ kind: "interrupted", jammed: true, leftClaimed: 2 });
  });

  test("capped beats jammed and carries jammed: true", async () => {
    const env = await fresh({ ackLockTimeoutMs: 200 });
    const report = await jamAfterFirst(env, { archived: 10 }, { maxArchivals: 5 });
    expect(report.status).toBe(1);
    expect(report.drains[0]).toMatchObject({ handled: 1, acked: 1, contended: 1, jammed: 1 });
    expect(env.settles[0]?.failure).toEqual({
      kind: "capped",
      archived: 10,
      cap: 5,
      jammed: true,
      leftClaimed: 2,
    });
  });

  test("all-failed beats dead", async () => {
    const env = await fresh({ maxAttempts: 1 });
    await env.put("alpha:1");
    await env.put("alpha:2");
    const report = await drain(env, {
      alpha: async () => {
        throw new Error("bad file");
      },
    });
    expect(report.drains[0]).toMatchObject({ handled: 2, dead: 2 });
    expect(types(env)).toContain("drain.dead_lettered");
    expect(env.settles[0]?.failure).toEqual({ kind: "all-failed", handled: 2 });
  });
});

describe("DR7 the contention streak", () => {
  test("a landed ack resets it: two contended acks apart never reach a brake of 2", async () => {
    const env = await fresh({ ackLockTimeoutMs: 200 });
    for (const k of ["alpha:1", "alpha:2", "alpha:3"]) await env.put(k);
    const holds: Awaited<ReturnType<typeof holdRows>>[] = [];
    try {
      const report = await drain(
        env,
        {
          alpha: async (row) => {
            if (row.key === "alpha:2") await holds[0]?.done();
            else holds.push(await holdRows(env, [row.key]));
            return {};
          },
        },
        { contendedBrake: 2 },
      );
      expect(report.status).toBe(0);
      expect(report.drains[0]).toMatchObject({ handled: 3, acked: 1, contended: 2, jammed: 0 });
      expect(env.settles[0]?.failure).toBeUndefined();
    } finally {
      for (const h of holds) await h.done();
    }
  });

  test("a jam in one source stops the next: queue-jammed", async () => {
    const env = await fresh({ ackLockTimeoutMs: 200 });
    await env.put("alpha:1");
    await env.put("beta:1");
    let hold: Awaited<ReturnType<typeof holdRows>> | undefined;
    try {
      const report = await drain(
        env,
        {
          alpha: async () => {
            hold = await holdRows(env, ["alpha:1"]);
            return {};
          },
          beta: ok,
        },
        { contendedBrake: 1 },
      );
      expect(report.status).toBe(1);
      expect(report.drains.map((d) => d.source)).toEqual(["alpha"]);
      expect(env.settles[0]?.failure).toEqual({ kind: "jammed", leftClaimed: 1 });
    } finally {
      await hold?.done();
    }
    expect(env.events).toContainEqual({
      type: "drain.sources_stopped",
      source: "beta",
      reason: "queue-jammed",
    });
    expect(await env.row("beta:1")).toMatchObject({ claimed: false });
  });
});

describe("the consumer's hooks misbehave", () => {
  test("F25: archivedBefore answering NaN, -1 or 1.5 charges nothing", async () => {
    const env = await fresh();
    const answers = [Number.NaN, -1, 1.5];
    for (const [i] of answers.entries()) await env.put(`alpha:${i}`);
    let at = 0;
    const report = await drain(
      env,
      {
        alpha: async () => {
          throw new Error("boom");
        },
      },
      { maxArchivals: 1, archivedBefore: () => answers[at++] as number },
    );
    expect(at).toBe(3);
    expect(report.archived).toBe(0);
    expect(report.drains[0]?.archived).toBe(0);
    expect(types(env)).not.toContain("drain.archival_cap");
    expect(env.settles[0]?.failure?.kind).toBe("all-failed");
  });

  test("a throwing errorClassOf fails the row with class Error", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await drain(
      env,
      {
        alpha: async () => {
          throw new Archived(0);
        },
      },
      {
        errorClassOf: () => {
          throw new Error("no class");
        },
      },
    );
    expect(await env.row("alpha:1")).toMatchObject({ last_error: "Error", attempts: 1 });
  });

  test("a throwing isFatal aborts the drain", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    await env.put("alpha:2");
    const boom = new Error("boom");
    const report = await drain(
      env,
      {
        alpha: async () => {
          throw boom;
        },
      },
      {
        isFatal: () => {
          throw new Error("cannot tell");
        },
      },
    );
    expect(report.status).toBe(1);
    expect(report.drains[0]).toMatchObject({ handled: 1, failed: 2 });
    expect(env.settles[0]?.failure).toEqual({ kind: "fatal", error: boom });
    expect(await env.row("alpha:2")).toMatchObject({ last_error: "HeldAborted" });
  });

  test("a lock whose release rejects: the report still comes back, status 1, drain.release_failed", async () => {
    const env = await fresh();
    await env.put("alpha:1");
    const refused = new Error("release failed");
    const report = await drain(
      env,
      { alpha: ok },
      {
        acquire: async (src) => {
          const real = await takeLock(runnerLockSlice(env.sc), src.lockName);
          return {
            name: real.name,
            holder: real.holder,
            ensureExclusive: () => real.ensureExclusive(),
            startKeepalive: () => real.startKeepalive(),
            stopKeepalive: () => real.stopKeepalive(),
            release: async () => {
              await real.release();
              throw refused;
            },
          };
        },
      },
    );
    expect(report.status).toBe(1);
    expect(report.drains[0]).toMatchObject({ handled: 1, acked: 1 });
    expect(env.settles[0]?.failure).toBeUndefined();
    expect(env.events).toContainEqual({
      type: "drain.release_failed",
      source: "alpha",
      error: refused,
    });
  });
});
