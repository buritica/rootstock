import type { Transactor } from "../db/index.ts";
import {
  type ApplyResult,
  applyMigrations,
  type Backup,
  type Entry,
  type MigrateEvent,
  type MigrationPlan,
} from "./applier.ts";
import { reason, refusalCode } from "./errors.ts";
import type { MigrateSlice } from "./slice.ts";
import { ids, migrationStatus, renderMigrationStatus } from "./status.ts";
import type { TrackedSource } from "./tracked.ts";

export interface MigrateCliDeps {
  readonly transactor: Transactor;
  readonly slice: MigrateSlice;
  readonly sources: readonly TrackedSource[];
  readonly backup: Backup;
  /** The repo's real manual-apply command, printed as the remedy. */
  readonly fix: string;
  /** Receives each output line, without its newline. */
  readonly out: (line: string) => void;
  readonly onEvent?: (e: MigrateEvent) => void;
}

export const MIGRATE_USAGE =
  "usage: migrate status | plan [--deploy] | apply --deploy | apply --manual [--allow-heavy]";

type Command =
  | { readonly kind: "status" }
  | { readonly kind: "plan"; readonly entry: Entry }
  | { readonly kind: "apply"; readonly entry: Entry; readonly allowHeavy: boolean };

const FLAGS: Readonly<Record<string, readonly string[]>> = {
  status: [],
  plan: ["--deploy"],
  apply: ["--deploy", "--manual", "--allow-heavy"],
};

function parse(argv: readonly string[]): Command | undefined {
  const [verb = "", ...flags] = argv;
  const allowed = Object.hasOwn(FLAGS, verb) ? FLAGS[verb] : undefined;
  if (allowed === undefined || new Set(flags).size !== flags.length) return undefined;
  if (!flags.every((f) => allowed.includes(f))) return undefined;
  const has = (f: string): boolean => flags.includes(f);
  if (verb === "status") return { kind: "status" };
  if (verb === "plan") return { kind: "plan", entry: has("--deploy") ? "deploy" : "manual" };
  // apply: exactly one entry; --allow-heavy is manual's only.
  if (has("--deploy") === has("--manual") || (has("--allow-heavy") && !has("--manual")))
    return undefined;
  return {
    kind: "apply",
    entry: has("--deploy") ? "deploy" : "manual",
    allowHeavy: has("--allow-heavy"),
  };
}

function planLines(plan: MigrationPlan): string[] {
  const lines = [
    `plan (${plan.entry}): ${
      plan.apply.length === 0
        ? "nothing to apply"
        : `apply ${plan.apply.map((a) => `${a.source}/${a.id} (${a.kind ?? "unmarked"})`).join(", ")}`
    }`,
  ];
  if (plan.ahead.length > 0) lines.push(`ahead: ${ids(plan.ahead)}`);
  for (const a of plan.accepted) lines.push(`accepted: ${a.source}/${a.id} (${a.reason})`);
  return lines;
}

function resultLines(result: ApplyResult): string[] {
  const { bootstrap, plan } = result;
  // Each file was already printed as it was applied.
  const lines = [`done: ${result.applied.length} applied`];
  if (result.skippedConcurrent.length > 0)
    lines.push(`skipped, another applier ran them: ${ids(result.skippedConcurrent)}`);
  if (bootstrap.created.length > 0) lines.push(`trackers created: ${bootstrap.created.join(", ")}`);
  if (bootstrap.upgraded.length > 0)
    lines.push(`trackers upgraded: ${bootstrap.upgraded.join(", ")}`);
  if (bootstrap.stamped > 0) lines.push(`hashes stamped: ${bootstrap.stamped}`);
  if (plan.ahead.length > 0) lines.push(`ahead: ${ids(plan.ahead)}`);
  for (const a of plan.accepted) lines.push(`accepted: ${a.source}/${a.id} (${a.reason})`);
  return lines;
}

/** Fails fast on a caller bug, before any I/O: these are not exit codes. */
function checkDeps(deps: MigrateCliDeps): void {
  if (typeof deps?.out !== "function") throw new Error("migrateCli: deps.out must be a function");
  if (typeof deps.fix !== "string" || deps.fix.trim() === "")
    throw new Error("migrateCli: deps.fix must be the repo's real manual-apply command");
}

/**
 * One migrate command line for every app (contract §1.8). Exit codes:
 * - `status`: 0 green, 1 red, 2 when it could not answer. Any throw is 2,
 *   coded or not: a refusal from status (bad sources, a tracker it cannot
 *   read) is a broken setup, not drift, and must not send on-call to migrate.
 * - `plan`: writes nothing; 0, 1 on a migrate refusal (printed instead of the
 *   plan, which a refused run never computes), 2 on anything else.
 * - `apply`: 0, 1 on a migrate refusal; any other error is rethrown, so the
 *   process crashes non-zero with its stack. Under `process.exit(await ...)`
 *   that crash also exits 1: a caller that must tell the two apart catches it.
 * - An unknown argument prints usage and exits 2. A leading `--` is ignored.
 *
 * An app with two databases calls this once per database, prefixes `out` with
 * the database's name, and exits with the larger code; an apply that throws on
 * the first database never reaches the second.
 */
export async function migrateCli(
  argv: readonly string[],
  deps: MigrateCliDeps,
): Promise<0 | 1 | 2> {
  checkDeps(deps);
  const { out } = deps;
  const command = parse(argv[0] === "--" ? argv.slice(1) : argv);
  if (command === undefined) {
    out(MIGRATE_USAGE);
    return 2;
  }
  if (command.kind === "status") {
    let status: Awaited<ReturnType<typeof migrationStatus>>;
    try {
      status = await migrationStatus(deps.transactor.sql, deps.slice, deps.sources);
    } catch (err) {
      out(`status could not answer — ${reason(err)}`);
      return 2;
    }
    for (const line of renderMigrationStatus(status, { fix: deps.fix }).trimEnd().split("\n"))
      out(line);
    return status.red ? 1 : 0;
  }
  const opts = {
    entry: command.entry,
    backup: deps.backup,
    fix: deps.fix,
    ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
  };
  if (command.kind === "plan") {
    let result: ApplyResult;
    try {
      result = await applyMigrations(deps.transactor, deps.slice, deps.sources, {
        ...opts,
        planOnly: true,
      });
    } catch (err) {
      const coded = refusalCode(err) !== undefined;
      out(coded ? reason(err) : `plan could not answer — ${reason(err)}`);
      return coded ? 1 : 2;
    }
    for (const line of planLines(result.plan)) out(line);
    return 0;
  }
  let result: ApplyResult;
  try {
    result = await applyMigrations(deps.transactor, deps.slice, deps.sources, {
      ...opts,
      ...(command.allowHeavy ? { allowHeavy: true } : {}),
      // Each file commits on its own, so the log says so as it happens: a run
      // killed or refused after some files still shows which went in.
      onEvent: (e) => {
        if (e.type === "migrate.applying")
          out(`applying ${e.source}/${e.id} (${e.kind ?? "unmarked"})`);
        else if (e.type === "migrate.applied") out(`applied ${e.source}/${e.id} (${e.ms} ms)`);
        deps.onEvent?.(e);
      },
    });
  } catch (err) {
    // Redacted once here: a rethrown error's own text and stack are the driver's.
    out(reason(err));
    if (refusalCode(err) === undefined) throw err;
    return 1;
  }
  for (const line of resultLines(result)) out(line);
  return 0;
}
