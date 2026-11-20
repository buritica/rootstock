import { describe, expect, test } from "bun:test";
import { drainQueue } from "./drain.ts";
import { runnerErrorCode } from "./errors.ts";
import { defaultMismatchReason, defaultReason, messageOf, planPull, runPull } from "./pull.ts";
import type { PullFailure } from "./types.ts";

// The runner's pure parts (contract §2.5, §14): texts, and every refusal
// made before any I/O. The fakes throw if touched, so a refusal that reached
// the database or the source fails here.

const touched = (what: string) => () => {
  throw new Error(`touched ${what} before refusing`);
};
const tx = {
  id: "postgres-js",
  sql: Object.assign(touched("sql"), { unsafe: touched("sql.unsafe") }),
  begin: touched("begin"),
};
const lock = {
  ensureExclusive: touched("lock"),
  startKeepalive: touched("keepalive"),
  stopKeepalive: touched("keepalive"),
  release: touched("release"),
};
const source = {
  job: "alpha-sync",
  cursorOf: touched("cursorOf"),
  list: touched("list"),
  fetch: touched("source"),
  existing: touched("existing"),
  load: touched("load"),
};
const pullArgs = (over: Record<string, unknown> = {}) =>
  ({
    tx,
    runs: {},
    quarantine: {},
    cursors: {},
    source,
    mode: "incremental",
    lock,
    batchSize: 10,
    fetchConcurrency: 2,
    ...over,
  }) as never;
const deps = { runs: { now: () => 0, randomUUID: () => "x" } };

const code = async (p: Promise<unknown>): Promise<string | undefined> =>
  runnerErrorCode(
    await p.then(
      () => undefined,
      (e: unknown) => e,
    ),
  );

describe("texts", () => {
  test("messageOf: a non-empty message, else the string form, never a throw", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf(new Error(""))).toBe("Error");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(null)).toBe("null");
    const hostile = {
      get message(): string {
        throw new Error("no");
      },
      toString(): string {
        throw new Error("no");
      },
    };
    expect(messageOf(hostile)).toBe("unprintable error");
  });

  test("T1 mismatch text", () => {
    expect(defaultMismatchReason("a", "b")).toBe(
      "fetched a doc for a different externalId: asked for a, got b",
    );
    expect(defaultMismatchReason("a", undefined)).toEndWith("got undefined");
  });

  test("every failure kind's default text, describe threaded through", () => {
    const e = new Error("why");
    const cases: [PullFailure, string][] = [
      [
        { kind: "options", field: "batchSize", value: 0 },
        "rootstock runner: batchSize must be an integer in 1–10000, got 0",
      ],
      [
        { kind: "options", field: "fetchConcurrency", value: "x" },
        'rootstock runner: fetchConcurrency must be an integer in 1–64, got "x"',
      ],
      [{ kind: "list", error: e }, "rootstock runner: list failed: <why>"],
      [{ kind: "lost-lock", error: e }, "rootstock runner: lost the run lock: <why>"],
      [{ kind: "batch", error: e }, "rootstock runner: batch failed: <why>"],
      [
        { kind: "quota", count: 5, externalId: "q4" },
        "rootstock runner: 5 quota failures in a row; the run stopped after q4, committed through it",
      ],
      [
        { kind: "cursor", error: e },
        "rootstock runner: could not store the cursor on an empty listing: <why>",
      ],
      [{ kind: "threw", error: e }, "rootstock runner: run threw: <why>"],
      [{ kind: "before-settle", error: e }, "rootstock runner: beforeSettle failed: <why>"],
      [{ kind: "identity" }, "rootstock runner: the buckets do not balance"],
    ];
    for (const [f, text] of cases) {
      expect(defaultReason(f, (err) => `<${(err as Error).message}>`)).toBe(text);
    }
    // A throwing or non-string describe falls back to the message.
    expect(defaultReason({ kind: "list", error: e }, () => 7 as never)).toBe(
      "rootstock runner: list failed: why",
    );
    expect(
      defaultReason({ kind: "list", error: e }, () => {
        throw new Error("no");
      }),
    ).toBe("rootstock runner: list failed: why");
  });
});

describe("runPull refusals, before any I/O", () => {
  test.each([
    ["args", null],
    ["tx", pullArgs({ tx: {} })],
    ["lock", pullArgs({ lock: {} })],
    ["source", pullArgs({ source: null })],
    ["source.job", pullArgs({ source: { ...source, job: "" } })],
    ["source.fetch", pullArgs({ source: { ...source, fetch: 1 } })],
    ["source.planLoad", pullArgs({ source: { ...source, planLoad: 1 } })],
    ["since", pullArgs({ since: new Date(Number.NaN) })],
    ["mode", pullArgs({ mode: 3 })],
    ["describe", pullArgs({ describe: "x" })],
    ["reasonOf", pullArgs({ reasonOf: "x" })],
    ["beforeSettle", pullArgs({ beforeSettle: "x" })],
    ["quota", pullArgs({ quota: { make: () => 1 } })],
  ])("%s", async (_name, a) => {
    expect(await code(runPull(a as never, deps))).toBe("ERR_ROOTSTOCK_RUNNER_INPUT");
  });

  test("deps.runs", async () => {
    expect(await code(runPull(pullArgs(), {} as never))).toBe("ERR_ROOTSTOCK_RUNNER_INPUT");
  });

  test("a backfill window on a source that cannot bound it is BACKFILL", async () => {
    expect(await code(runPull(pullArgs({ since: new Date(0) }), deps))).toBe(
      "ERR_ROOTSTOCK_RUNNER_BACKFILL",
    );
  });

  test("the refusal text names the function and the field", async () => {
    const err = (await runPull(pullArgs({ mode: 3 }), deps).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("rootstock runner: runPull(): mode must be a string — got 3");
  });
});

describe("planPull refusals, before any I/O", () => {
  const planArgs = (over: Record<string, unknown> = {}) =>
    ({ tx, cursors: {}, source, batchSize: 10, fetchConcurrency: 2, ...over }) as never;
  test.each([
    ["batchSize 0", planArgs({ batchSize: 0 })],
    ["batchSize 10001", planArgs({ batchSize: 10_001 })],
    ["fetchConcurrency 65", planArgs({ fetchConcurrency: 65 })],
    ["maxRefs 0", planArgs({ maxRefs: 0 })],
    ["maxRefs 1.5", planArgs({ maxRefs: 1.5 })],
    ["lock", planArgs({ lock: {} })],
  ])("%s", async (_name, a) => {
    expect(await code(planPull(a))).toBe("ERR_ROOTSTOCK_RUNNER_INPUT");
  });
});

describe("drainQueue refusals, before any I/O", () => {
  const drainArgs = (over: Record<string, unknown> = {}) =>
    ({
      tx,
      queue: { maxClaimLimit: 10 },
      sources: [{ source: "src-a", lockName: "alpha-sync", handle: touched("handle") }],
      worker: "worker-a",
      limit: 500,
      maxArchivals: 5,
      minRowsForAllFailed: 2,
      contendedBrake: 3,
      acquire: touched("acquire"),
      isHeld: () => false,
      isFatal: () => false,
      errorClassOf: () => "E",
      heldClass: { capped: "a", interrupted: "b", aborted: "c" },
      interrupted: () => false,
      record: { start: touched("start"), settle: touched("settle") },
      ...over,
    }) as never;
  test.each([
    ["limit 0", drainArgs({ limit: 0 })],
    ["limit 1.5", drainArgs({ limit: 1.5 })],
    ["maxArchivals 0", drainArgs({ maxArchivals: 0 })],
    ["contendedBrake 1000001", drainArgs({ contendedBrake: 1_000_001 })],
    ["minRowsForAllFailed NaN", drainArgs({ minRowsForAllFailed: Number.NaN })],
    ["worker", drainArgs({ worker: "" })],
    ["heldClass", drainArgs({ heldClass: { capped: "a", interrupted: "", aborted: "c" } })],
    ["record", drainArgs({ record: {} })],
    ["sources", drainArgs({ sources: [{ source: "src-a" }] })],
  ])("%s", async (_name, a) => {
    expect(await code(drainQueue(a))).toBe("ERR_ROOTSTOCK_RUNNER_INPUT");
  });

  test("a limit above maxClaimLimit is accepted (claim clamps it)", async () => {
    // The first I/O is acquire, so passing the checks reaches it.
    const err = (await drainQueue(drainArgs()).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("touched acquire before refusing");
  });
});
