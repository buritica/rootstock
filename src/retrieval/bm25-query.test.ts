import { describe, expect, test } from "bun:test";
import { bm25Query } from "./bm25-query.ts";

const base = {
  table: "docs",
  keyColumn: "slug",
  tsvColumn: "tsv",
  index: "docs_bm25",
  config: "english",
  query: "upload size limit",
  limit: 20,
};

describe("bm25Query", () => {
  test("binds the query text, config, index and limit; never splices them", () => {
    const q = bm25Query({ ...base, query: "'; drop table docs; --" });
    expect(q.params).toEqual(["english", "'; drop table docs; --", "docs_bm25", 20]);
    expect(q.text).not.toContain("drop table");
    expect(q.text).toContain("to_bm25query(to_tsvector($1::regconfig, $2), $3)");
    expect(q.text).toContain("limit $4");
  });

  test("quotes identifiers, including a schema-qualified table", () => {
    const q = bm25Query({ ...base, table: "app.docs" });
    expect(q.text).toContain('from "app"."docs" d');
    expect(q.text).toContain('d."slug" as key');
    expect(q.text).toContain('d."tsv" <@>');
  });

  test("refuses an identifier that is not a plain name", () => {
    expect(() => bm25Query({ ...base, keyColumn: 'we"ird' })).toThrow();
    expect(() => bm25Query({ ...base, table: "docs; drop table x" })).toThrow();
    expect(() => bm25Query({ ...base, table: "a.b.c" })).toThrow();
  });

  test("keeps only matching rows, best first, with a stable tie order", () => {
    const q = bm25Query(base);
    expect(q.text).toContain("where score < 0");
    expect(q.text).toContain("order by score, key");
  });

  test("splices a trusted scope over alias d", () => {
    expect(bm25Query({ ...base, where: "d.archived_at is null" }).text).toContain(
      "where d.archived_at is null",
    );
    expect(bm25Query(base).text).not.toContain("where d.");
  });

  test("rejects a limit that is not a positive integer", () => {
    expect(() => bm25Query({ ...base, limit: 0 })).toThrow();
    expect(() => bm25Query({ ...base, limit: 1.5 })).toThrow();
  });

  test("without a budget, the statement is unchanged and nothing is set", () => {
    const q = bm25Query(base);
    expect(q.setBudget).toBeNull();
    expect(q.params).toEqual(["english", "upload size limit", "docs_bm25", 20]);
    expect(q.text).toBe(`select key, score from (
  select d."slug" as key,
         d."tsv" <@> to_bm25query(to_tsvector($1::regconfig, $2), $3) as score
  from "docs" d
  
) s
where score < 0
order by score, key
limit $4`);
  });

  test("a budget adds a set local statement and leaves the query alone", () => {
    const plain = bm25Query(base);
    const q = bm25Query({ ...base, limit: 300, budget: 600 });
    expect(q.setBudget).toEqual({ text: "set local lakebase_bm25.default_limit = 600" });
    expect(q.text).toBe(plain.text);
    expect(q.params).toEqual(["english", "upload size limit", "docs_bm25", 300]);
    expect(bm25Query({ ...base, budget: 20 }).setBudget?.text).toEndWith("= 20");
    expect(bm25Query({ ...base, budget: 65535 }).setBudget?.text).toEndWith("= 65535");
  });

  test("rejects a budget that is not an integer from limit to 65535", () => {
    for (const budget of [1.5, Number.NaN, -1, 0, 19, 65536, Number.POSITIVE_INFINITY]) {
      expect(() => bm25Query({ ...base, budget })).toThrow(`got ${budget}`);
    }
    // @ts-expect-error a caller without types must still not reach `set` with text
    expect(() => bm25Query({ ...base, budget: "1; drop table docs" })).toThrow();
  });
});
