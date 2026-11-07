import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgCode, type Sql } from "../db/index.ts";
import { openTestTransactor, type TestTransactor } from "../db/transactor.pg-support.ts";
import { applyRootstockMigrations } from "../migrate/apply.ts";
import { schemaFactory } from "../migrate/fixtures.pg-support.ts";
import { migrateSlice } from "../migrate/slice.ts";
import {
  type CursorTable,
  cursorTable,
  getCursor,
  type QueueEvent,
  RootstockQueueError,
  setCursor,
  touchCursor,
} from "./index.ts";

// R-C6 (contract §4.8 KD1): cursors on rootstock's jsonb table and on a
// text-valued table of the test's own, once per transactor kind.

let main: TestTransactor;
let sql: Sql;
const { schema, dropAll } = schemaFactory("rs_k");
let jsonT: CursorTable;
let textT: CursorTable;

beforeAll(async () => {
  main = openTestTransactor();
  sql = main.transactor.sql;
  const sc = schema();
  await applyRootstockMigrations(main.transactor, migrateSlice({ schema: sc }));
  await sql.unsafe(
    `CREATE TABLE "${sc}".text_cursors (name text PRIMARY KEY, value text NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now())`,
  );
  jsonT = cursorTable({ value: "jsonb", maxNameChars: 128, maxValueChars: 512 }, { schema: sc });
  textT = cursorTable(
    { table: { name: "text_cursors" }, value: "text", maxNameChars: 128, maxValueChars: 512 },
    { schema: sc },
  );
});

afterAll(async () => {
  await dropAll(sql);
  await main.close();
});

function recorder() {
  const events: QueueEvent[] = [];
  return { events, hooks: { onEvent: (e: QueueEvent) => events.push(e) } };
}

async function stamp(t: CursorTable, name: string): Promise<{ value: string; at: string }> {
  const [r] = await sql.unsafe<{ value: string; at: string }>(
    `SELECT value::text AS value, updated_at::text AS at FROM "${t.table.schema}"."${t.table.name}" WHERE name = $1`,
    [name],
  );
  if (r === undefined) throw new Error(`no cursor ${name}`);
  return r;
}

describe("KD1: cursors", () => {
  for (const kind of ["jsonb", "text"] as const) {
    const table = () => (kind === "jsonb" ? jsonT : textT);

    test(`${kind}: an unknown name reads undefined`, async () => {
      const r = recorder();
      expect(await getCursor(sql, table(), `${kind}-none`, r.hooks)).toBeUndefined();
      expect(r.events).toEqual([{ type: "queue.cursor_read", name: `${kind}-none`, value: null }]);
    });

    test(`${kind}: set then get round-trips, and cursor_written names what it moved from`, async () => {
      const values: unknown[] =
        kind === "jsonb" ? [{ page: "p1", n: 2 }, [1, "two"], "token", 42] : ["t1", "t2"];
      const name = `${kind}-feed`;
      const r = recorder();
      let previous: unknown = null;
      for (const value of values) {
        await setCursor(sql, table(), name, value, r.hooks);
        expect(r.events.at(-1)).toEqual({
          type: "queue.cursor_written",
          name,
          from: previous,
          to: value,
        });
        expect(await getCursor(sql, table(), name, r.hooks)).toEqual(value);
        expect(r.events.at(-1)).toEqual({ type: "queue.cursor_read", name, value });
        previous = value;
      }
    });

    test(`${kind}: touchCursor inserts once, then moves only updated_at`, async () => {
      const name = `${kind}-pulse`;
      const first = kind === "jsonb" ? { alive: true } : "alive";
      await touchCursor(sql, table(), name, first);
      const a = await stamp(table(), name);
      await sql.unsafe("SELECT pg_sleep(0.01)");
      await touchCursor(sql, table(), name, kind === "jsonb" ? { alive: false } : "other");
      const b = await stamp(table(), name);
      expect(b.value).toBe(a.value);
      expect(b.at).not.toBe(a.at);
      expect(await getCursor(sql, table(), name)).toEqual(first);
    });

    test(`${kind}: a 129-character name refuses cursor_name_invalid`, async () => {
      await expect(getCursor(sql, table(), "n".repeat(129))).rejects.toMatchObject({
        reason: "cursor_name_invalid",
      });
    });
  }

  test("text: a non-string value refuses cursor_value_invalid", async () => {
    const r = recorder();
    let err: unknown;
    try {
      await setCursor(sql, textT, "text-feed", { not: "a string" }, r.hooks);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RootstockQueueError);
    expect((err as RootstockQueueError).reason).toBe("cursor_value_invalid");
    expect(r.events).toEqual([
      { type: "queue.refused", key: null, source: null, reason: "cursor_value_invalid" },
    ]);
  });

  test("a text cursor naming a jsonb table fails 42804 on every driver, storing nothing", async () => {
    const wrong = cursorTable(
      { table: { name: "cursors" }, value: "text", maxNameChars: 128, maxValueChars: 512 },
      { schema: jsonT.table.schema },
    );
    for (const call of [
      () => setCursor(sql, wrong, "text-on-jsonb", "v"),
      () => touchCursor(sql, wrong, "text-on-jsonb", "v"),
    ]) {
      let err: unknown;
      try {
        await call();
      } catch (e) {
        err = e;
      }
      expect(pgCode(err)).toBe("42804");
    }
    expect(await getCursor(sql, jsonT, "text-on-jsonb")).toBeUndefined();
  });

  test("a missing cursor table refuses NOTABLE, naming it", async () => {
    const t = cursorTable({
      table: { schema: "rs_missing" },
      value: "jsonb",
      maxNameChars: 8,
      maxValueChars: 8,
    });
    for (const call of [
      () => getCursor(sql, t, "a"),
      () => setCursor(sql, t, "a", 1),
      () => touchCursor(sql, t, "a", 1),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "ERR_ROOTSTOCK_QUEUE_NOTABLE",
        table: "rs_missing.cursors",
      });
    }
  });
});
