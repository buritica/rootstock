import { canonicalJson } from "../golden/canonical.ts";
import { isRootstockConfig, type RootstockConfig } from "./define.ts";

// Slices later stages add. Each prints as "absent" until its stage lands, so
// a config golden shows what a repo has not adopted yet.
const ABSENT = ["embed", "lock", "queue", "runner"] as const;

/**
 * The config as canonical JSON, every field spelled out, for a repo to pin
 * as its config golden. No version field: a patch release must not move it.
 */
export function printRootstockConfig(config: RootstockConfig): string {
  if (!isRootstockConfig(config)) {
    throw new Error(
      "printRootstockConfig: expected a RootstockConfig built by defineRootstockConfig() — got an object that parser did not return",
    );
  }
  // The slices are frozen plain data, so they print as they are: a field a
  // slice gains later shows up in every config golden without an edit here.
  const view: Record<string, unknown> = {
    client: config.client,
    concurrency: config.concurrency,
    invariants: config.invariants,
    migrate: config.migrate,
  };
  for (const name of ABSENT) view[name] = "absent";
  return `${canonicalJson(view, 2)}\n`;
}
