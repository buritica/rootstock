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
// What Postgres answers every query with once the transaction is aborted.
const abortedError = Object.assign(new Error("in failed sql transaction"), { code: "25P02" });
const FAIL_ABORTED = "select after failure";
// A client-side refusal: no SQLSTATE, nothing reached the server.
const REFUSE = "refused before sending";

// `hold`, when given, keeps the driver's begin or savepoint from settling
// after fn settles, as a COMMIT or ROLLBACK round trip does.
function tagDouble(name: string, calls: Call[], hold?: Promise<void>) {
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
      if (query === FAIL_ABORTED) return Promise.reject(abortedError);
      return query === FAIL ? Promise.reject(serverError) : result;
    },
    savepoint: async (fn: (sp: unknown) => unknown) => {
      const sp = tagDouble(`${name}.sp`, calls, hold);
      calls.push([`${name}.savepoint`, sp]);
      try {
        return await fn(sp);
      } finally {
        await hold;
      }
    },
    begin: async (fn: (tx: unknown) => unknown) => {
      const tx = tagDouble(`${name}.tx`, calls, hold);
      calls.push([`${name}.begin`, tx]);
      try {
        return await fn(tx);
      } finally {
        await hold;
      }
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
  hold?: Promise<void>,
) {
  return {
    execute: async (query: unknown) => {
      calls.push([`${name}.execute`, query]);
      if ((query as { raw?: string }).raw === FAIL) throw serverError;
      if ((query as { raw?: string }).raw === FAIL_ABORTED) throw abortedError;
      if ((query as { raw?: string }).raw === REFUSE) throw new Error(REFUSE);
      return out.result;
    },
    transaction: async (fn: (tx: unknown) => unknown) => {
      const tx = drizzleDouble(`${name}.tx`, calls, out, hold);
      calls.push([`${name}.transaction`, tx]);
      try {
        return await fn(tx);
      } finally {
        await hold;
      }
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
  [
    "postgres-js",
    (calls: Call[], hold?: Promise<void>) => postgresJsTransactor(tagDouble("db", calls, hold)),
  ],
  [
    "bun-sql",
    (calls: Call[], hold?: Promise<void>) => bunSqlTransactor(tagDouble("db", calls, hold)),
  ],
  [
    "drizzle",
    (calls: Call[], hold?: Promise<void>) =>
      drizzleTransactor(drizzleDouble("db", calls, undefined, hold), { sql: drizzleSqlDouble }),
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

      test("a savepoint left running when its transaction settles is closed with it", async () => {
        const calls: Call[] = [];
        const t = make(calls);
        const closed = `${id}: this transaction has already settled — its handle can no longer be used`;
        const { promise: gate, resolve: release } = Promise.withResolvers<void>();
        let pending: Promise<unknown> | undefined;
        let deep: Promise<unknown> | undefined;
        let leaked: TxSql | undefined;
        const done = t.begin(async (tx) => {
          leaked = tx;
          // Not awaited: fn settles while the savepoints wait.
          pending = tx.savepoint(async (sp) => {
            // Two levels down: the middle savepoint is still open when the
            // transaction settles, so only a walk to the top closes this one.
            deep = sp.savepoint(async (sp2) => {
              await gate;
              return sp2.unsafe("select 2");
            });
            await gate;
            return sp.unsafe("select 1");
          });
        });
        let committed = false;
        void done.then(() => {
          committed = true;
        });
        await new Promise((r) => setTimeout(r, 0));
        // The transaction waits for its savepoints rather than exiting under them.
        expect(committed).toBe(false);
        // Closed and busy at once: closed wins, since no handle here is usable.
        expect(await messageOf(async () => (leaked as TxSql).unsafe("select 0"))).toBe(closed);
        expect(await messageOf(async () => (leaked as TxSql).savepoint(async () => 0))).toBe(
          closed,
        );
        release();
        expect(await messageOf(async () => pending)).toBe(closed);
        expect(await messageOf(async () => deep)).toBe(closed);
        await done;
        // Only the begin and savepoint entries reached the driver; no query did.
        expect(calls.filter(([c]) => /unsafe|execute|tag$/.test(c))).toEqual([]);
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

      test("a query racing the driver's COMMIT or ROLLBACK is refused", async () => {
        const calls: Call[] = [];
        const { promise: hold, resolve: letGo } = Promise.withResolvers<void>();
        const t = make(calls, hold);
        const closed = `${id}: this transaction has already settled — its handle can no longer be used`;
        const turn = () => new Promise((r) => setTimeout(r, 0));
        let leaked: TxSql | undefined;
        const rolledBack = t.begin(async (h) => {
          leaked = h;
          throw new Error("boom");
        });
        const committed = t.begin(async (tx) => {
          let sp: TxSql | undefined;
          const open = tx.savepoint(async (s) => {
            sp = s;
          });
          // Both fns have settled; neither driver call has.
          await turn();
          const before = calls.length;
          expect(await messageOf(async () => (sp as TxSql).unsafe("select 1"))).toBe(closed);
          expect(await messageOf(async () => (leaked as TxSql)`select ${1}`)).toBe(closed);
          expect(calls).toHaveLength(before);
          letGo();
          await open;
          return "done";
        });
        expect(await committed).toBe("done");
        expect(await messageOf(() => rolledBack)).toBe("boom");
      });

      test("a second savepoint while one is open is refused (E-TX-OVERLAP)", async () => {
        const calls: Call[] = [];
        const t = make(calls);
        await t.begin(async (tx) => {
          const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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

      test("a query on the outer handle while its savepoint is open is refused (E-TX-BUSY)", async () => {
        const calls: Call[] = [];
        const t = make(calls);
        const busy = `${id}: a savepoint is open on this transaction — use the savepoint's handle until it settles`;
        await t.begin(async (tx) => {
          const { promise: gate, resolve: release } = Promise.withResolvers<void>();
          const open = tx.savepoint(async (sp) => {
            await gate;
            return sp.unsafe("select 2");
          });
          const before = calls.length;
          expect(await messageOf(() => tx`select ${1}`)).toBe(busy);
          expect(await messageOf(() => tx.unsafe("select 1"))).toBe(busy);
          expect(calls).toHaveLength(before);
          release();
          await open;
          await tx.unsafe("select 3");
        });
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

      test("a failing query nobody awaits fails begin and is not reported unhandled", async () => {
        const err = await make([])
          .begin(async (tx) => {
            void tx.unsafe(FAIL);
            // fn keeps running after the failure lands.
            await new Promise((r) => setTimeout(r, 10));
            return "resolved";
          })
          .catch((e: unknown) => e);
        expect(err).toBe(serverError);
      });

      test("begin rejects with the first server error fn caught, not the last", async () => {
        const t = make([]);
        expect(
          await t
            .begin(async (tx) => {
              await tx.unsafe(FAIL).catch(() => undefined);
              await tx.unsafe(FAIL_ABORTED).catch(() => undefined);
              return "resolved";
            })
            .catch((err: unknown) => err),
        ).toBe(serverError);
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

describe("a driver entry that throws instead of rejecting", () => {
  test("savepoint rejects, and the outer handle stays usable", async () => {
    const calls: Call[] = [];
    const client = tagDouble("db", calls);
    const broken = Object.assign(client, {
      begin: async (fn: (tx: unknown) => unknown) =>
        fn(
          Object.assign(tagDouble("db.tx", calls), {
            savepoint: () => {
              throw new TypeError("no savepoint here");
            },
          }),
        ),
    });
    const value = await postgresJsTransactor(broken).begin(async (tx) => {
      let threw = false;
      const result = (() => {
        try {
          return tx.savepoint(async () => 1);
        } catch {
          threw = true;
          return undefined;
        }
      })();
      expect(threw).toBe(false);
      expect(await messageOf(async () => result)).toBe("no savepoint here");
      await tx.unsafe("select 1");
      return "committed";
    });
    expect(value).toBe("committed");
  });

  test("a savepoint whose own exit statement failed rejects begin", async () => {
    const exitError = Object.assign(new Error("release failed"), { code: "25P02" });
    const client = Object.assign(tagDouble("db", []), {
      begin: async (fn: (tx: unknown) => unknown) =>
        fn(
          Object.assign(tagDouble("db.tx", []), {
            savepoint: async (cb: (sp: unknown) => unknown) => {
              await cb(tagDouble("db.tx.sp", []));
              throw exitError;
            },
          }),
        ),
    });
    const err = await postgresJsTransactor(client)
      .begin(async (tx) => {
        await tx.savepoint(async () => 1).catch(() => undefined);
        return "resolved";
      })
      .catch((e: unknown) => e);
    expect(err).toBe(exitError);
  });

  test("a savepoint rejection no exit statement produces does not fail the parent", async () => {
    const replayed = Object.assign(new Error("replayed"), { code: "23505" });
    const client = Object.assign(tagDouble("db", []), {
      begin: async (fn: (tx: unknown) => unknown) =>
        fn(
          Object.assign(tagDouble("db.tx", []), {
            savepoint: async (cb: (sp: unknown) => unknown) => {
              await cb(tagDouble("db.tx.sp", []));
              throw replayed;
            },
          }),
        ),
    });
    const value = await postgresJsTransactor(client).begin(async (tx) => {
      await tx.savepoint(async () => 1).catch(() => undefined);
      return "committed";
    });
    expect(value).toBe("committed");
  });

  test("begin rejects instead of throwing", async () => {
    const client = Object.assign(tagDouble("db", []), {
      begin: () => {
        throw new TypeError("no begin here");
      },
    });
    const t = postgresJsTransactor(client);
    let threw = false;
    let result: Promise<unknown> | undefined;
    try {
      result = t.begin(async () => 1);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(await messageOf(async () => result)).toBe("no begin here");
  });
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
    // Numbered by parameter, not by where the placeholder sits in the text.
    expect(await messageOf(() => t.sql.unsafe("select $2::int, $1::int", [undefined, 1]))).toBe(
      "drizzleTransactor: value 1 is undefined — bind null instead",
    );
    expect(await messageOf(() => t.sql.unsafe("select $1::int, $1::int", [undefined]))).toBe(
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
