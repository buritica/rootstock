import type { Sql } from "../db/index.ts";
import { L7, L8 } from "./statements.ts";

/**
 * True unless `row` shows this session's backend (`expectedPid`) holding at
 * least one advisory lock. Written `!(… >= 1)` on purpose: a missing row, a
 * pid of another backend, and a `held` that reads as NaN all read as lost.
 */
export function lockOwnershipLost(
  row: { pid?: unknown; held?: unknown } | undefined,
  expectedPid: number,
): boolean {
  return !(Number(row?.pid) === expectedPid && Number(row?.held) >= 1);
}

/**
 * For each name, whether any session in this database holds its one-key
 * advisory lock. A read, so it takes no slice and refuses nothing. In input
 * order, each name once; an empty list sends no query.
 */
export async function locksHeld(
  sql: Sql,
  names: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const unique = [...new Set(names)];
  const held = new Map<string, boolean>();
  if (unique.length === 0) return held;
  const rows = await sql.unsafe<{ name: string; held: unknown }>(L7, [JSON.stringify(unique)]);
  const byName = new Map(rows.map((r) => [r.name, r.held === true]));
  for (const name of unique) held.set(name, byName.get(name) === true);
  return held;
}

/**
 * Every pair of distinct names whose `hashtext` keys are equal, computed on
 * the server, in input order. Two names that collide share one advisory lock.
 */
export async function lockNameCollisions(
  sql: Sql,
  names: readonly string[],
): Promise<readonly (readonly [string, string])[]> {
  if (names.length === 0) return Object.freeze([]);
  const rows = await sql.unsafe<{ a: string; b: string }>(L8, [JSON.stringify(names)]);
  return Object.freeze(rows.map((r) => Object.freeze([r.a, r.b] as const)));
}
