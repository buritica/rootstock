import { describe, expect, test } from "bun:test";
import type { Sql, Transactor } from "../db/index.ts";
import { applyRootstockMigrations, rootstockMigrationStatus } from "./index.ts";
import { type MigrateSlice, type MigrateSliceInput, migrateSlice } from "./slice.ts";

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a throw");
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a rejection");
}

describe("migrateSlice", () => {
  test("defaults the schema to rootstock and keeps ahead", () => {
    expect(migrateSlice({ ahead: "refuse" }) as unknown).toEqual({
      schema: "rootstock",
      ahead: "refuse",
      accepted: [],
    });
    expect(migrateSlice({ schema: "rs_t_ab12", ahead: "allow" }) as unknown).toEqual({
      schema: "rs_t_ab12",
      ahead: "allow",
      accepted: [],
    });
  });

  test("an undefined schema counts as absent", () => {
    expect(migrateSlice({ schema: undefined, ahead: "refuse" }).schema).toBe("rootstock");
  });

  test("the result is frozen", () => {
    const slice = migrateSlice({ ahead: "refuse" });
    expect(Object.isFrozen(slice)).toBe(true);
    expect(() => {
      (slice as { schema: string }).schema = "other";
    }).toThrow();
  });

  test("identifier bounds: 63 bytes pass, 64 refuse", () => {
    const at63 = `s${"a".repeat(62)}`;
    expect(migrateSlice({ schema: at63, ahead: "refuse" }).schema).toBe(at63);
    expect(thrown(() => migrateSlice({ schema: `${at63}a`, ahead: "refuse" }))).toBe(
      `rootstock: migrateSlice: schema must match [a-z_][a-z0-9_]* and be at most 63 bytes — got "${at63}a"`,
    );
  });

  for (const bad of ["Rootstock", "1abc", "a-b", 'x"; drop', "", "é"]) {
    test(`schema ${JSON.stringify(bad)} is refused with the identifier text`, () => {
      expect(thrown(() => migrateSlice({ schema: bad, ahead: "refuse" }))).toBe(
        `rootstock: migrateSlice: schema must match [a-z_][a-z0-9_]* and be at most 63 bytes — got ${JSON.stringify(bad)}`,
      );
    });
  }

  test("ahead is required", () => {
    expect(thrown(() => migrateSlice({} as MigrateSliceInput))).toBe(
      "migrateSlice: ahead is required",
    );
  });

  test("ahead must be refuse or allow", () => {
    expect(thrown(() => migrateSlice({ ahead: "ignore" } as unknown as MigrateSliceInput))).toBe(
      'migrateSlice: ahead must be "refuse" or "allow" — got "ignore"',
    );
  });

  test("an unknown key is refused", () => {
    const input = { ahead: "refuse", allowHeavy: true } as unknown as MigrateSliceInput;
    expect(thrown(() => migrateSlice(input))).toBe("migrateSlice: allowHeavy is not a known key");
  });
});

describe("unbranded-slice-refused", () => {
  const forged = Object.freeze({ schema: "rootstock", ahead: "refuse" }) as unknown as MigrateSlice;
  const untouched = (): never => {
    throw new Error("the database was reached");
  };
  const sql = Object.assign(untouched, { unsafe: untouched }) as unknown as Sql;
  const transactor: Transactor = { id: "bun-sql", sql, begin: untouched };

  test("rootstockMigrationStatus", async () => {
    expect(await rejection(rootstockMigrationStatus(sql, forged))).toBe(
      "rootstockMigrationStatus: expected a MigrateSlice built by migrateSlice() — got an object that parser did not return",
    );
  });

  test("applyRootstockMigrations", async () => {
    expect(await rejection(applyRootstockMigrations(transactor, forged))).toBe(
      "applyRootstockMigrations: expected a MigrateSlice built by migrateSlice() — got an object that parser did not return",
    );
  });
});

describe("migrateSlice accepted", () => {
  const R = "a".repeat(64);
  const C = "b".repeat(64);
  const ok = {
    source: "app",
    id: "0001_x.sql",
    recorded: R,
    current: C,
    reason: "edited before hashes",
  };

  test("keeps valid entries, frozen", () => {
    const slice = migrateSlice({ ahead: "refuse", accepted: [ok] });
    expect(slice.accepted as unknown).toEqual([ok]);
    expect(Object.isFrozen(slice.accepted)).toBe(true);
    expect(Object.isFrozen(slice.accepted[0])).toBe(true);
  });

  test.each([
    [{ accepted: {} }, "migrateSlice: accepted must be an array — got {}"],
    [{ accepted: [1] }, "migrateSlice: accepted[0] must be an object — got 1"],
    [{ accepted: [{ ...ok, extra: 1 }] }, "migrateSlice: accepted[0].extra is not a known key"],
    [{ accepted: [{ ...ok, reason: undefined }] }, "migrateSlice: accepted[0].reason is required"],
    [
      { accepted: [{ ...ok, source: "App" }] },
      'migrateSlice: accepted[0].source must be a source name matching [a-z][a-z0-9-]* — got "App"',
    ],
    [
      { accepted: [{ ...ok, id: "" }] },
      'migrateSlice: accepted[0].id must be a non-empty string — got ""',
    ],
    [
      { accepted: [{ ...ok, recorded: R.toUpperCase() }] },
      "migrateSlice: accepted[0].recorded must be 64 lowercase hex characters",
    ],
    [
      { accepted: [{ ...ok, current: "b" }] },
      'migrateSlice: accepted[0].current must be 64 lowercase hex characters — got "b"',
    ],
    [
      { accepted: [{ ...ok, current: R }] },
      "migrateSlice: accepted[0].current must be different from recorded",
    ],
    [
      { accepted: [{ ...ok, reason: "  " }] },
      'migrateSlice: accepted[0].reason must be a non-empty string — got "  "',
    ],
    [
      { accepted: [ok, { ...ok, reason: "again" }] },
      "migrateSlice: accepted[1] repeats app/0001_x.sql",
    ],
  ])("refuses %j", (extra, message) => {
    expect(
      thrown(() => migrateSlice({ ahead: "refuse", ...extra } as MigrateSliceInput)),
    ).toStartWith(message);
  });
});
