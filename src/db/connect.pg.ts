import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { openSecondClient, openTestClient, type TestClient } from "./test-client.pg-support.ts";

// The matrix's smoke suite: every transactor kind reaches the throwaway
// database through its raw driver, and closing the client resolves.

async function rows(c: TestClient, query: string): Promise<unknown[]> {
  switch (c.kind) {
    case "bun-sql":
      return [...(await c.client.unsafe(query))];
    case "postgres-js":
      return [...(await c.client.unsafe(query))];
    case "drizzle":
      return [...(await c.client.execute(sql.raw(query)))];
  }
}

test("select 1 through the raw client returns one row", async () => {
  const c = openTestClient();
  try {
    expect(await rows(c, "select 1 as one")).toEqual([{ one: 1 }]);
  } finally {
    await c.close();
  }
});

test("close() resolves and ends the backend", async () => {
  const c = openTestClient();
  const watcher = openSecondClient();
  try {
    const [row] = (await rows(c, "select pg_backend_pid() as pid")) as { pid: number }[];
    expect(await c.close()).toBeUndefined();
    const alive = async () =>
      (await rows(watcher, `select 1 from pg_stat_activity where pid = ${Number(row?.pid)}`))
        .length;
    for (let i = 0; i < 50 && (await alive()) > 0; i++) await Bun.sleep(20);
    expect(await alive()).toBe(0);
  } finally {
    await watcher.close();
  }
});

test("the second client is an independent backend", async () => {
  const a = openTestClient();
  const b = openSecondClient();
  try {
    const [pa] = (await rows(a, "select pg_backend_pid() as pid")) as { pid: number }[];
    const [pb] = (await rows(b, "select pg_backend_pid() as pid")) as { pid: number }[];
    expect(typeof pa?.pid).toBe("number");
    expect(pa?.pid).not.toBe(pb?.pid);
  } finally {
    await a.close();
    await b.close();
  }
});
