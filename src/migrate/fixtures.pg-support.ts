import type { Sql } from "../db/index.ts";
import { sha256Hex } from "../hash/index.ts";
import type { MigrationKind } from "./marker.ts";
import type { SourceMigration } from "./sources.ts";

/**
 * Throwaway schema names for one DB suite (`<prefix>_<hex>`), and the drop
 * that removes every one of them when the suite ends.
 */
export function schemaFactory(prefix: string): {
  schema: () => string;
  dropAll: (sql: Sql) => Promise<void>;
} {
  const made: string[] = [];
  return {
    schema() {
      const s = `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
      made.push(s);
      return s;
    },
    async dropAll(sql) {
      if (made.length === 0) return;
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${made.map((s) => `"${s}"`).join(", ")} CASCADE`);
    },
  };
}

/** A synthetic migration of one statement. */
export function mig(
  source: string,
  id: string,
  key: string,
  text: string,
  kind: MigrationKind | null = "additive",
): SourceMigration {
  return Object.freeze({
    source,
    id,
    key,
    sha256: sha256Hex(text),
    kind,
    baselined: false,
    statements: Object.freeze([text]),
  });
}
