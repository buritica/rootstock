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

// The runner gives each kind its own database, so no kind sees another's leftovers.
test("each kind runs in its own database", async () => {
  const c = openTestClient();
  try {
    expect(await rows(c, "select current_database() as db")).toEqual([
      { db: `rs_${c.kind.replaceAll("-", "_")}` },
    ]);
  } finally {
    await c.close();
  }
});

test("close() resolves and ends the backend", async () => {
  const c = openTestClient();
  const watcher = openSecondClient();
  try {
    await rows(watcher, "select 1");
    const [row] = (await rows(c, "select pg_backend_pid() as pid")) as { pid: number }[];
    expect(await c.close()).toBeUndefined();
    const alive = async () =>
      (await rows(watcher, `select 1 from pg_stat_activity where pid = ${Number(row?.pid)}`))
        .length;
    // The backend exits asynchronously after the client disconnects.
    const deadline = performance.now() + 5_000;
    while ((await alive()) > 0 && performance.now() < deadline) await Bun.sleep(20);
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
