import { describe, expect, test } from "bun:test";
import { QUEUE_INPUT } from "./fixtures.test-support.ts";
import { cursorTable, queueSlice } from "./slice.ts";

const parse = (over: Record<string, unknown>) => queueSlice({ ...QUEUE_INPUT, ...over } as never);
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

const E_ID = "an identifier matching [a-z_][a-z0-9_]* of at most 63 bytes";

describe("queueSlice", () => {
  test("QS1: the synthetic slice parses, resolved, frozen and deep", () => {
    const s = parse({});
    expect(s.table).toEqual({ schema: "rootstock", name: "work_queue" });
    expect(s.stickyKind).toBe("drop");
    expect(s.cursors?.table).toEqual({ schema: "rootstock", name: "cursors" });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.sources)).toBe(true);
    expect(Object.isFrozen(s.backoffMinutes)).toBe(true);
    expect(Object.isFrozen(s.cursors)).toBe(true);
    const bare = parse({ stickyKind: undefined, cursors: undefined });
    expect(bare.stickyKind).toBeNull();
    expect(bare.cursors).toBeNull();
    expect(queueSlice({ ...QUEUE_INPUT }, { schema: "app" }).table).toEqual({
      schema: "app",
      name: "work_queue",
    });
  });

  const cases: [string, Record<string, unknown>, string, string, unknown][] = [
    ["table.schema", { table: { schema: "Bad" } }, "table.schema", E_ID, "Bad"],
    ["table.name", { table: { name: "x-y" } }, "table.name", E_ID, "x-y"],
    ["sources empty", { sources: [] }, "sources", "an array of 1 to 64 names", []],
    [
      "kinds 65",
      { kinds: Array.from({ length: 65 }, (_, i) => `k${i}`) },
      "kinds",
      "an array of 1 to 64 names",
      null,
    ],
    [
      "sources dup",
      { sources: ["alpha", "alpha"] },
      "sources[1]",
      "a unique name matching [a-z][a-z0-9-]* of at most 32 characters",
      "alpha",
    ],
    [
      "kinds shape",
      { kinds: ["Put"] },
      "kinds[0]",
      "a unique name matching [a-z][a-z0-9-]* of at most 32 characters",
      "Put",
    ],
    [
      "kinds long",
      { kinds: ["a".repeat(33)] },
      "kinds[0]",
      "a unique name matching [a-z][a-z0-9-]* of at most 32 characters",
      "a".repeat(33),
    ],
    ["stickyKind", { stickyKind: "nope" }, "stickyKind", "one of kinds", "nope"],
    [
      "expiredClaimClass empty",
      { expiredClaimClass: "" },
      "expiredClaimClass",
      "a non-empty string of at most maxNameChars characters with no NUL",
      "",
    ],
    [
      "expiredClaimClass NUL",
      { expiredClaimClass: "a\0b" },
      "expiredClaimClass",
      "a non-empty string of at most maxNameChars characters with no NUL",
      "a\0b",
    ],
    [
      "expiredClaimClass long",
      { maxNameChars: 3, expiredClaimClass: "abcd" },
      "expiredClaimClass",
      "a non-empty string of at most maxNameChars characters with no NUL",
      "abcd",
    ],
    [
      "backoff [0]",
      { backoffMinutes: [0] },
      "backoffMinutes",
      "1 to 20 non-decreasing integers from 1 to 1440",
      [0],
    ],
    [
      "backoff [5,1]",
      { backoffMinutes: [5, 1] },
      "backoffMinutes",
      "1 to 20 non-decreasing integers from 1 to 1440",
      [5, 1],
    ],
    [
      "backoff 21",
      { backoffMinutes: Array(21).fill(1) },
      "backoffMinutes",
      "1 to 20 non-decreasing integers from 1 to 1440",
      Array(21).fill(1),
    ],
    [
      "backoff 1441",
      { backoffMinutes: [1441] },
      "backoffMinutes",
      "1 to 20 non-decreasing integers from 1 to 1440",
      [1441],
    ],
    ["maxAttempts", { maxAttempts: 21 }, "maxAttempts", "an integer from 1 to 20", 21],
    [
      "claimTimeoutMinutes",
      { claimTimeoutMinutes: 0 },
      "claimTimeoutMinutes",
      "an integer from 1 to 1440",
      0,
    ],
    [
      "maxDebounceSeconds",
      { maxDebounceSeconds: 86401 },
      "maxDebounceSeconds",
      "an integer from 0 to 86400",
      86401,
    ],
    [
      "maxDebounceSlideMinutes",
      { maxDebounceSlideMinutes: 0 },
      "maxDebounceSlideMinutes",
      "an integer from 1 to 1440",
      0,
    ],
    ["maxKeyChars", { maxKeyChars: 513 }, "maxKeyChars", "an integer from 1 to 512", 513],
    ["maxNameChars", { maxNameChars: 1.5 }, "maxNameChars", "an integer from 1 to 512", 1.5],
    [
      "maxPayloadBytes",
      { maxPayloadBytes: 1048577 },
      "maxPayloadBytes",
      "an integer from 1 to 1048576",
      1048577,
    ],
    [
      "maxClaimLimit",
      { maxClaimLimit: 10001 },
      "maxClaimLimit",
      "an integer from 1 to 10000",
      10001,
    ],
    [
      "enqueueLockTimeoutMs",
      { enqueueLockTimeoutMs: 0 },
      "enqueueLockTimeoutMs",
      "an integer from 1 to 60000",
      0,
    ],
    [
      "cursors.value",
      { cursors: { value: "json", maxNameChars: 1, maxValueChars: 1 } },
      "cursors.value",
      '"text" or "jsonb"',
      "json",
    ],
    [
      "cursors.maxNameChars",
      { cursors: { value: "text", maxNameChars: 513, maxValueChars: 1 } },
      "cursors.maxNameChars",
      "an integer from 1 to 512",
      513,
    ],
    [
      "cursors.maxValueChars",
      { cursors: { value: "text", maxNameChars: 1, maxValueChars: 1048577 } },
      "cursors.maxValueChars",
      "an integer from 1 to 1048576",
      1048577,
    ],
    [
      "cursors.table.name",
      { cursors: { table: { name: "Bad" }, value: "text", maxNameChars: 1, maxValueChars: 1 } },
      "cursors.table.name",
      E_ID,
      "Bad",
    ],
    ["cursors object", { cursors: 5 }, "cursors", "an object", 5],
  ];
  for (const [label, over, path, expected, value] of cases) {
    test(`QS1: ${label} refuses at ${path}`, () => {
      const got = refusal(() => parse(over));
      const tail = value === null ? "" : ` — got ${JSON.stringify(value)}`;
      expect(got.startsWith(`queueSlice: ${path} must be ${expected}`)).toBe(true);
      if (value !== null) expect(got).toBe(`queueSlice: ${path} must be ${expected}${tail}`);
    });
  }

  test("QS1: the refusal order is unknown keys, then required, then values", () => {
    expect(refusal(() => parse({ extra: 1, sources: undefined, maxAttempts: 99 }))).toBe(
      "queueSlice: extra is not a known key",
    );
    expect(refusal(() => parse({ sources: undefined, maxAttempts: 99 }))).toBe(
      "queueSlice: sources is required",
    );
    expect(
      refusal(() => parse({ cursors: { value: "text", maxNameChars: 1, maxValueChars: 1, x: 1 } })),
    ).toBe("queueSlice: cursors.x is not a known key");
    expect(refusal(() => parse({ cursors: { maxNameChars: 1, maxValueChars: 1 } }))).toBe(
      "queueSlice: cursors.value is required",
    );
    expect(refusal(() => parse({ table: { x: 1 } }))).toBe(
      "queueSlice: table.x is not a known key",
    );
    // expiredClaimClass is judged against maxNameChars, whatever the key order.
    expect(
      refusal(() => parse({ expiredClaimClass: "abcd", maxNameChars: 3, maxAttempts: 99 })),
    ).toContain("maxAttempts");
    expect(refusal(() => parse({ expiredClaimClass: "", maxNameChars: 0 }))).toContain(
      "maxNameChars",
    );
  });

  test("QT2: a table name that is not an identifier refuses at the slice", () => {
    expect(refusal(() => parse({ table: { schema: "rs_a", name: "Bad" } }))).toBe(
      `queueSlice: table.name must be ${E_ID} — got "Bad"`,
    );
  });
});

describe("cursorTable", () => {
  test("parses under its own parser name and defaults", () => {
    const t = cursorTable(
      { value: "jsonb", maxNameChars: 10, maxValueChars: 20 },
      { schema: "app" },
    );
    expect(t.table).toEqual({ schema: "app", name: "cursors" });
    expect(Object.isFrozen(t)).toBe(true);
    expect(refusal(() => cursorTable({ value: "x" } as never))).toBe(
      "cursorTable: maxNameChars is required",
    );
    expect(
      refusal(() => cursorTable({ value: "x", maxNameChars: 1, maxValueChars: 1 } as never)),
    ).toBe('cursorTable: value must be "text" or "jsonb" — got "x"');
  });

  test('"text" on the shipped (jsonb) table refuses; a named text table parses', () => {
    const shipped =
      'cursorTable: value must be "jsonb" for the shipped cursors table (its value column is jsonb); name your own text table in table.name to use "text" — got "text"';
    for (const table of [undefined, {}, { schema: "app" }]) {
      expect(
        refusal(() => cursorTable({ table, value: "text", maxNameChars: 1, maxValueChars: 1 })),
      ).toBe(shipped);
    }
    expect(
      refusal(() =>
        queueSlice({
          ...QUEUE_INPUT,
          cursors: { value: "text", maxNameChars: 1, maxValueChars: 1 },
        }),
      ),
    ).toBe(shipped.replace("cursorTable: value", "queueSlice: cursors.value"));
    const t = cursorTable({
      table: { name: "text_cursors" },
      value: "text",
      maxNameChars: 1,
      maxValueChars: 1,
    });
    expect(t.table).toEqual({ schema: "rootstock", name: "text_cursors" });
  });

  test("a default schema that is not an identifier refuses at table.schema", () => {
    const input = { value: "jsonb", maxNameChars: 1, maxValueChars: 1 } as const;
    expect(refusal(() => cursorTable(input, { schema: "Bad" }))).toBe(
      `cursorTable: table.schema must be ${E_ID} — got "Bad"`,
    );
    expect(refusal(() => queueSlice(QUEUE_INPUT, { schema: 'x"; DROP' }))).toBe(
      `queueSlice: table.schema must be ${E_ID} — got "x\\"; DROP"`,
    );
  });
});
