import { q, type SliceRefusals, sliceRefusals } from "../internal/slice.ts";
import { fail, refusalCode } from "./errors.ts";
import { NAME_RULE } from "./marker.ts";
import type { MigrateSlice } from "./slice.ts";
import type { SourceMigration } from "./sources.ts";
import type { TrackedSource } from "./tracked.ts";
import { trackerName } from "./tracker-db.ts";

/**
 * Every refusal here carries a code, so the caller's `migrate.refused` sees it:
 * a shape refusal (not an array, a bad name, a bad tracker) keeps its parser
 * text and gains ERR_ROOTSTOCK_MIG_SRC.
 */
export function validateSources(caller: string, slice: MigrateSlice, sources: unknown): void {
  try {
    checkSources(sliceRefusals(caller), slice, sources);
  } catch (err) {
    if (err instanceof Error && refusalCode(err) === undefined)
      Object.assign(err, { code: "ERR_ROOTSTOCK_MIG_SRC" });
    throw err;
  }
}

function checkSources(refuseCall: SliceRefusals, slice: MigrateSlice, sources: unknown): void {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw refuseCall.invalid("sources", "a non-empty array", sources);
  }
  const first = sources[0] as Partial<TrackedSource> | undefined;
  if (first?.name !== "rootstock" || first.tracker?.kind !== "rootstock") {
    fail(
      `the first source must be rootstockSource(slice) — got ${q(first?.name)}`,
      "ERR_ROOTSTOCK_MIG_SRC_ORDER",
    );
  }
  const names = new Set<string>();
  const tables = new Set<string>();
  for (const [i, raw] of sources.entries()) {
    const src = refuseCall.record(`sources[${i}]`, raw) as unknown as TrackedSource;
    if (typeof src.name !== "string" || !NAME_RULE.test(src.name)) {
      throw refuseCall.invalid(`sources[${i}].name`, "a name matching [a-z][a-z0-9-]*", src.name);
    }
    if (names.has(src.name))
      fail(
        `source name ${q(src.name)} is used by more than one source`,
        "ERR_ROOTSTOCK_MIG_SRC_DUP",
      );
    names.add(src.name);
    if (i > 0 && src.tracker?.kind === "rootstock") {
      fail(
        `tracker ${q("rootstock")} is used by more than one source`,
        "ERR_ROOTSTOCK_MIG_SRC_DUP",
      );
    }
    const table = trackerName(src.tracker, slice);
    if (tables.has(table))
      fail(
        `tracker table ${q(table)} is used by more than one source`,
        "ERR_ROOTSTOCK_MIG_SRC_DUP",
      );
    tables.add(table);
    if (!Array.isArray(src.migrations)) {
      throw refuseCall.invalid(`sources[${i}].migrations`, "an array", src.migrations);
    }
    const stray = (src.migrations as readonly Partial<SourceMigration>[]).find(
      (m) => m?.source !== src.name,
    );
    if (stray !== undefined) {
      fail(
        `sources[${i}].migrations must all be source ${q(src.name)}'s — got ${q(stray?.id)} of source ${q(stray?.source)}`,
      );
    }
  }
}
