import { describe, expect, test } from "bun:test";
import {
  cursorStatements,
  LOCK_TIMEOUT_READ,
  LOCK_TIMEOUT_SET,
  queueStatements,
} from "./statements.ts";

const TABLE = { schema: "rs_a", name: "wq" };
const q = queueStatements(TABLE);
const textCursor = cursorStatements(TABLE, "text");
const jsonCursor = cursorStatements(TABLE, "jsonb");

/** Each statement and how many parameters it is sent with. */
const ALL: [string, string, number][] = [
  ["Q1 (a)", LOCK_TIMEOUT_READ, 0],
  ["Q1 (b)", LOCK_TIMEOUT_SET, 1],
  ["Q1 (c)", q.enqueue, 7],
  ["Q2", q.claim, 6],
  ["Q3", q.ack, 2],
  ["Q4", q.fail, 6],
  ["Q5", q.retryDead, 1],
  ["Q6", q.listDead, 2],
  ["Q7", q.depth, 1],
  ["K1 text", textCursor.get, 1],
  ["K2 text", textCursor.set, 2],
  ["K3 text", textCursor.touch, 2],
  ["K1 jsonb", jsonCursor.get, 1],
  ["K2 jsonb", jsonCursor.set, 2],
  ["K3 jsonb", jsonCursor.touch, 2],
];

describe("QT1: built statements", () => {
  for (const [id, text, params] of ALL) {
    test(`${id}: placeholders 1..${params} only, each referenced, no comment`, () => {
      const used = new Set<number>();
      const stripped = text.replace(/\$([1-9][0-9]*)/g, (m, n: string) => {
        const i = Number(n);
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
    test(`${id}: the table appears only quoted`, () => {
      const rest = text.replaceAll('"rs_a"."wq"', "");
      expect(rest).not.toMatch(/\brs_a\b|\bwq\b/);
    });
  }

  test("every table-bound statement names the table", () => {
    for (const [id, text] of ALL.slice(2)) expect(text, id).toContain('"rs_a"."wq"');
  });

  test("a text cursor binds the value as is; a jsonb one casts it through text", () => {
    expect(textCursor.set).toContain("VALUES ($1, $2, clock_timestamp())");
    expect(jsonCursor.set).toContain("VALUES ($1, $2::text::jsonb, clock_timestamp())");
    expect(Object.isFrozen(q)).toBe(true);
  });
});
