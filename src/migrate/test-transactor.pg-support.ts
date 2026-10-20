import { sql as drizzleSql } from "drizzle-orm";
import { openSecondClient, openTestClient, type TestClient } from "../db/test-client.pg-support.ts";
import type { Sql, Transactor, TxSql } from "./db-surface.ts";

/**
 * A stand-in for `db`'s `openTestTransactor()` / `openSecond()` until that
 * packet lands: the same `{ transactor, close }` shape over the same `max: 1`
 * raw clients, wrapped to the frozen `Transactor` contract and nothing more.
 * Once `src/db/transactor.pg-support.ts` exists the suites import it instead
 * and this file is deleted.
 */

// biome-ignore lint/suspicious/noExplicitAny: structural driver surface
type Native = any;

export interface TestTransactor {
  transactor: Transactor;
  close: () => Promise<void>;
}

function viaDriver(native: Native): Sql {
  const call = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    native(strings, ...values);
  call.unsafe = (query: string, params?: readonly unknown[]) =>
    native.unsafe(query, params === undefined ? undefined : [...params]);
  return call as Sql;
}

function driverTx(native: Native): TxSql {
  const tx = viaDriver(native) as TxSql;
  tx.savepoint = (fn) => native.savepoint((sp: Native) => fn(driverTx(sp), sp));
  return Object.freeze(tx);
}

async function rows(result: Promise<unknown>): Promise<never[]> {
  const r = await result;
  if (!Array.isArray(r)) throw new Error("drizzle execute() did not return a row array");
  return r as never[];
}

function viaDrizzle(x: Native): Sql {
  const call = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    rows(x.execute(drizzleSql(strings, ...values)));
  call.unsafe = (query: string, params?: readonly unknown[]) => {
    if (params === undefined || params.length === 0) return rows(x.execute(drizzleSql.raw(query)));
    const parts = query.split(/\$([1-9][0-9]*)/);
    const texts = parts.filter((_, i) => i % 2 === 0);
    const values = parts.filter((_, i) => i % 2 === 1).map((n) => params[Number(n) - 1]);
    const strings = Object.assign([...texts], { raw: [...texts] }) as TemplateStringsArray;
    return rows(x.execute(drizzleSql(strings, ...values)));
  };
  return call as Sql;
}

function drizzleTx(native: Native): TxSql {
  const tx = viaDrizzle(native) as TxSql;
  tx.savepoint = (fn) => native.transaction((sp: Native) => fn(drizzleTx(sp), sp));
  return Object.freeze(tx);
}

function wrap(c: TestClient): TestTransactor {
  const client: Native = c.client;
  const drizzle = c.kind === "drizzle";
  const transactor: Transactor = Object.freeze({
    id: c.kind,
    sql: drizzle ? viaDrizzle(client) : viaDriver(client),
    begin: <T>(fn: (tx: TxSql, native: unknown) => Promise<T>): Promise<T> =>
      drizzle
        ? client.transaction((t: Native) => fn(drizzleTx(t), t))
        : client.begin((t: Native) => fn(driverTx(t), t)),
  });
  return { transactor, close: c.close };
}

export function openTestTransactor(): TestTransactor {
  return wrap(openTestClient());
}

export function openSecond(): TestTransactor {
  return wrap(openSecondClient());
}
