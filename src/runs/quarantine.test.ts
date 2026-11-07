import { describe, expect, test } from "bun:test";
import type { Sql } from "../db/index.ts";
import { RootstockRunsError } from "./errors.ts";
import type { RunsEvent } from "./events.ts";
import {
  pendingQuarantine,
  type QuarantineTable,
  type QuarantineTableInput,
  quarantine,
  quarantineSafe,
  quarantineStatements,
  quarantineTable,
  resolveQuarantine,
} from "./quarantine.ts";

const MIN = { maxPayloadBytes: 1_024, maxReasonChars: 16 };
const T = quarantineTable(MIN);

function refusal(input: unknown): string {
  try {
    quarantineTable(input as QuarantineTableInput);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("quarantineTable: the parser (§4.1)", () => {
  test("defaults: rootstock.quarantine, rootstock's column names, frozen", () => {
    expect(T.table).toEqual({ schema: "rootstock", name: "quarantine" });
    expect(T.columns).toEqual({
      job: "job",
      externalId: "external_id",
      payload: "payload",
      reason: "reason",
      status: "status",
      failedAt: "failed_at",
      resolvedAt: "resolved_at",
      runId: "run_id",
    });
    expect(T.maxPayloadBytes).toBe(1_024);
    expect(T.maxReasonChars).toBe(16);
    expect(Object.isFrozen(T)).toBe(true);
    expect(Object.isFrozen(T.table)).toBe(true);
    expect(Object.isFrozen(T.columns)).toBe(true);
  });

  test("the default schema comes from defaults; a given table wins", () => {
    expect(quarantineTable(MIN, { schema: "rs_x" }).table).toEqual({
      schema: "rs_x",
      name: "quarantine",
    });
    expect(
      quarantineTable({ ...MIN, table: { schema: "app", name: "failed" } }, { schema: "rs_x" })
        .table,
    ).toEqual({ schema: "app", name: "failed" });
  });

  test("a column map, with runId: null for a table without a run column", () => {
    const t = quarantineTable({ ...MIN, columns: { job: "adapter_id", runId: null } });
    expect(t.columns.job).toBe("adapter_id");
    expect(t.columns.runId).toBeNull();
    expect(t.columns.externalId).toBe("external_id");
    const all = quarantineTable({
      ...MIN,
      columns: {
        job: "a",
        externalId: "b",
        payload: "c",
        reason: "d",
        status: "e",
        failedAt: "f",
        resolvedAt: "g",
        runId: "h",
      },
    });
    expect(Object.values(all.columns)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  test("every bound, both edges", () => {
    for (const [key, lo, hi] of [
      ["maxPayloadBytes", 1_024, 16_777_216],
      ["maxReasonChars", 16, 10_000],
    ] as const) {
      expect(quarantineTable({ ...MIN, [key]: lo })[key]).toBe(lo);
      expect(quarantineTable({ ...MIN, [key]: hi })[key]).toBe(hi);
      for (const bad of [lo - 1, hi + 1, lo + 0.5, String(lo), Number.NaN]) {
        expect(refusal({ ...MIN, [key]: bad })).toBe(
          `quarantineTable: ${key} must be an integer from ${lo} to ${hi} — got ${
            typeof bad === "number" && Number.isNaN(bad) ? "NaN" : JSON.stringify(bad)
          }`,
        );
      }
    }
  });

  test("both caps are required", () => {
    expect(refusal({ maxReasonChars: 16 })).toBe("quarantineTable: maxPayloadBytes is required");
    expect(refusal({ maxPayloadBytes: 1_024 })).toBe("quarantineTable: maxReasonChars is required");
  });

  test("unknown keys refuse, at every level, without echoing the value", () => {
    expect(refusal({ ...MIN, secret: "postgres://x" })).toBe(
      "quarantineTable: secret is not a known key",
    );
    expect(refusal({ ...MIN, columns: { jobs: "x" } })).toBe(
      "quarantineTable: columns.jobs is not a known key",
    );
    expect(refusal({ ...MIN, table: { db: "x" } })).toBe(
      "quarantineTable: table.db is not a known key",
    );
  });

  test("a column or table name that is not an identifier refuses", () => {
    const e = "an identifier matching [a-z_][a-z0-9_]* of at most 63 bytes";
    expect(refusal({ ...MIN, columns: { job: "Job" } })).toBe(
      `quarantineTable: columns.job must be ${e} — got "Job"`,
    );
    expect(refusal({ ...MIN, columns: { externalId: null } })).toBe(
      `quarantineTable: columns.externalId must be ${e} — got null`,
    );
    expect(refusal({ ...MIN, columns: { runId: "a".repeat(64) } })).toBe(
      `quarantineTable: columns.runId must be ${e} — got "${"a".repeat(64)}"`,
    );
    expect(refusal({ ...MIN, table: { name: 'q"x' } })).toBe(
      `quarantineTable: table.name must be ${e} — got "q\\"x"`,
    );
    expect(refusal({ ...MIN, columns: "job" })).toBe(
      'quarantineTable: columns must be an object — got "job"',
    );
  });

  test("the brand: a hand-built copy of the right shape is refused by every call", async () => {
    const fake = { ...T, table: { ...T.table }, columns: { ...T.columns } } as QuarantineTable;
    const a = { job: "alpha-sync", externalId: "x", payload: {}, reason: "r" };
    const want = (fn: string) =>
      `${fn}: expected a QuarantineTable built by quarantineTable() — got an object that parser did not return`;
    await expect(quarantine(noSql, fake, a)).rejects.toThrow(want("quarantine"));
    await expect(quarantineSafe(noSql, fake, a)).rejects.toThrow(want("quarantineSafe"));
    await expect(
      resolveQuarantine(noSql, fake, { job: "alpha-sync", externalIds: [] }),
    ).rejects.toThrow(want("resolveQuarantine"));
    await expect(pendingQuarantine(noSql, fake, { job: "alpha-sync" })).rejects.toThrow(
      want("pendingQuarantine"),
    );
  });
});

/** Any statement sent is a test failure. */
const noSql = Object.assign(
  async () => {
    throw new Error("no query expected");
  },
  {
    unsafe: async () => {
      throw new Error("no query expected");
    },
  },
) as unknown as Sql;

type Call = { text: string; params: readonly unknown[] };

/** A fake `Sql` that records each statement and answers with `answer(call, index)`. */
function recording(answer: (c: Call, i: number) => unknown[] = () => []) {
  const calls: Call[] = [];
  const sql = {
    unsafe: async (text: string, params: readonly unknown[] = []) => {
      const c = { text, params };
      calls.push(c);
      return answer(c, calls.length - 1);
    },
  } as unknown as Sql;
  return { sql, calls };
}

function events() {
  const seen: RunsEvent[] = [];
  return { seen, deps: { onEvent: (e: RunsEvent) => seen.push(e) } };
}

const pgError = (code: string) => Object.assign(new Error(`server ${code}`), { code });

async function caught(p: Promise<unknown>): Promise<RootstockRunsError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RootstockRunsError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

const PUT = { job: "alpha-sync", externalId: "rec-1", payload: { a: 1 }, reason: "bad row" };

describe("quarantine: INPUT before any query (QD6's unit half)", () => {
  test("a payload over maxPayloadBytes (in UTF-8 bytes) refuses INPUT and sends nothing", async () => {
    // 1 017 two-byte characters plus the quotes: 2 036 bytes but 1 019 UTF-16 units.
    const err = await caught(quarantine(noSql, T, { ...PUT, payload: "é".repeat(1_017) }));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    expect(err.job).toBe("alpha-sync");
    expect(err.message).toBe(
      'rootstock runs: quarantine("rec-1"): payload is 2036 bytes, over the 1024 cap',
    );
  });

  test("a payload of exactly maxPayloadBytes is sent", async () => {
    const r = recording();
    await quarantine(r.sql, T, { ...PUT, payload: "x".repeat(1_022) });
    expect(r.calls).toHaveLength(1);
    expect(String(r.calls[0]?.params[2]).length).toBe(1_024);
  });

  for (const [name, payload] of [
    ["a BigInt", 1n],
    [
      "a cycle",
      (() => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      })(),
    ],
    ["undefined", undefined],
    ["a function", () => 1],
  ] as const) {
    test(`${name} payload refuses INPUT and sends nothing`, async () => {
      const err = await caught(quarantine(noSql, T, { ...PUT, payload }));
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
      expect(err.message).toBe(
        'rootstock runs: quarantine("rec-1"): payload must serialize to JSON',
      );
    });
  }

  test("a non-string job, externalId or reason, or a non-string runId, refuses INPUT", async () => {
    for (const [field, value] of [
      ["job", 7],
      ["externalId", null],
      ["reason", undefined],
      ["runId", 42],
    ] as const) {
      const err = await caught(quarantine(noSql, T, { ...PUT, [field]: value } as never));
      expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
      expect(err.detail).toStartWith(`quarantine(): ${field} must be a string`);
    }
  });

  test("the reason is cut to maxReasonChars, never through a surrogate pair", async () => {
    const r = recording();
    await quarantine(r.sql, T, { ...PUT, reason: "r".repeat(40) });
    expect(r.calls[0]?.params[3]).toBe("r".repeat(16));
    await quarantine(r.sql, T, { ...PUT, reason: `${"r".repeat(15)}😀tail` });
    expect(r.calls[1]?.params[3]).toBe("r".repeat(15));
    await quarantine(r.sql, T, { ...PUT, reason: `${"r".repeat(14)}😀tail` });
    expect(r.calls[2]?.params[3]).toBe(`${"r".repeat(14)}😀`);
  });
});

describe("quarantine: statements, params and events", () => {
  test("QU1 with a run column: five params, runId null when not given", async () => {
    const r = recording();
    const e = events();
    await quarantine(r.sql, T, PUT, e.deps);
    await quarantine(r.sql, T, { ...PUT, runId: "0f0e0d0c-0b0a-4908-8706-050403020100" }, e.deps);
    const st = quarantineStatements(T);
    expect(r.calls.map((c) => c.text)).toEqual([st.put, st.put]);
    expect(r.calls[0]?.params).toEqual(["alpha-sync", "rec-1", '{"a":1}', "bad row", null]);
    expect(r.calls[1]?.params[4]).toBe("0f0e0d0c-0b0a-4908-8706-050403020100");
    expect(e.seen).toEqual([
      { type: "runs.quarantined", job: "alpha-sync", externalId: "rec-1", runId: null },
      {
        type: "runs.quarantined",
        job: "alpha-sync",
        externalId: "rec-1",
        runId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      },
    ]);
  });

  test("QU1′ without a run column: four params", async () => {
    const t = quarantineTable({ ...MIN, columns: { job: "adapter_id", runId: null } });
    const r = recording();
    await quarantine(r.sql, t, { ...PUT, runId: "0f0e0d0c-0b0a-4908-8706-050403020100" });
    expect(r.calls[0]?.text).toBe(quarantineStatements(t).put);
    expect(r.calls[0]?.params).toEqual(["alpha-sync", "rec-1", '{"a":1}', "bad row"]);
  });

  test("a rejection propagates and emits nothing; 42P01 refuses NOTABLE naming the table", async () => {
    const e = events();
    const boom = pgError("23514");
    const failing = recording(() => {
      throw boom;
    });
    await expect(quarantine(failing.sql, T, PUT, e.deps)).rejects.toBe(boom);
    const missing = recording(() => {
      throw pgError("42P01");
    });
    const t = quarantineTable({ ...MIN, table: { schema: "app", name: "failed_records" } });
    const err = await caught(quarantine(missing.sql, t, PUT, e.deps));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
    expect(err.message).toBe(
      "rootstock runs: app.failed_records does not exist — run the migrations (the table ships with rootstock 0.8.0, or is your own)",
    );
    expect(e.seen).toEqual([]);
  });

  test("quarantineSafe: lands first time → true, one statement", async () => {
    const r = recording();
    expect(await quarantineSafe(r.sql, T, PUT)).toBe(true);
    expect(r.calls).toHaveLength(1);
  });

  test("quarantineSafe: a failed first put retries once with the minimal payload", async () => {
    const r = recording((_, i) => {
      if (i === 0) throw pgError("23514");
      return [];
    });
    const e = events();
    expect(await quarantineSafe(r.sql, T, { ...PUT, runId: null }, e.deps)).toBe(true);
    expect(r.calls.map((c) => c.params[2])).toEqual([
      '{"a":1}',
      '{"externalId":"rec-1","truncated":true}',
    ]);
    expect(e.seen).toEqual([
      { type: "runs.quarantined", job: "alpha-sync", externalId: "rec-1", runId: null },
    ]);
  });

  test("quarantineSafe: a payload refused INPUT goes straight to the minimal one", async () => {
    const r = recording();
    expect(await quarantineSafe(r.sql, T, { ...PUT, payload: 1n })).toBe(true);
    expect(r.calls.map((c) => c.params[2])).toEqual(['{"externalId":"rec-1","truncated":true}']);
  });

  test("quarantineSafe: both fail → false, record_failed carries the second error", async () => {
    const second = pgError("23514");
    const r = recording((_, i) => {
      throw i === 0 ? pgError("22P05") : second;
    });
    const e = events();
    expect(await quarantineSafe(r.sql, T, PUT, e.deps)).toBe(false);
    expect(r.calls).toHaveLength(2);
    expect(e.seen).toEqual([
      {
        type: "runs.record_failed",
        operation: "quarantine",
        job: "alpha-sync",
        error: second,
        code: "23514",
      },
    ]);
  });

  test("quarantineSafe: 42P01 refuses NOTABLE at once, without a retry", async () => {
    const r = recording(() => {
      throw pgError("42P01");
    });
    const e = events();
    const err = await caught(quarantineSafe(r.sql, T, PUT, e.deps));
    expect(err.code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
    expect(r.calls).toHaveLength(1);
    expect(e.seen).toEqual([]);
  });

  test("resolveQuarantine: an empty list is 0 without a query", async () => {
    const e = events();
    expect(await resolveQuarantine(noSql, T, { job: "alpha-sync", externalIds: [] }, e.deps)).toBe(
      0,
    );
    expect(e.seen).toEqual([]);
  });

  test("resolveQuarantine: QU2, the count, and runs.resolved only when count > 0", async () => {
    let n = "2";
    const r = recording(() => [{ n }]);
    const e = events();
    const a = { job: "alpha-sync", externalIds: ["rec-1", "rec-2"] };
    expect(await resolveQuarantine(r.sql, T, a, e.deps)).toBe(2);
    n = "0";
    expect(await resolveQuarantine(r.sql, T, a, e.deps)).toBe(0);
    expect(r.calls[0]).toEqual({
      text: quarantineStatements(T).resolve,
      params: ["alpha-sync", '["rec-1","rec-2"]'],
    });
    expect(e.seen).toEqual([{ type: "runs.resolved", job: "alpha-sync", count: 2 }]);
  });

  test("resolveQuarantine and pendingQuarantine refuse ids that are not strings", async () => {
    for (const p of [
      resolveQuarantine(noSql, T, { job: "alpha-sync", externalIds: [1] as never }),
      pendingQuarantine(noSql, T, { job: "alpha-sync", externalIds: "rec-1" as never }),
    ]) {
      expect((await caught(p)).code).toBe("ERR_ROOTSTOCK_RUNS_INPUT");
    }
  });

  test("pendingQuarantine: QU3 with null or the id list, rows mapped", async () => {
    const r = recording(() => [
      { external_id: "rec-1", reason: "bad row", failed_at_ms: "1700000000123" },
    ]);
    const rows = await pendingQuarantine(r.sql, T, { job: "alpha-sync" });
    expect(rows).toEqual([
      { externalId: "rec-1", reason: "bad row", failedAt: new Date(1_700_000_000_123) },
    ]);
    await pendingQuarantine(r.sql, T, { job: "alpha-sync", externalIds: ["rec-1"] });
    expect(r.calls.map((c) => c.params)).toEqual([
      ["alpha-sync", null],
      ["alpha-sync", '["rec-1"]'],
    ]);
    expect(r.calls[0]?.text).toBe(quarantineStatements(T).pending);
  });

  test("42P01 from resolve and pending refuses NOTABLE", async () => {
    const r = recording(() => {
      throw pgError("42P01");
    });
    for (const p of [
      resolveQuarantine(r.sql, T, { job: "alpha-sync", externalIds: ["x"] }),
      pendingQuarantine(r.sql, T, { job: "alpha-sync" }),
    ]) {
      expect((await caught(p)).code).toBe("ERR_ROOTSTOCK_RUNS_NOTABLE");
    }
  });
});

describe("quarantine statements: hygiene", () => {
  const custom = quarantineTable({
    ...MIN,
    table: { schema: "rs_a", name: "qq" },
    columns: {
      job: "c_job",
      externalId: "c_ext",
      payload: "c_payload",
      reason: "c_reason",
      status: "c_status",
      failedAt: "c_failed",
      resolvedAt: "c_resolved",
      runId: "c_run",
    },
  });
  const noRun = quarantineTable({
    ...MIN,
    table: { schema: "rs_a", name: "qq" },
    columns: { job: "c_job", runId: null },
  });
  const c = quarantineStatements(custom);
  const n = quarantineStatements(noRun);
  const ALL: [string, string, number][] = [
    ["QU1", c.put, 5],
    ["QU1′", n.put, 4],
    ["QU2", c.resolve, 2],
    ["QU3", c.pending, 2],
  ];
  for (const [id, text, params] of ALL) {
    test(`${id}: placeholders 1..${params} only, each referenced, no comment`, () => {
      const used = new Set<number>();
      const stripped = text.replace(/\$([1-9][0-9]*)/g, (m, k: string) => {
        const i = Number(k);
        if (i > params) return m;
        used.add(i);
        return "";
      });
      expect(stripped).not.toMatch(/\$\d/);
      expect([...used].sort((a, b) => a - b)).toEqual(
        Array.from({ length: params }, (_, i) => i + 1),
      );
      expect(text).not.toContain("--");
    });
    test(`${id}: the table and every column appear only quoted`, () => {
      expect(text).toContain('"rs_a"."qq"');
      const rest = text.replaceAll('"rs_a"."qq"', "").replace(/"c_[a-z]+"/g, "");
      expect(rest).not.toMatch(/\brs_a\b|\bqq\b|\bc_[a-z]+\b/);
    });
  }
  test("QU1′ names no run column; the statements are frozen", () => {
    expect(n.put).not.toContain("run_id");
    expect(n.putTakesRunId).toBe(false);
    expect(c.putTakesRunId).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
  });
});

/** Contract §4.3, verbatim: copy it from the contract, never from quarantine.ts. */
const QU1 = `INSERT INTO <Q> (<q.job>, <q.externalId>, <q.payload>, <q.reason>, <q.status>, <q.failedAt>, <q.resolvedAt>, <q.runId>)
VALUES ($1::text, $2::text, $3::text::jsonb, $4::text, 'pending', clock_timestamp(), NULL, $5::uuid)
ON CONFLICT (<q.job>, <q.externalId>) DO UPDATE SET
  <q.payload> = excluded.<q.payload>, <q.reason> = excluded.<q.reason>,
  <q.status> = 'pending', <q.failedAt> = excluded.<q.failedAt>, <q.resolvedAt> = NULL,
  <q.runId> = excluded.<q.runId>`;
const QU2 = `WITH r AS (
  UPDATE <Q> SET <q.status> = 'resolved', <q.resolvedAt> = clock_timestamp()
  WHERE <q.job> = $1::text AND <q.status> = 'pending'
    AND <q.externalId> IN (SELECT jsonb_array_elements_text($2::text::jsonb))
  RETURNING 1
)
SELECT count(*)::text AS n FROM r`;
const QU3 = `SELECT <q.externalId> AS external_id, <q.reason> AS reason,
       floor(extract(epoch FROM <q.failedAt>) * 1000)::text AS failed_at_ms
FROM <Q>
WHERE <q.job> = $1::text AND <q.status> = 'pending'
  AND ($2::text IS NULL OR <q.externalId> IN (SELECT jsonb_array_elements_text($2::text::jsonb)))
ORDER BY <q.failedAt>, <q.externalId>`;
/** QU1′: QU1 without the run column, its value and its assignment. */
const QU1_PRIME = QU1.replace(", <q.runId>)", ")")
  .replace(", $5::uuid)", ")")
  .replace(",\n  <q.runId> = excluded.<q.runId>", "");

function fill(text: string, t: QuarantineTable): string {
  const c = t.columns;
  return text
    .replaceAll("<Q>", `"${t.table.schema}"."${t.table.name}"`)
    .replaceAll("<q.job>", `"${c.job}"`)
    .replaceAll("<q.externalId>", `"${c.externalId}"`)
    .replaceAll("<q.payload>", `"${c.payload}"`)
    .replaceAll("<q.reason>", `"${c.reason}"`)
    .replaceAll("<q.status>", `"${c.status}"`)
    .replaceAll("<q.failedAt>", `"${c.failedAt}"`)
    .replaceAll("<q.resolvedAt>", `"${c.resolvedAt}"`)
    .replaceAll("<q.runId>", `"${c.runId}"`);
}

describe("quarantine statements: §4.3's text, byte for byte", () => {
  const origin = quarantineTable({ ...MIN, columns: { job: "adapter_id", runId: null } });
  const st = quarantineStatements(T);
  test("QU1", () => expect(st.put).toBe(fill(QU1, T)));
  test("QU1′", () => {
    expect(QU1_PRIME).not.toContain("runId");
    expect(quarantineStatements(origin).put).toBe(fill(QU1_PRIME, origin));
  });
  test("QU2", () => expect(st.resolve).toBe(fill(QU2, T)));
  test("QU3", () => expect(st.pending).toBe(fill(QU3, T)));
});
