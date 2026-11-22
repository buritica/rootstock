import { describe, expect, test } from "bun:test";
import { type UsageSliceInput, usageSlice } from "./slice.ts";

const BASE: UsageSliceInput = {
  callLog: { maxBuffered: 1000, maxBatch: 100, retention: { keepDays: 90 } },
  keepArgs: true,
  keepOutput: false,
  spend: null,
};

const refusal = (input: unknown, defaults?: { schema?: string }): string => {
  try {
    usageSlice(input as UsageSliceInput, defaults);
  } catch (err) {
    return (err as Error).message;
  }
  return "parsed";
};

describe("usageSlice", () => {
  test("parses, filling the call log table from the default schema, frozen", () => {
    const s = usageSlice(BASE, { schema: "app_rs" });
    expect(s.callLog).toEqual({
      table: { schema: "app_rs", name: "mcp_calls" },
      maxBuffered: 1000,
      maxBatch: 100,
      retention: { keepDays: 90 },
    });
    expect([s.keepArgs, s.keepOutput, s.spend]).toEqual([true, false, null]);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.callLog)).toBe(true);
    expect(Object.isFrozen(s.callLog?.retention)).toBe(true);
    expect(usageSlice(BASE).callLog?.table.schema).toBe("rootstock");
  });

  test("a given table, no call log, and both store shapes", () => {
    const s = usageSlice({
      ...BASE,
      callLog: { table: { schema: "public" }, maxBuffered: 10, maxBatch: 10, retention: null },
      spend: { unit: "usd", ceiling: 2.5, store: { kind: "rootstock" } },
    });
    expect(s.callLog?.table).toEqual({ schema: "public", name: "mcp_calls" });
    expect(s.callLog?.retention).toBeNull();
    expect(s.spend).toEqual({
      unit: "usd",
      ceiling: 2.5,
      store: { kind: "rootstock", schema: "rootstock" },
    });
    expect(usageSlice({ ...BASE, callLog: null }).callLog).toBeNull();
    const day = {
      kind: "day-user-tokens",
      schema: "public",
      table: "app_daily_spend",
      day: "day",
      user: "user_id",
      used: "tokens_used",
    } as const;
    expect(
      usageSlice({ ...BASE, spend: { unit: "tokens", ceiling: 2_000_000, store: day } }).spend
        ?.store,
    ).toEqual(day);
    expect(
      Object.isFrozen(
        usageSlice({ ...BASE, spend: { unit: "tokens", ceiling: 1, store: day } }).spend?.store,
      ),
    ).toBe(true);
  });

  test("refuses, in the parsers' order: unknown keys, required, values", () => {
    expect(refusal({ ...BASE, extra: 1 })).toBe("usageSlice: extra is not a known key");
    const { keepOutput: _, ...noOutput } = BASE;
    expect(refusal(noOutput)).toBe("usageSlice: keepOutput is required");
    expect(refusal({ ...BASE, keepArgs: "yes" })).toBe(
      'usageSlice: keepArgs must be a boolean — got "yes"',
    );
    expect(refusal({ ...BASE, callLog: { maxBuffered: 10, retention: null } })).toBe(
      "usageSlice: callLog.maxBatch is required",
    );
    expect(refusal({ ...BASE, callLog: { maxBuffered: 10, maxBatch: 11, retention: null } })).toBe(
      "usageSlice: callLog.maxBatch must be an integer from 1 to 10 — got 11",
    );
    expect(refusal({ ...BASE, callLog: { maxBuffered: 0, maxBatch: 1, retention: null } })).toMatch(
      /callLog\.maxBuffered/,
    );
    expect(
      refusal({
        ...BASE,
        callLog: { maxBuffered: 1, maxBatch: 1, retention: null, table: { name: "Bad" } },
      }),
    ).toMatch(/callLog\.table\.name must be an identifier/);
    expect(
      refusal({ ...BASE, spend: { unit: "eur", ceiling: 1, store: { kind: "rootstock" } } }),
    ).toMatch(/spend\.unit must be "tokens" or "usd"/);
    expect(
      refusal({ ...BASE, spend: { unit: "tokens", ceiling: 0, store: { kind: "rootstock" } } }),
    ).toMatch(/spend\.ceiling must be a positive finite number/);
    expect(refusal({ ...BASE, spend: { unit: "tokens", ceiling: 1 } })).toBe(
      "usageSlice: spend.store is required",
    );
    expect(
      refusal({ ...BASE, spend: { unit: "tokens", ceiling: 1, store: { kind: "file" } } }),
    ).toMatch(/spend\.store\.kind must be/);
    expect(
      refusal({
        ...BASE,
        spend: { unit: "tokens", ceiling: 1, store: { kind: "day-user-tokens", schema: "public" } },
      }),
    ).toBe("usageSlice: spend.store.table is required");
    expect(
      refusal({
        ...BASE,
        spend: {
          unit: "usd",
          ceiling: 1,
          store: {
            kind: "day-user-tokens",
            schema: "public",
            table: "t",
            day: "d",
            user: "u",
            used: "n",
          },
        },
      }),
    ).toMatch(/spend\.unit must be "tokens" for a day-user-tokens store/);
    expect(
      refusal({
        ...BASE,
        spend: { unit: "tokens", ceiling: 1, store: { kind: "rootstock", table: "x" } },
      }),
    ).toBe("usageSlice: spend.store.table is not a known key");
  });
  test("callLog.retention: required, null or keepDays from 7 to 3650, no other keys", () => {
    const log = (retention: unknown) =>
      refusal({ ...BASE, callLog: { maxBuffered: 10, maxBatch: 10, retention } });
    expect(refusal({ ...BASE, callLog: { maxBuffered: 10, maxBatch: 10 } })).toBe(
      "usageSlice: callLog.retention is required",
    );
    expect(log({ keepDays: 7 })).toBe("parsed");
    expect(log({ keepDays: 3650 })).toBe("parsed");
    expect(log({ keepDays: 6 })).toMatch(
      /callLog\.retention\.keepDays must be an integer from 7 to 3650/,
    );
    expect(log({ keepDays: 3651 })).toMatch(/callLog\.retention\.keepDays/);
    expect(log({ keepDays: 30.5 })).toMatch(/callLog\.retention\.keepDays/);
    expect(log({})).toBe("usageSlice: callLog.retention.keepDays is required");
    expect(log({ keepDays: 30, everyHours: 1 })).toMatch(/callLog\.retention\.everyHours/);
    expect(log(30)).toMatch(/callLog\.retention/);
  });
});
