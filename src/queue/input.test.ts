import { describe, expect, test } from "bun:test";
import type { Sql, Transactor } from "../db/index.ts";
import { getCursor, setCursor, touchCursor } from "./cursors.ts";
import { RootstockQueueError } from "./errors.ts";
import type { QueueEvent } from "./events.ts";
import { QUEUE_INPUT } from "./fixtures.test-support.ts";
import { claim, enqueue, fail } from "./queue.ts";
import { cursorTable, queueSlice } from "./slice.ts";

const S = queueSlice(QUEUE_INPUT);

/** Any statement sent is a test failure: validation is all before I/O. */
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
const noScope = {
  id: "postgres-js",
  sql: noSql,
  begin: async () => {
    throw new Error("no transaction expected");
  },
} as unknown as Transactor;

interface Refused {
  err: RootstockQueueError;
  events: QueueEvent[];
}

async function refused(
  run: (onEvent: (e: QueueEvent) => void) => Promise<unknown>,
): Promise<Refused> {
  const events: QueueEvent[] = [];
  try {
    await run((e) => events.push(e));
  } catch (err) {
    if (err instanceof RootstockQueueError) return { err, events };
    throw err;
  }
  throw new Error("expected a refusal");
}

const base = { key: "alpha:1", source: "alpha", kind: "put", payload: {}, debounceSeconds: 0 };
const enq = (over: Record<string, unknown>) => (onEvent: (e: QueueEvent) => void) =>
  enqueue(noScope, S, { ...base, ...over } as never, { onEvent });

describe("QI1: every reason, its text and its event", () => {
  const cases: [string, Record<string, unknown>, string, string, Record<string, unknown>][] = [
    [
      "key_invalid",
      { key: "" },
      "key_invalid",
      "key must be a non-empty string",
      { key: null, source: null },
    ],
    [
      "key_invalid",
      { key: 7 },
      "key_invalid",
      "key must be a non-empty string",
      { key: null, source: null },
    ],
    [
      "key_invalid",
      { key: `alpha:${"x".repeat(507)}` },
      "key_invalid",
      "key is 513 characters, over the 512 cap",
      { key: null, source: null, size: 513 },
    ],
    [
      "key_invalid",
      { key: "alpha:\0" },
      "key_invalid",
      "key contains a NUL byte",
      { key: null, source: null },
    ],
    [
      "source_unknown",
      { source: "gamma" },
      "source_unknown",
      '"gamma" is not a queue source',
      { key: "alpha:1", source: null },
    ],
    [
      "kind_unknown",
      { kind: "move" },
      "kind_unknown",
      '"move" is not a queue kind',
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "key_source_mismatch",
      { key: "beta:1" },
      "key_source_mismatch",
      'key "beta:1" does not start with its source (alpha:)',
      { key: "beta:1", source: "alpha" },
    ],
    [
      "debounce_not_finite",
      { debounceSeconds: Number.NaN },
      "debounce_not_finite",
      "debounceSeconds for alpha:1 is not a finite number",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "max_slide_not_finite",
      { maxSlideSeconds: Number.POSITIVE_INFINITY },
      "max_slide_not_finite",
      "maxSlideSeconds for alpha:1 is not a finite number",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_not_an_object",
      { payload: [1] },
      "payload_not_an_object",
      "payload for alpha:1 must be an object, not a array",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_not_an_object",
      { payload: "x" },
      "payload_not_an_object",
      "payload for alpha:1 must be an object, not a string",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_non_finite",
      { payload: { a: { b: Number.NaN } } },
      "payload_non_finite",
      "payload for alpha:1 holds a non-finite number at depth 2",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_non_plain",
      { payload: { a: new Map() } },
      "payload_non_plain",
      "payload for alpha:1 holds a non-plain object at depth 1",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_nul_key",
      { payload: { "a\0": 1 } },
      "payload_nul_key",
      "payload for alpha:1 has a NUL byte in a key at depth 0",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_bad_type",
      { payload: { a: 1n } },
      "payload_bad_type",
      "payload for alpha:1 holds a bigint at depth 1",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_bad_type",
      { payload: { a: () => 1 } },
      "payload_bad_type",
      "payload for alpha:1 holds a function at depth 1",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_bad_type",
      { payload: { a: ["ok", "x\ud800"] } },
      "payload_bad_type",
      "payload for alpha:1 holds a string with a lone surrogate at depth 2",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_bad_type",
      { payload: { a: { "\udc00k": 1 } } },
      "payload_bad_type",
      "payload for alpha:1 has a lone surrogate in a key at depth 1",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_non_finite",
      { payload: { at: new Date(Number.NaN) } },
      "payload_non_finite",
      "payload for alpha:1 holds an invalid Date at depth 1",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "payload_not_an_object",
      { payload: new Date(0) },
      "payload_not_an_object",
      "payload for alpha:1 must be an object, not a Date",
      { key: "alpha:1", source: "alpha" },
    ],
    [
      "key_invalid",
      { key: "alpha:\ud83d" },
      "key_invalid",
      "key contains a lone UTF-16 surrogate",
      { key: null, source: null },
    ],
  ];
  for (const [label, over, reason, detail, fields] of cases) {
    test(`${label}: ${detail}`, async () => {
      const { err, events } = await refused(enq(over));
      expect(err.code).toBe("ERR_ROOTSTOCK_QUEUE_INPUT");
      expect(err.reason).toBe(reason as never);
      expect(err.detail).toBe(detail);
      expect(err.message).toBe(`rootstock queue: ${detail}`);
      expect(err.name).toBe("RootstockQueueError");
      expect(events).toEqual([{ type: "queue.refused", ...fields, reason } as QueueEvent]);
    });
  }

  test("payload_cyclic", async () => {
    const a: Record<string, unknown> = {};
    a.self = { back: a };
    const { err } = await refused(enq({ payload: a }));
    expect(err.reason).toBe("payload_cyclic");
    expect(err.detail).toBe("payload for alpha:1 is cyclic at depth 2");
  });

  test("the enqueue order: a bad key and a bad source refuse key_invalid", async () => {
    expect((await refused(enq({ key: "", source: "gamma" }))).err.reason).toBe("key_invalid");
    expect((await refused(enq({ source: "gamma", kind: "move" }))).err.reason).toBe(
      "source_unknown",
    );
    expect((await refused(enq({ key: "beta:1", debounceSeconds: Number.NaN }))).err.reason).toBe(
      "key_source_mismatch",
    );
    expect((await refused(enq({ debounceSeconds: Number.NaN, payload: [1] }))).err.reason).toBe(
      "debounce_not_finite",
    );
    expect((await refused(enq({ payload: [1], maxSlideSeconds: Number.NaN }))).err.reason).toBe(
      "payload_not_an_object",
    );
  });

  test("worker_invalid on claim, error_class_invalid on fail", async () => {
    const c = await refused((onEvent) =>
      claim(noSql, S, { source: "alpha", limit: 1, worker: "w".repeat(129) }, { onEvent }),
    );
    expect(c.err.reason).toBe("worker_invalid");
    expect(c.err.detail).toBe("worker is 129 characters, over the 128 cap");
    expect(c.events).toEqual([
      { type: "queue.refused", key: null, source: "alpha", reason: "worker_invalid", size: 129 },
    ]);
    const f = await refused((onEvent) =>
      fail(noSql, S, { key: "alpha:1", worker: "w", errorClass: "" }, { onEvent }),
    );
    expect(f.err.reason).toBe("error_class_invalid");
    expect(f.err.detail).toBe("error class must be a non-empty string");
    expect(f.events).toEqual([
      { type: "queue.refused", key: "alpha:1", source: null, reason: "error_class_invalid" },
    ]);
  });

  test("an unbranded slice is refused by name", async () => {
    await expect(enqueue(noScope, { ...S } as never, base)).rejects.toThrow(
      "enqueue: expected a QueueSlice built by queueSlice() — got an object that parser did not return",
    );
  });
});

describe("QI2: the payload walk", () => {
  /** The JSON the upsert would bind, captured from a scope that records it. */
  async function stored(payload: unknown): Promise<unknown> {
    let json: unknown;
    const tx = {
      unsafe: async (_q: string, p?: readonly unknown[]) => {
        if (p !== undefined && p.length === 7) json = p[3];
        return [{ v: "0", inserted: true, on_dead: false }];
      },
    };
    const scope = { begin: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as Transactor;
    await enqueue(scope, S, { ...base, payload });
    return JSON.parse(json as string);
  }

  test("a shared sub-object passes, a Date becomes ISO, NUL leaves strings, nested nullish is null", async () => {
    const shared = { n: 1 };
    expect(
      await stored({
        a: shared,
        b: shared,
        at: new Date(0),
        s: "a\0b",
        list: [1, "x\0", null, undefined],
        none: undefined,
        flag: false,
        bare: Object.create(null),
      }),
    ).toEqual({
      a: { n: 1 },
      b: { n: 1 },
      at: "1970-01-01T00:00:00.000Z",
      s: "ab",
      list: [1, "x", null, null],
      none: null,
      flag: false,
      bare: {},
    });
    expect(await stored(null)).toEqual({});
    expect(await stored(undefined)).toEqual({});
  });

  test("a 65,537-byte payload refuses with size", async () => {
    // {"x":"…"} is 8 bytes of frame; a two-byte character proves bytes, not characters.
    const payload = { x: `é${"a".repeat(65_537 - 8 - 2)}` };
    const { err, events } = await refused(enq({ payload }));
    expect(err.reason).toBe("payload_too_large");
    expect(err.detail).toBe(
      "payload for alpha:1 is 65537 bytes, over the 65536 cap — a queue row points at work, it does not carry the source",
    );
    expect(events).toEqual([
      {
        type: "queue.refused",
        key: "alpha:1",
        source: "alpha",
        reason: "payload_too_large",
        size: 65537,
      },
    ]);
    const ok = { x: `é${"a".repeat(65_536 - 8 - 2)}` };
    expect(await stored(ok)).toEqual(ok);
  });
});

describe("QI1: cursor reasons", () => {
  const jsonT = cursorTable({ value: "jsonb", maxNameChars: 8, maxValueChars: 10 });
  const textT = cursorTable({
    table: { name: "text_cursors" },
    value: "text",
    maxNameChars: 8,
    maxValueChars: 10,
  });

  test("cursor_name_invalid in all three functions", async () => {
    for (const run of [
      (onEvent: (e: QueueEvent) => void) => getCursor(noSql, jsonT, "n".repeat(9), { onEvent }),
      (onEvent: (e: QueueEvent) => void) => setCursor(noSql, jsonT, "", 1, { onEvent }),
    ]) {
      const { err, events } = await refused(run);
      expect(err.reason).toBe("cursor_name_invalid");
      expect(events[0]).toMatchObject({ type: "queue.refused", key: null, source: null });
    }
    await expect(touchCursor(noSql, jsonT, "a\0", 1)).rejects.toThrow(
      "rootstock queue: cursor name contains a NUL byte",
    );
  });

  test("cursor_value_invalid: text table, jsonb kinds, and the length cap", async () => {
    const t = await refused((onEvent) => setCursor(noSql, textT, "n", 5, { onEvent }));
    expect(t.err.detail).toBe("cursor value must be a non-empty string");
    for (const bad of [undefined, () => 1, Symbol("s"), 1n, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { err } = await refused((onEvent) => setCursor(noSql, jsonT, "n", bad, { onEvent }));
      expect(err.reason).toBe("cursor_value_invalid");
      expect(err.detail).toBe("cursor value must be a JSON value");
    }
    const long = await refused((onEvent) =>
      setCursor(noSql, jsonT, "n", "abcdefghij", { onEvent }),
    );
    expect(long.err.detail).toBe("cursor value is 12 characters, over the 10 cap");
    expect(long.events).toEqual([
      { type: "queue.refused", key: null, source: null, reason: "cursor_value_invalid", size: 12 },
    ]);
    await expect(touchCursor(noSql, textT, "n", "x".repeat(11))).rejects.toThrow(
      "rootstock queue: cursor value is 11 characters, over the 10 cap",
    );
  });

  test("cursor_value_invalid: a jsonb value JSON or the server would alter or reject", async () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    for (const bad of [
      "a\0b",
      { s: "a\0" },
      { n: Number.NaN },
      [Number.NEGATIVE_INFINITY],
      { f: () => 1 },
      { u: undefined },
      sparse,
      { m: new Map() },
      { d: new Date(Number.NaN) },
      "x\udfff",
      { "\ud800": 1 },
    ]) {
      const { err, events } = await refused((onEvent) =>
        setCursor(noSql, jsonT, "n", bad, { onEvent }),
      );
      expect(err.reason).toBe("cursor_value_invalid");
      expect(err.detail).toBe("cursor value must be a JSON value");
      expect(events).toEqual([
        { type: "queue.refused", key: null, source: null, reason: "cursor_value_invalid" },
      ]);
    }
    await expect(touchCursor(noSql, jsonT, "n", { n: Number.NaN })).rejects.toThrow(
      "rootstock queue: cursor value must be a JSON value",
    );
  });

  test("a text cursor value or a name with a lone surrogate refuses", async () => {
    const v = await refused((onEvent) => setCursor(noSql, textT, "n", "\ud800", { onEvent }));
    expect(v.err.reason).toBe("cursor_value_invalid");
    expect(v.err.detail).toBe("cursor value contains a lone UTF-16 surrogate");
    const n = await refused((onEvent) => getCursor(noSql, jsonT, "\udc00", { onEvent }));
    expect(n.err.reason).toBe("cursor_name_invalid");
  });
});

describe("boolean columns a driver hands back as text", () => {
  test('"t" reads true for on_dead and dead, on enqueue, claim and fail', async () => {
    const events: QueueEvent[] = [];
    const onEvent = (e: QueueEvent) => events.push(e);
    const tx = { unsafe: async () => [{ v: "0", inserted: "f", on_dead: "t" }] };
    const scope = { begin: async (fn: (t: unknown) => unknown) => fn(tx) } as unknown as Transactor;
    await enqueue(scope, S, base, { onEvent });
    expect(events.at(-1)).toMatchObject({ type: "queue.enqueued", result: "on_dead" });
    const row = { key: "alpha:1", source: "alpha", kind: "put", attempts: "8", last_error: null };
    const deadSql = { unsafe: async () => [{ ...row, dead: "t" }] } as unknown as Sql;
    expect(
      await claim(deadSql, S, { source: "alpha", limit: 1, worker: "w" }, { onEvent }),
    ).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "queue.drained", deadLettered: 1 });
    const failed = await fail(deadSql, S, { key: "alpha:1", worker: "w", errorClass: "E" });
    expect(failed).toEqual({ result: "dead", attempts: 8 });
  });
});
