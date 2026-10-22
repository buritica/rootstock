import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import {
  bunSqlOptions,
  type ClientSlice,
  clientSlice,
  pgCode,
  postgresJsOptions,
  type Row,
  type Sql,
  type Transactor,
} from "./index.ts";
import { openSecond, openTestTransactor } from "./transactor.pg-support.ts";

// The transactor contract against a real Postgres, once per matrix kind
// (ROOTSTOCK_TEST_TRANSACTOR). Tables are synthetic `rs_t_<hex>` and each
// test drops what it creates.

async function withTransactor<T>(fn: (t: Transactor) => Promise<T>): Promise<T> {
  const { transactor, close } = openTestTransactor();
  try {
    return await fn(transactor);
  } finally {
    await close();
  }
}

async function withTable<T>(
  t: Transactor,
  columns: string,
  fn: (table: string) => Promise<T>,
): Promise<T> {
  const table = `rs_t_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await t.sql.unsafe(`create table ${table} (${columns})`);
  try {
    return await fn(table);
  } finally {
    await t.sql.unsafe(`drop table if exists ${table}`);
  }
}

async function ids(q: Sql, table: string): Promise<number[]> {
  const rows = await q.unsafe<{ id: number }>(`select id from ${table} order by id`);
  return rows.map((r) => r.id);
}

function insertId(q: Sql, table: string, v: number): Promise<unknown> {
  return q.unsafe(`insert into ${table} (id) values ($1)`, [v]);
}

/** A write through the driver's own transaction object, in that driver's own API. */
async function nativeInsert(id: Transactor["id"], native: unknown, table: string, v: number) {
  if (id === "drizzle") {
    const tx = native as { execute(q: unknown): Promise<unknown> };
    await tx.execute(drizzleSql`insert into ${drizzleSql.raw(table)} (id) values (${v})`);
    return;
  }
  const tx = native as { unsafe(q: string, p: unknown[]): Promise<unknown> };
  await tx.unsafe(`insert into ${table} (id) values ($1)`, [v]);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("query surface", () => {
  test("the tag binds values, and runs with none", async () => {
    await withTransactor(async (t) => {
      expect(await t.sql`select ${1}::int as a, ${"x"}::text as b`).toEqual([{ a: 1, b: "x" }]);
      expect(await t.sql`select 1::int as a`).toEqual([{ a: 1 }]);
      await t.begin(async (tx) => {
        expect(await tx`select 2::int as a`).toEqual([{ a: 2 }]);
        expect(await tx`select ${3}::int as a`).toEqual([{ a: 3 }]);
      });
    });
  });

  test("unsafe with params, without params, and with []", async () => {
    await withTransactor(async (t) => {
      expect(await t.sql.unsafe("select $1::int as a, $2::text as b", [2, "y"])).toEqual([
        { a: 2, b: "y" },
      ]);
      expect(await t.sql.unsafe("select 3 as a")).toEqual([{ a: 3 }]);
      expect(await t.sql.unsafe("select 4 as a", [])).toEqual([{ a: 4 }]);
    });
  });

  // Rule 8: never bind undefined. Each driver's own behavior is pinned here,
  // because only one of them stays silent.
  test("an undefined value: Bun.SQL binds NULL, the other two refuse", async () => {
    await withTransactor(async (t) => {
      const sent = t.sql.unsafe("select $1::int as a", [undefined]);
      if (t.id === "bun-sql") {
        expect(await sent).toEqual([{ a: null }]);
        return;
      }
      const err = (await rejection(sent)) as Error;
      if (t.id === "drizzle") {
        expect(err.message).toBe("drizzleTransactor: value 1 is undefined — bind null instead");
      } else {
        expect((err as Error & { code?: string }).code).toBe("UNDEFINED_VALUE");
      }
    });
  });

  test("the portable read types read as specified, on the root and in a transaction", async () => {
    const query = `select count(*)::int as n,
        (2::bigint ^ 40)::bigint::text as big,
        (extract(epoch from '2026-01-02T03:04:05.678Z'::timestamptz) * 1000)::bigint::text as ms,
        '{"a":[1,null,"x"]}'::jsonb::text as j
      from (values (1), (2)) v(x)`;
    await withTransactor(async (t) => {
      const check = (rows: Row[]) => {
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.n).toBe(2);
        expect(row?.big).toBe("1099511627776");
        expect(row?.ms).toBe("1767323045678");
        expect(typeof row?.j).toBe("string");
        expect(JSON.parse(String(row?.j))).toEqual({ a: [1, null, "x"] });
      };
      check(await t.sql.unsafe(query));
      await t.begin(async (tx) => check(await tx.unsafe(query)));
    });
  });
});

describe("begin", () => {
  test("returns the fn value", async () => {
    await withTransactor(async (t) => {
      expect(await t.begin(async () => 7)).toBe(7);
      expect(await t.begin(async () => ({ a: 1 }))).toEqual({ a: 1 });
      expect(await t.begin(async (tx) => tx`select ${5}::int as v`)).toEqual([{ v: 5 }]);
    });
  });

  test("commits when fn resolves, visible to another backend", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await t.begin(async (tx) => {
          await insertId(tx, table, 1);
        });
        const other = openSecond();
        try {
          expect(await ids(other.transactor.sql, table)).toEqual([1]);
        } finally {
          await other.close();
        }
      }),
    );
  });

  test("begin-rethrows-same-object: a throw rolls back and is rethrown as the same object", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const boom = new Error("boom");
        const caught = await rejection(
          t.begin(async (tx) => {
            await insertId(tx, table, 1);
            throw boom;
          }),
        );
        expect(caught).toBe(boom);
        expect(await ids(t.sql, table)).toEqual([]);
      }),
    );
  });

  test("savepoint-partial-rollback: a savepoint throw rolls back only the savepoint", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const insert = (q: Sql, v: number) => insertId(q, table, v);
        const boom = new Error("savepoint boom");
        await t.begin(async (tx) => {
          await insert(tx, 1);
          const caught = await rejection(
            tx.savepoint(async (sp) => {
              await insert(sp, 2);
              throw boom;
            }),
          );
          expect(caught).toBe(boom);
          await insert(tx, 3);
          expect(await ids(tx, table)).toEqual([1, 3]);
        });
        expect(await ids(t.sql, table)).toEqual([1, 3]);
      }),
    );
  });

  test("nested savepoints commit together, and an inner throw rolls back only the inner one", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const insert = (q: Sql, v: number) => insertId(q, table, v);
        const value = await t.begin((tx) =>
          tx.savepoint(async (outer) => {
            await insert(outer, 1);
            await outer.savepoint((inner) => insert(inner, 2));
            await rejection(
              outer.savepoint(async (inner) => {
                await insert(inner, 3);
                throw new Error("inner");
              }),
            );
            return "nested";
          }),
        );
        expect(value).toBe("nested");
        expect(await ids(t.sql, table)).toEqual([1, 2]);
      }),
    );
  });

  test("an overlapping savepoint is refused and the open one still commits", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await t.begin(async (tx) => {
          const { promise: gate, resolve: release } = Promise.withResolvers<void>();
          const first = tx.savepoint(async (sp) => {
            await insertId(sp, table, 1);
            await gate;
          });
          const refused = (await rejection(tx.savepoint((sp) => insertId(sp, table, 2)))) as Error;
          expect(refused.message).toBe(
            `${t.id}: a savepoint is already open on this transaction — await it before starting another`,
          );
          release();
          await first;
          await tx.savepoint((sp) => insertId(sp, table, 3));
        });
        expect(await ids(t.sql, table)).toEqual([1, 3]);
      }),
    );
  });

  test("a write on the outer handle while a savepoint is open is refused, and nothing is lost", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await t.begin(async (tx) => {
          const { promise: gate, resolve: release } = Promise.withResolvers<void>();
          const open = tx.savepoint(async (sp) => {
            await insertId(sp, table, 1);
            await gate;
          });
          const refused = (await rejection(insertId(tx, table, 2))) as Error;
          expect(refused.message).toBe(
            `${t.id}: a savepoint is open on this transaction — use the savepoint's handle until it settles`,
          );
          release();
          await open;
          await insertId(tx, table, 3);
        });
        expect(await ids(t.sql, table)).toEqual([1, 3]);
      }),
    );
  });

  test("a handle kept past its transaction is refused and writes nothing", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        let leaked: Sql | undefined;
        await t.begin(async (tx) => {
          leaked = tx;
          await insertId(tx, table, 1);
        });
        const refused = (await rejection(insertId(leaked as Sql, table, 2))) as Error;
        expect(refused.message).toBe(
          `${t.id}: this transaction has already settled — its handle can no longer be used`,
        );
        expect(await ids(t.sql, table)).toEqual([1]);
      }),
    );
  });

  test("a sibling query sent while the driver rolls back is refused and writes nothing", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const boom = new Error("boom");
        let sibling: Promise<unknown> | undefined;
        const err = await rejection(
          t.begin(async (tx) => {
            const failing = Promise.reject(boom);
            // The usual Promise.all shape: one branch fails, the other is
            // still going and writes as soon as it notices.
            sibling = (async () => {
              await failing.catch(() => undefined);
              for (let i = 0; i < 5; i++) await Promise.resolve();
              return insertId(tx, table, 2);
            })();
            await Promise.all([failing, sibling]);
          }),
        );
        expect(err).toBe(boom);
        const refused = (await rejection(sibling as Promise<unknown>)) as Error;
        expect(refused.message).toBe(
          `${t.id}: this transaction has already settled — its handle can no longer be used`,
        );
        expect(await ids(t.sql, table)).toEqual([]);
      }),
    );
  });

  for (const ending of ["returns", "throws"] as const) {
    test(`a savepoint outliving fn is refused, and its transaction waits for it and rolls back (fn ${ending})`, async () => {
      await withTransactor((t) =>
        withTable(t, "id int primary key", async (table) => {
          const { promise: gate, resolve: release } = Promise.withResolvers<void>();
          const { promise: started, resolve: start } = Promise.withResolvers<void>();
          let pending: Promise<unknown> | undefined;
          const done = t.begin(async (tx) => {
            await insertId(tx, table, 1);
            pending = tx.savepoint(async (sp) => {
              start();
              await gate;
              return insertId(sp, table, 2);
            });
            // fn may throw before the savepoint settles; nothing awaits it then.
            pending.catch(() => undefined);
            await started;
            if (ending === "throws") throw new Error("abort");
          });
          done.catch(() => undefined);
          // fn has settled with the savepoint open; let a turn pass first.
          await started;
          await new Promise((r) => setTimeout(r, 10));
          release();
          // The transaction waited for the savepoint, so its query was refused
          // and its ROLLBACK TO ran inside the transaction, before the exit.
          // The savepoint failed after fn settled, so the transaction rolls back.
          const closed = `${t.id}: this transaction has already settled — its handle can no longer be used`;
          const err = (await rejection(done)) as Error;
          expect(err.message).toBe(ending === "returns" ? closed : "abort");
          expect(((await rejection(pending as Promise<unknown>)) as Error).message).toBe(closed);
          await t.begin((tx) => insertId(tx, table, 3));
          expect(await ids(t.sql, table)).toEqual([3]);
        }),
      );
    });
  }

  test("a server error that lands after fn settled still rolls back and rejects begin", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await insertId(t.sql, table, 1);
        const err = await rejection(
          t.begin(async (tx) => {
            await insertId(tx, table, 2);
            // The slow failing insert loses the race and is still running.
            const slow = tx
              .unsafe(`insert into ${table} (id) select 1 from pg_sleep(0.05)`)
              .catch(() => "caught");
            await Promise.race([slow, Promise.resolve("first")]);
            return "resolved";
          }),
        );
        expect(pgCode(err)).toBe("23505");
        expect(await ids(t.sql, table)).toEqual([1]);
      }),
    );
  });

  test("a query nobody awaited runs, and begin waits for it and fails with it", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await t.begin(async (tx) => {
          void insertId(tx, table, 1);
          return "done";
        });
        expect(await ids(t.sql, table)).toEqual([1]);
        const err = await rejection(
          t.begin(async (tx) => {
            void insertId(tx, table, 1);
            return "resolved";
          }),
        );
        expect(pgCode(err)).toBe("23505");
        expect(await ids(t.sql, table)).toEqual([1]);
      }),
    );
  });

  test("a query made in a transaction runs in it, whenever and however it is awaited", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        let leaked: Promise<unknown> | undefined;
        await rejection(
          t.begin(async (tx) => {
            leaked = insertId(tx, table, 7);
            throw new Error("abort");
          }),
        );
        // It ran inside the transaction, which rolled back; touching it
        // afterwards starts nothing.
        await leaked?.catch(() => undefined);
        await leaked?.finally(() => undefined);
        await leaked;
        expect(await ids(t.sql, table)).toEqual([]);
      }),
    );
  });

  test("a transaction that caught a savepoint server error commits", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const value = await t.begin(async (tx) => {
          await insertId(tx, table, 1);
          await tx
            .savepoint(async (sp) => {
              await sp.unsafe("select 1/0").catch(() => undefined);
              await sp.unsafe("select 1");
            })
            .catch(() => undefined);
          await insertId(tx, table, 2);
          return "committed";
        });
        expect(value).toBe("committed");
        expect(await ids(t.sql, table)).toEqual([1, 2]);
      }),
    );
  });

  test("an error a nested savepoint passed up does not fail the transaction that caught it", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const value = await t.begin(async (tx) => {
          await insertId(tx, table, 1);
          // The inner savepoint fails with an error the middle one's handle
          // never saw; the middle one rethrows it and rolls back cleanly.
          await tx
            .savepoint((sp) =>
              sp.savepoint(async (inner) => {
                await inner.unsafe("select 1/0").catch(() => undefined);
                await inner.unsafe("select 1");
              }),
            )
            .catch(() => undefined);
          await insertId(tx, table, 2);
          return "committed";
        });
        expect(value).toBe("committed");
        expect(await ids(t.sql, table)).toEqual([1, 2]);
      }),
    );
  });

  test("a native error caught in a savepoint: postgres.js and drizzle commit, Bun.SQL's RELEASE fails", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const outcome = await t
          .begin(async (tx) => {
            await insertId(tx, table, 1);
            await tx
              .savepoint(async (_sp, native) => {
                await nativeInsert(t.id, native, table, 1).catch(() => undefined);
              })
              .catch(() => undefined);
            await insertId(tx, table, 2).catch(() => undefined);
            return "committed";
          })
          .catch((e: unknown) => pgCode(e));
        if (t.id === "bun-sql") {
          expect(outcome).toBe("25P02");
          expect(await ids(t.sql, table)).toEqual([]);
        } else {
          expect(outcome).toBe("committed");
          expect(await ids(t.sql, table)).toEqual([1, 2]);
        }
      }),
    );
  });

  test("a nested savepoint's failed exit, caught in its parent savepoint, stays there", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const outcome = await t
          .begin(async (tx) => {
            await insertId(tx, table, 1);
            await tx
              .savepoint((mid) =>
                mid
                  .savepoint(async (_sp, native) => {
                    // Caught natively: Bun.SQL's RELEASE then fails with 25P02.
                    await nativeInsert(t.id, native, table, 1).catch(() => undefined);
                  })
                  .catch(() => undefined),
              )
              .catch(() => undefined);
            await insertId(tx, table, 2);
            return "committed";
          })
          .catch((e: unknown) => pgCode(e));
        // The middle savepoint's ROLLBACK TO recovered the transaction.
        expect(outcome).toBe("committed");
        expect(await ids(t.sql, table)).toEqual([1, 2]);
      }),
    );
  });

  test("a server error fn caught still rolls back and rejects begin, on every driver", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await insertId(t.sql, table, 1);
        let swallowed: unknown;
        const err = await rejection(
          t.begin(async (tx) => {
            await insertId(tx, table, 2);
            swallowed = await rejection(insertId(tx, table, 1));
            return "resolved";
          }),
        );
        expect(err).toBe(swallowed);
        expect(pgCode(err)).toBe("23505");
        expect(await ids(t.sql, table)).toEqual([1]);
      }),
    );
  });

  test("a savepoint that caught a server error rejects with it, and the rest commits", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await t.begin(async (tx) => {
          await insertId(tx, table, 10);
          const err = await rejection(
            tx.savepoint(async (sp) => {
              await insertId(sp, table, 11);
              await rejection(insertId(sp, table, 10));
            }),
          );
          expect(pgCode(err)).toBe("23505");
          await insertId(tx, table, 12);
        });
        expect(await ids(t.sql, table)).toEqual([10, 12]);
      }),
    );
  });

  test("a statement timeout inside a savepoint rolls back only the savepoint and its setting", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await t.begin(async (tx) => {
          await insertId(tx, table, 1);
          const err = await rejection(
            tx.savepoint(async (sp) => {
              await sp.unsafe("set local statement_timeout = 50");
              await sp.unsafe("select pg_sleep(1)");
            }),
          );
          expect(pgCode(err)).toBe("57014");
          const [row] = await tx.unsafe<{ statement_timeout: string }>("show statement_timeout");
          expect(row?.statement_timeout).toBe("0");
          await insertId(tx, table, 2);
        });
        expect(await ids(t.sql, table)).toEqual([1, 2]);
      }),
    );
  });

  test("native is the driver's transaction: its write is visible to tx and rolled back with it", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const boom = new Error("rollback");
        const caught = await rejection(
          t.begin(async (tx, native) => {
            await nativeInsert(t.id, native, table, 41);
            expect(await ids(tx, table)).toEqual([41]);
            await tx.savepoint(async (sp, spNative) => {
              await nativeInsert(t.id, spNative, table, 42);
              expect(await ids(sp, table)).toEqual([41, 42]);
            });
            throw boom;
          }),
        );
        expect(caught).toBe(boom);
        expect(await ids(t.sql, table)).toEqual([]);
      }),
    );
  });
});

describe("the JSON list idiom", () => {
  const list = (v: unknown) => JSON.stringify(v);

  test("int and uuid lists filter with ANY, and the empty list matches nothing", async () => {
    await withTransactor(async (t) => {
      const ints = await t.sql<{ n: number }>`
        select n from generate_series(1, 6) n
        where n = any(select jsonb_array_elements_text((${list([2, 5])}::text)::jsonb)::int)
        order by n`;
      expect(ints.map((r) => r.n)).toEqual([2, 5]);
      const uuid = "00000000-0000-4000-8000-000000000001";
      const uuids = await t.sql<{ u: string }>`
        select u::text from (values (${uuid}::uuid), ('00000000-0000-4000-8000-000000000002'::uuid)) v(u)
        where u = any(select jsonb_array_elements_text((${list([uuid])}::text)::jsonb)::uuid)`;
      expect(uuids).toEqual([{ u: uuid }]);
      const none = await t.sql<{ n: number }>`
        select n from generate_series(1, 3) n
        where n = any(select jsonb_array_elements_text((${list([])}::text)::jsonb)::int)`;
      expect(none).toEqual([]);
    });
  });

  const TRICKY = ["a,b", "it's", 'say "hi"', "{x}", "back\\slash", "ñandú 雪 🦀", "", '""', "NULL"];

  test("tricky texts round-trip in order, through the tag, unsafe and a transaction", async () => {
    await withTransactor(async (t) => {
      const query =
        "select value, ord::int from jsonb_array_elements_text(($1::text)::jsonb) with ordinality as e(value, ord) order by ord";
      const expected = TRICKY.map((value, i) => ({ value, ord: i + 1 }));
      expect(
        await t.sql`select value, ord::int from jsonb_array_elements_text((${list(TRICKY)}::text)::jsonb)
          with ordinality as e(value, ord) order by ord`,
      ).toEqual(expected);
      expect(await t.sql.unsafe(query, [list(TRICKY)])).toEqual(expected);
      await t.begin(async (tx) => {
        expect(await tx.unsafe(query, [list(TRICKY)])).toEqual(expected);
      });
    });
  });

  test("5,000 items bind as one parameter", async () => {
    await withTransactor(async (t) => {
      const items = Array.from({ length: 5000 }, (_, i) => i + 1);
      const [row] = await t.sql<{ n: number; total: string }>`
        select count(*)::int as n, sum(v::int)::bigint::text as total
        from jsonb_array_elements_text((${list(items)}::text)::jsonb) as e(v)`;
      expect(row).toEqual({ n: 5000, total: "12502500" });
    });
  });

  test("a jsonb write with null stores the document, not a string", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key, doc jsonb not null", async (table) => {
        const doc = { a: null, b: [1, "x", null], c: "it's" };
        await t.sql.unsafe(`insert into ${table} (id, doc) values ($1, ($2::text)::jsonb)`, [
          1,
          list(doc),
        ]);
        const [row] = await t.sql.unsafe<{ kind: string; doc: string }>(
          `select jsonb_typeof(doc) as kind, doc::text as doc from ${table}`,
        );
        expect(row?.kind).toBe("object");
        expect(JSON.parse(String(row?.doc))).toEqual(doc);
      }),
    );
  });
});

describe("pgCode on real driver errors", () => {
  test("23505 for a unique violation, raw and wrapped", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        await insertId(t.sql, table, 1);
        const err = await rejection(insertId(t.sql, table, 1));
        expect(pgCode(err)).toBe("23505");
        expect(pgCode(new Error("x", { cause: err }))).toBe("23505");
      }),
    );
  });

  test("57014 for a statement-timeout cancel, raw and wrapped", async () => {
    await withTransactor(async (t) => {
      const err = await rejection(
        t.begin(async (tx) => {
          await tx.unsafe("set local statement_timeout = 50");
          await tx.unsafe("select pg_sleep(1)");
        }),
      );
      expect(pgCode(err)).toBe("57014");
      expect(pgCode(new Error("x", { cause: err }))).toBe("57014");
    });
  });

  test("25006 for a write in a read-only transaction", async () => {
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const err = await rejection(
          t.begin(async (tx) => {
            await tx.unsafe("set transaction read only");
            await insertId(tx, table, 1);
          }),
        );
        expect(pgCode(err)).toBe("25006");
        expect(pgCode(new Error("x", { cause: err }))).toBe("25006");
      }),
    );
  });
});

describe("rendered options, live", () => {
  const url = process.env.ROOTSTOCK_TEST_DATABASE_URL;
  if (url === undefined || url === "") {
    // Never let a driver fall back to ambient connection settings.
    throw new Error(
      "ROOTSTOCK_TEST_DATABASE_URL is not set — run DB suites through `bun run test:db`",
    );
  }
  const profile = (statementTimeoutMs: number, readOnly: boolean): ClientSlice =>
    clientSlice({
      profiles: {
        app: {
          max: 1,
          maxCeiling: 1,
          idleTimeoutSeconds: "driver-default",
          maxLifetimeSeconds: "driver-default",
          connectTimeoutSeconds: "driver-default",
          prepare: "driver-default",
          keepAliveSeconds: "driver-default",
          statementTimeoutMs,
          readOnly,
        },
      },
    });

  test("bunSqlOptions: a 50ms statement timeout fires 57014, and readOnly gives 25006", async () => {
    const timed = new SQL({ url, ...bunSqlOptions(profile(50, false), "app") });
    try {
      expect(pgCode(await rejection(timed.unsafe("select pg_sleep(1)")))).toBe("57014");
    } finally {
      await timed.close();
    }
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const reader = new SQL({ url, ...bunSqlOptions(profile(0, true), "app") });
        try {
          const err = await rejection(reader.unsafe(`insert into ${table} (id) values (1)`));
          expect(pgCode(err)).toBe("25006");
        } finally {
          await reader.close();
        }
      }),
    );
  });

  test("postgresJsOptions: a 50ms statement timeout fires 57014, and readOnly gives 25006", async () => {
    const opts = (ms: number, ro: boolean) => ({
      ...postgresJsOptions(profile(ms, ro), "app"),
      onnotice: () => {},
    });
    const timed = postgres(url, opts(50, false));
    try {
      expect(pgCode(await rejection(timed.unsafe("select pg_sleep(1)")))).toBe("57014");
    } finally {
      await timed.end();
    }
    await withTransactor((t) =>
      withTable(t, "id int primary key", async (table) => {
        const reader = postgres(url, opts(0, true));
        try {
          const err = await rejection(reader.unsafe(`insert into ${table} (id) values (1)`));
          expect(pgCode(err)).toBe("25006");
        } finally {
          await reader.end();
        }
      }),
    );
  });
});
