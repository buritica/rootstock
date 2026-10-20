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
  const profiles: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(config.client.profiles)) {
    profiles[name] = {
      connectTimeoutSeconds: p.connectTimeoutSeconds,
      idleTimeoutSeconds: p.idleTimeoutSeconds,
      keepAliveSeconds: p.keepAliveSeconds,
      max: p.max,
      maxCeiling: p.maxCeiling,
      maxLifetimeSeconds: p.maxLifetimeSeconds,
      prepare: p.prepare,
      readOnly: p.readOnly,
      statementTimeoutMs: p.statementTimeoutMs,
    };
  }
  const widths: Record<string, unknown> = {};
  for (const [name, w] of Object.entries(config.concurrency.widths)) {
    widths[name] = { default: w.default, max: w.max };
  }
  const view: Record<string, unknown> = {
    client: { profiles },
    concurrency: { widths },
    invariants: [...config.invariants],
    migrate: { ahead: config.migrate.ahead, schema: config.migrate.schema },
  };
  for (const name of ABSENT) view[name] = "absent";
  return `${canonicalJson(view, 2)}\n`;
}
