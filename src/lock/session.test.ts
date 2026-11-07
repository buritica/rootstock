import { describe, expect, test } from "bun:test";
import { bunSqlLockSession, postgresJsLockSession } from "./session.ts";
import { lockSlice } from "./slice.ts";

const SLICE = lockSlice({
  profile: "lock",
  names: ["alpha-sync"],
  heartbeatSeconds: 5,
  probeStallSeconds: 10,
  maxRecoveries: 1,
  endTimeoutSeconds: 7,
  wait: { maxMs: 0, pollIntervalMs: 10 },
});

function fakeClient(rows: unknown[]) {
  const seen: unknown[][] = [];
  const ends: unknown[] = [];
  const client = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(["tag", strings.join("?"), values]);
      return rows;
    },
    {
      unsafe: async (query: string, params?: unknown[]) => {
        seen.push(["unsafe", query, params]);
        return rows;
      },
      end: async (opts?: unknown) => {
        ends.push(opts);
      },
      close: async (opts?: unknown) => {
        ends.push(opts);
      },
    },
  );
  return { client, seen, ends };
}

describe("lock sessions", () => {
  for (const [label, make] of [
    ["postgresJsLockSession", postgresJsLockSession],
    ["bunSqlLockSession", bunSqlLockSession],
  ] as const) {
    test(`${label}: delegates both query forms, and ends the client once, bounded`, async () => {
      const { client, seen, ends } = fakeClient([{ one: 1 }]);
      const s = make(client, SLICE);
      expect(await s.sql`SELECT ${1}`).toEqual([{ one: 1 }]);
      expect(await s.sql.unsafe("SELECT $1", ["x"])).toEqual([{ one: 1 }]);
      expect(await s.sql.unsafe("SELECT 1")).toEqual([{ one: 1 }]);
      expect(seen).toEqual([
        ["tag", "SELECT ?", [1]],
        ["unsafe", "SELECT $1", ["x"]],
        ["unsafe", "SELECT 1", undefined],
      ]);
      expect(ends).toEqual([]);
      await s.close();
      await s.close();
      expect(ends).toEqual([{ timeout: 7 }]);
    });

    test(`${label}: a rejecting close rejects once; the second close resolves`, async () => {
      const { client } = fakeClient([]);
      const boom = new Error("end failed");
      const failing = Object.assign(client, {
        end: async () => {
          throw boom;
        },
        close: async () => {
          throw boom;
        },
      });
      const s = make(failing, SLICE);
      await expect(s.close()).rejects.toBe(boom);
      expect(await s.close()).toBeUndefined();
    });

    test(`${label}: refuses a slice lockSlice did not build`, () => {
      const { client } = fakeClient([]);
      expect(() => make(client, { ...SLICE })).toThrow(
        `${label}: expected a LockSlice built by lockSlice() — got an object that parser did not return`,
      );
    });
  }
});
