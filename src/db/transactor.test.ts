import { describe, expect, test } from "bun:test";
import {
  bunSqlTransactor,
  type DrizzleSqlTagLike,
  drizzleTransactor,
  postgresJsTransactor,
  type TxSql,
} from "./transactor.ts";

// Driver doubles: each records what rootstock called and hands back tokens,
// so a test can check that the driver's own objects come back untouched.

type Call = [string, ...unknown[]];

// What a driver rejects with for a server error: an object carrying a SQLSTATE.
const serverError = Object.assign(new Error("duplicate key"), { code: "23505" });
const FAIL = "insert failing";
// A client-side refusal: no SQLSTATE, nothing reached the server.
const REFUSE = "refused before sending";

function tagDouble(name: string, calls: Call[]) {
  const result = Promise.resolve([{ from: name }]);
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push([`${name}.tag`, [...strings], ...values]);
    return result;
  };
  return Object.assign(tag, {
    result,
    unsafe: (query: string, params?: unknown[]) => {
      calls.push([`${name}.unsafe`, query, params]);
      if (query === REFUSE) return Promise.reject(new Error(REFUSE));
      return query === FAIL ? Promise.reject(serverError) : result;
    },
    savepoint: async (fn: (sp: unknown) => unknown) => {
      const sp = tagDouble(`${name}.sp`, calls);
      calls.push([`${name}.savepoint`, sp]);
      return fn(sp);
    },
    begin: async (fn: (tx: unknown) => unknown) => {
      const tx = tagDouble(`${name}.tx`, calls);
      calls.push([`${name}.begin`, tx]);
      return fn(tx);
    },
  });
}

const drizzleSqlDouble = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  { raw: (query: string) => ({ raw: query }) },
) as DrizzleSqlTagLike;

function drizzleDouble(
  name: string,
  calls: Call[],
  out: { result: unknown } = { result: [{ from: name }] },
) {
  return {
    execute: async (query: unknown) => {
      calls.push([`${name}.execute`, query]);
      if ((query as { raw?: string }).raw === FAIL) throw serverError;
      if ((query as { raw?: string }).raw === REFUSE) throw new Error(REFUSE);
      return out.result;
    },
    transaction: async (fn: (tx: unknown) => unknown) => {
      const tx = drizzleDouble(`${name}.tx`, calls, out);
      calls.push([`${name}.transaction`, tx]);
      return fn(tx);
    },
    begin: () => {
      throw new Error("drizzle has no begin");
    },
  };
}

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "(did not throw)";
}

const FACTORIES = [
  ["postgres-js", (calls: Call[]) => postgresJsTransactor(tagDouble("db", calls))],
  ["bun-sql", (calls: Call[]) => bunSqlTransactor(tagDouble("db", calls))],
  [
    "drizzle",
    (calls: Call[]) => drizzleTransactor(drizzleDouble("db", calls), { sql: drizzleSqlDouble }),
  ],
] as const;

describe("every transactor", () => {
  for (const [id, make] of FACTORIES) {
    describe(id, () => {
      test("is frozen, carries its id, and so are its query surfaces", async () => {
        const t = make([]);
        expect(t.id).toBe(id);
        expect(Object.isFrozen(t)).toBe(true);
        expect(Object.isFrozen(t.sql)).toBe(true);
        await t.begin(async (tx) => {
          expect(Object.isFrozen(tx)).toBe(true);
          await tx.savepoint(async (sp) => {
            expect(Object.isFrozen(sp)).toBe(true);
          });
        });
      });

      test("begin calls the driver's transaction once and hands fn the native object", async () => {
        const calls: Call[] = [];
        const t = make(calls);
        let seen: unknown;
        const value = await t.begin(async (_tx, native) => {
          seen = native;
          return ["a", "b"];
        });
        expect(value).toEqual(["a", "b"]);
        const entered = calls.filter(([c]) => c === "db.begin" || c === "db.transaction");
        expect(entered).toHaveLength(1);
        expect(seen).toBe(entered[0]?.[1]);
      });

      test("begin-rethrows-same-object", async () => {
        const boom = new Error("boom");
        const caught = await make([])
          .begin(async () => {
            throw boom;
          })
          .catch((err: unknown) => err);
        expect(caught).toBe(boom);
      });

      test("a savepoint rethrows the same object", async () => {
        const boom = new Error("boom");
        const caught = await make([])
          .begin((tx) =>
            tx.savepoint(async () => {
              throw boom;
            }),
          )
          .catch((err: unknown) => err);
        expect(caught).toBe(boom);
      });

      test("a handle used after its transaction settled is refused (E-TX-CLOSED)", async () => {
        const calls: Call[] = [];
        const t = make(calls);
        const closed = `${id}: this transaction has already settled — its handle can no longer be used`;
        let leakedTx: TxSql | undefined;
        let leakedSp: TxSql | undefined;
        await t.begin(async (tx) => {
          leakedTx = tx;
          await tx.savepoint(async (sp) => {
            leakedSp = sp;
          });
          // The savepoint settled, so its handle is closed while tx stays open.
          expect(await messageOf(async () => (leakedSp as TxSql)`select 1`)).toBe(closed);
          await tx`select ${1}`;
        });
        const before = calls.length;
        for (const h of [leakedTx, leakedSp]) {
          expect(await messageOf(async () => (h as TxSql)`select ${1}`)).toBe(closed);
          expect(await messageOf(async () => (h as TxSql).unsafe("select 1"))).toBe(closed);
          expect(await messageOf(async () => (h as TxSql).savepoint(async () => 1))).toBe(closed);
        }
        expect(calls).toHaveLength(before);
      });

      test("a handle closes after its transaction rejects too", async () => {
        let leaked: TxSql | undefined;
        await make([])
          .begin(async (tx) => {
            leaked = tx;
            throw new Error("boom");
          })
          .catch(() => undefined);
        expect(await messageOf(async () => (leaked as TxSql).unsafe("select 1"))).toBe(
          `${id}: this transaction has already settled — its handle can no longer be used`,
        );
      });

      test("a second savepoint while one is open is refused (E-TX-OVERLAP)", async () => {
        const calls: Call[] = [];
        const t = make(calls);
        await t.begin(async (tx) => {
          let release = () => {};
          const gate = new Promise<void>((r) => {
            release = r;
          });
          const first = tx.savepoint(() => gate);
          expect(await messageOf(() => tx.savepoint(async () => 1))).toBe(
            `${id}: a savepoint is already open on this transaction — await it before starting another`,
          );
          release();
          await first;
          // Settled, so the next one is allowed, and a failed one frees the slot too.
          await tx
            .savepoint(async () => {
              throw new Error("boom");
            })
            .catch(() => undefined);
          expect(await tx.savepoint(async () => "again")).toBe("again");
        });
        const entered = calls.filter(
          ([c]) => c.endsWith(".savepoint") || c === "db.tx.transaction",
        );
        expect(entered).toHaveLength(3);
      });

      test("savepoints on different handles do not block each other", async () => {
        await make([]).begin(async (tx) => {
          await tx.savepoint(async (sp) => {
            // The outer handle's savepoint is open; the inner handle has its own slot.
            expect(await sp.savepoint(async () => "inner")).toBe("inner");
          });
        });
      });

      test("a server error fn caught still rejects begin and the savepoint", async () => {
        const t = make([]);
        const swallow = (q: TxSql) => q.unsafe(FAIL).catch(() => undefined);
        expect(
          await t
            .begin(async (tx) => {
              await swallow(tx);
              return "resolved";
            })
            .catch((err: unknown) => err),
        ).toBe(serverError);
        // A savepoint that caught its own server error rejects with it, and the
        // transaction that caught the savepoint's rejection commits.
        let fromSavepoint: unknown;
        const value = await t.begin(async (tx) => {
          fromSavepoint = await tx.savepoint(swallow).catch((err: unknown) => err);
          return "committed";
        });
        expect(fromSavepoint).toBe(serverError);
        expect(value).toBe("committed");
      });

      test("an error with no SQLSTATE that fn caught does not reject begin", async () => {
        const t = make([]);
        const value = await t.begin(async (tx) => {
          expect(await messageOf(() => tx.unsafe(REFUSE))).toBe(REFUSE);
          expect(await tx.savepoint((sp) => sp.unsafe(REFUSE).catch(() => "sp"))).toBe("sp");
          return "committed";
        });
        expect(value).toBe("committed");
      });

      test("a nested savepoint wraps the savepoint's own native object", async () => {
        const calls: Call[] = [];
        const natives: unknown[] = [];
        await make(calls).begin(async (tx) => {
          await tx.savepoint((sp, spNative) => {
            natives.push(spNative);
            return sp.savepoint(async (inner, innerNative) => {
              natives.push(innerNative);
              await inner`select ${1}`;
            });
          });
        });
        const expected =
          id === "drizzle"
            ? ["db.transaction", "db.tx.transaction", "db.tx.tx.transaction", "db.tx.tx.tx.execute"]
            : ["db.begin", "db.tx.savepoint", "db.tx.sp.savepoint", "db.tx.sp.sp.tag"];
        expect(calls.map(([c]) => c)).toEqual(expected);
        expect(natives).toEqual([calls[1]?.[1], calls[2]?.[1]]);
        expect(natives[0]).toBe(calls[1]?.[1]);
        expect(natives[1]).toBe(calls[2]?.[1]);
      });
    });
  }
});

describe("postgres-js and bun-sql", () => {
  for (const [id, make] of FACTORIES.slice(0, 2)) {
    const over = id === "postgres-js" ? postgresJsTransactor : bunSqlTransactor;
    test(`${id}: queries return the driver's own promise and pass arguments through`, async () => {
      const calls: Call[] = [];
      const client = tagDouble("db", calls);
      const t = over(client);
      expect(t.sql`select ${1}, ${"x"}`).toBe(client.result);
      expect(t.sql.unsafe("select $1", [2])).toBe(client.result);
      expect(t.sql.unsafe("select 1")).toBe(client.result);
      expect(calls).toEqual([
        ["db.tag", ["select ", ", ", ""], 1, "x"],
        ["db.unsafe", "select $1", [2]],
        ["db.unsafe", "select 1", undefined],
      ]);
    });

    test(`${id}: savepoint-partial-rollback goes through the native savepoint`, async () => {
      const calls: Call[] = [];
      const t = make(calls);
      await t.begin((tx: TxSql) => tx.savepoint(async (sp) => sp.unsafe("select 1")));
      expect(calls.map(([c]) => c)).toEqual(["db.begin", "db.tx.savepoint", "db.tx.sp.unsafe"]);
    });
  }
});

describe("drizzleTransactor", () => {
  const make = (out?: { result: unknown }) => {
    const calls: Call[] = [];
    const t = drizzleTransactor(drizzleDouble("db", calls, out), { sql: drizzleSqlDouble });
    const executed = () => calls.filter(([c]) => c.endsWith("execute")).map(([, q]) => q);
    return { t, calls, executed };
  };

  test("the tag executes the consumer's sql tag over the same pieces and values", async () => {
    const { t, executed } = make();
    expect(await t.sql`select ${1}::int, ${"a"}::text`).toEqual([{ from: "db" }]);
    const [query] = executed() as { strings: TemplateStringsArray; values: unknown[] }[];
    expect([...(query?.strings ?? [])]).toEqual(["select ", "::int, ", "::text"]);
    expect(query?.values).toEqual([1, "a"]);
  });

  test("unsafe with no params, or empty params, executes raw text", async () => {
    const { t, executed } = make();
    await t.sql.unsafe("select 1");
    await t.sql.unsafe("select 2", []);
    expect(executed()).toEqual([{ raw: "select 1" }, { raw: "select 2" }]);
  });

  test("unsafe with params maps each placeholder occurrence, in order", async () => {
    const { t, executed } = make();
    const params = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];
    await t.sql.unsafe(
      "select $2::text, $1::text, $2::text, $10::text, $3, $4, $5, $6, $7, $8, $9",
      params,
    );
    const [query] = executed() as { strings: TemplateStringsArray; values: unknown[] }[];
    expect(query?.values).toEqual([
      "p2",
      "p1",
      "p2",
      "p10",
      "p3",
      "p4",
      "p5",
      "p6",
      "p7",
      "p8",
      "p9",
    ]);
    const strings = query?.strings as TemplateStringsArray;
    expect([...strings]).toEqual([
      "select ",
      "::text, ",
      "::text, ",
      "::text, ",
      "::text, ",
      ", ",
      ", ",
      ", ",
      ", ",
      ", ",
      ", ",
      "",
    ]);
    expect([...strings.raw]).toEqual([...strings]);
    expect(Object.isFrozen(strings)).toBe(true);
    expect(Object.isFrozen(strings.raw)).toBe(true);
  });

  test("unsafe refuses a placeholder past the parameters (E-DRZ-PARAM)", async () => {
    const { t, executed } = make();
    expect(await messageOf(() => t.sql.unsafe("select $1, $3", [1, 2]))).toBe(
      "drizzleTransactor: unsafe() query references $3 but 2 parameter(s) were passed",
    );
    expect(executed()).toEqual([]);
  });

  test("an undefined value is refused before sending, in the tag and in unsafe", async () => {
    const { t, executed } = make();
    expect(await messageOf(() => t.sql`select ${1}::int, ${undefined}::int`)).toBe(
      "drizzleTransactor: value 2 is undefined — bind null instead",
    );
    expect(await messageOf(() => t.sql.unsafe("select $1::int", [undefined]))).toBe(
      "drizzleTransactor: value 1 is undefined — bind null instead",
    );
    expect(await messageOf(() => t.begin((tx) => tx`select ${undefined}::int`))).toBe(
      "drizzleTransactor: value 1 is undefined — bind null instead",
    );
    // A hole in a sparse array reads as undefined too.
    const sparse: unknown[] = [];
    sparse[1] = 2;
    expect(await messageOf(() => t.sql.unsafe("select $1::int, $2::int", sparse))).toBe(
      "drizzleTransactor: value 1 is undefined — bind null instead",
    );
    expect(executed()).toEqual([]);
    await t.sql.unsafe("select $1::int", [null]);
    expect(executed()).toHaveLength(1);
  });

  test("a value that is not a bindable scalar is refused before sending", async () => {
    const { t, executed } = make();
    const sqlObject = { getSQL: () => ({}) };
    for (const [value, kind] of [
      [[1, 2], "array"],
      [sqlObject, "sql"],
      [{ a: 1 }, "object"],
      [Symbol("s"), "symbol"],
      [() => 1, "function"],
    ] as const) {
      const expected = `drizzleTransactor: value 2 is not a bindable scalar — got ${kind}`;
      expect(await messageOf(() => t.sql`select ${1}, ${value}`)).toBe(expected);
      expect(await messageOf(() => t.sql.unsafe("select $1, $2", [1, value]))).toBe(expected);
      expect(await messageOf(() => t.begin((tx) => tx`select ${1}, ${value}`))).toBe(expected);
    }
    expect(executed()).toEqual([]);
    const at = new Date(0);
    await t.sql`select ${"s"}, ${1}, ${true}, ${2n}, ${null}, ${at}`;
    expect(executed()).toHaveLength(1);
  });

  test("unsafe-unused-param", async () => {
    const { t, executed } = make();
    expect(
      await messageOf(() => t.sql.unsafe("select $1::int as a, $3::int as c", [1, 2, 3])),
    ).toBe("drizzleTransactor: unsafe() parameter 2 is never referenced in the query");
    expect(executed()).toEqual([]);
  });

  for (const [result, kind] of [
    [undefined, "undefined"],
    [3, "number"],
    [{ rows: [] }, "an object without rows"],
    [null, "object"],
  ] as const) {
    test(`an execute result of ${JSON.stringify(result) ?? "undefined"} is refused (E-DRZ-ARRAY)`, async () => {
      const { t } = make({ result });
      const expected = `drizzleTransactor: execute() returned ${kind}, not an array of rows — only drivers whose execute() resolves to a row array are supported`;
      expect(await messageOf(() => t.sql`select 1`)).toBe(expected);
      expect(await messageOf(() => t.begin((tx) => tx.unsafe("select 1")))).toBe(expected);
    });
  }

  test("a transaction's queries run on the transaction, and a savepoint is its nested transaction", async () => {
    const { t, calls } = make();
    await t.begin(async (tx) => {
      await tx`select ${1}`;
      await tx.savepoint((sp) => sp.unsafe("select 2"));
    });
    expect(calls.map(([c]) => c)).toEqual([
      "db.transaction",
      "db.tx.execute",
      "db.tx.transaction",
      "db.tx.tx.execute",
    ]);
  });
});
