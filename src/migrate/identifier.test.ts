import { describe, expect, test } from "bun:test";
import { checkIdentifier } from "./db-surface.ts";

// One table of names, judged by migrate's copy of the identifier rule and by
// `db`'s `quoteIdentifier`. The two must accept and refuse the same names and
// render the same `got …` for each refusal.

const hex = "0123456789abcdef0123456789abcdef";
const NAMES: readonly [unknown, boolean][] = [
  ["rootstock", true],
  ["_x9", true],
  ["rs_t_0a1b", true],
  [`test_${hex}`, true],
  [`test_${hex}_rs`, true],
  ["a".repeat(63), true],
  ["a".repeat(64), false],
  ["", false],
  ["Root", false],
  ["9lives", false],
  ["rs-t", false],
  ['x"y', false],
  ["rs t", false],
  ["é", false],
  ["a;drop", false],
  [" rootstock", false],
  ["rootstock\n", false],
  [undefined, false],
  [null, false],
  [123, false],
  [10n, false],
  [["ok"], false],
];

function outcome(fn: () => unknown): { ok: true } | { ok: false; got: string } {
  try {
    fn();
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    return { ok: false, got: message.slice(message.indexOf(" — got ")) };
  }
}

describe("migrate's identifier rule", () => {
  for (const [name, ok] of NAMES) {
    test(`${String(name).slice(0, 20)} → ${ok ? "accepted" : "refused"}`, () => {
      expect(outcome(() => checkIdentifier("x", name)).ok).toBe(ok);
    });
  }

  test("the refusal names what was checked", () => {
    expect(outcome(() => checkIdentifier("migrateSlice: schema", 10n))).toEqual({
      ok: false,
      got: " — got 10n",
    });
  });
});

test("db's quoteIdentifier gives the same verdict for every name", async () => {
  const db: Record<string, unknown> = await import("../db/index.ts");
  // Until `db` ships, its index is the empty foundation stub; once it exports
  // anything, quoteIdentifier must be among it and the comparison runs.
  if (Object.keys(db).length === 0) return;
  const quoteIdentifier = db.quoteIdentifier as (name: unknown) => string;
  expect(typeof quoteIdentifier).toBe("function");
  for (const [name] of NAMES) {
    expect(
      outcome(() => quoteIdentifier(name)),
      String(name),
    ).toEqual(outcome(() => checkIdentifier("identifier", name)));
  }
});
