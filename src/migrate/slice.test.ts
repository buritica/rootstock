import { describe, expect, test } from "bun:test";
import type { Sql, Transactor } from "./db-surface.ts";
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
    });
    expect(migrateSlice({ schema: "rs_t_ab12", ahead: "allow" }) as unknown).toEqual({
      schema: "rs_t_ab12",
      ahead: "allow",
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
