import { q } from "../internal/slice.ts";
import { fail, failIo } from "./errors.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import { drizzleJournalAt, type SourceMigration, secondOf, sqlFolderAt } from "./sources.ts";
import type { TrackedSource } from "./tracked.ts";

export interface OrderFinding {
  source: string;
  id: string;
  problem:
    | "name"
    | "future-stamp"
    | "older-than-main"
    | "unmarked"
    | "edited-on-main"
    | "key-changed-on-main"
    | "accepted-unknown-id"
    | "accepted-current-mismatch";
}

/** The name rule for a migration added after D49; its time is checked by `secondOf`. */
const STAMPED_NAME = /^\d{14}_[a-z0-9_]+/;
const DAY_S = 86_400;

/** A drizzle key is its `when`, compared as an integer; any other key is a filename. */
function keyOrder(source: TrackedSource): (a: string, b: string) => number {
  if (source.tracker.kind === "drizzle") {
    return (a, b) => {
      const x = BigInt(a);
      const y = BigInt(b);
      return x < y ? -1 : x > y ? 1 : 0;
    };
  }
  return (a, b) => (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The PR-time order check: compares each app source with the same source on
 * main (`readMain`) and returns what would break a deploy or a re-run.
 *
 * - An id not on main must be named `YYYYMMDDHHMMSS_…` with a real UTC time at
 *   most a day after `now()`, sort after main's newest key, and carry a marker
 *   unless baselined. An id not on main whose key and hash are on main is a
 *   rename and is checked for its name only.
 * - An id on both sides must keep its key and its hash. A new id that keeps a
 *   main key with another hash is an edit of that file.
 * - Every `accepted` entry of a source checked here must name one of its
 *   migrations, whose hash must equal the entry's `current`.
 *
 * rootstock's own source (tracker kind "rootstock") is skipped: its files
 * live in the package, not on main. Sources are read from main in parallel. A `readMain` failure rejects the check; it never reads as no findings.
 */
export async function checkMigrationOrder(
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
  readMain: (source: string) => Promise<readonly SourceMigration[]>,
  now: () => Date,
): Promise<readonly OrderFinding[]> {
  assertMigrateSlice("checkMigrationOrder", slice);
  const nowMs = now().getTime();
  if (Number.isNaN(nowMs)) {
    throw new TypeError("checkMigrationOrder: now() returned an invalid Date");
  }
  const apps = sources.filter((s) => s.tracker.kind !== "rootstock");
  const mains = await Promise.all(apps.map((s) => readMain(s.name)));
  const findings = apps.flatMap((source, i) => [
    ...compare(source, mains[i] as readonly SourceMigration[], Math.floor(nowMs / 1000)),
    ...checkAccepted(source, slice.accepted),
  ]);
  return Object.freeze(findings.map((f) => Object.freeze(f)));
}

function checkAccepted(source: TrackedSource, accepted: MigrateSlice["accepted"]): OrderFinding[] {
  const byId = new Map(source.migrations.map((m) => [m.id, m]));
  return accepted.flatMap((entry): OrderFinding[] => {
    if (entry.source !== source.name) return [];
    const file = byId.get(entry.id);
    if (file === undefined)
      return [{ source: source.name, id: entry.id, problem: "accepted-unknown-id" }];
    if (file.sha256 !== entry.current) {
      return [{ source: source.name, id: entry.id, problem: "accepted-current-mismatch" }];
    }
    return [];
  });
}

function compare(
  source: TrackedSource,
  main: readonly SourceMigration[],
  nowS: number,
): OrderFinding[] {
  const compareKeys = keyOrder(source);
  const out: OrderFinding[] = [];
  const add = (id: string, problem: OrderFinding["problem"]) =>
    out.push({ source: source.name, id, problem });
  const mainById = new Map(main.map((m) => [m.id, m]));
  const mainByKey = new Map(main.map((m) => [m.key, m]));
  const newest = main.reduce<string | undefined>(
    (top, m) => (top === undefined || compareKeys(m.key, top) > 0 ? m.key : top),
    undefined,
  );
  for (const m of source.migrations) {
    const onMain = mainById.get(m.id);
    if (onMain !== undefined) {
      if (onMain.key !== m.key) add(m.id, "key-changed-on-main");
      if (onMain.sha256 !== m.sha256) add(m.id, "edited-on-main");
      continue;
    }
    const at = STAMPED_NAME.test(m.id) ? secondOf(m.id) : undefined;
    if (at === undefined) add(m.id, "name");
    else if (at > nowS + DAY_S) add(m.id, "future-stamp");
    const sameKey = mainByKey.get(m.key);
    if (sameKey !== undefined) {
      // A rename keeps key and hash; a new name over a main key with new text is an edit.
      if (sameKey.sha256 !== m.sha256) add(m.id, "edited-on-main");
      continue;
    }
    if (newest !== undefined && compareKeys(m.key, newest) <= 0) add(m.id, "older-than-main");
    if (!m.baselined && m.kind === null) add(m.id, "unmarked");
  }
  return out;
}

export interface GitMainFolder {
  /** The folder's path from the repository root, e.g. "drizzle" or "migrations/auth". */
  path: string;
  layout: "drizzle" | "sql";
}

const text = new TextDecoder();

/**
 * A `readMain` for `checkMigrationOrder` that reads each source's folder on a
 * git ref through an injected `run` (git's argv, resolving to its stdout).
 *
 * - `fetch: "always"` fetches the ref's branch once per reader, first, with
 *   `--depth=1` only when the checkout is shallow; `"never"` reads what is
 *   there. A ref fetched must be `<remote>/<branch>`.
 * - The folder is listed with `git ls-tree -z` and only its regular files are
 *   read (a subtree is skipped, a symlink refused), each with `git cat-file
 *   blob`, as bytes, so nothing converts them.
 * - The files parse through the same readers as the working tree's, so main
 *   hashes exactly as the working tree does. Main is read without a marker
 *   rule: the check uses only main's ids, keys and hashes, and a rename PR's
 *   baseline names a file main does not have yet.
 *
 * Every failure rejects, naming the source and `<ref>:<path>/`.
 */
export function gitMainReader(deps: {
  run: (args: readonly string[]) => Promise<Uint8Array>;
  ref?: string;
  fetch: "always" | "never";
  folders: Readonly<Record<string, GitMainFolder>>;
}): (source: string) => Promise<readonly SourceMigration[]> {
  const { run, fetch, folders } = deps;
  const ref = deps.ref ?? "origin/main";
  if (typeof run !== "function") throw new TypeError("gitMainReader: run must be a function");
  if (fetch !== "always" && fetch !== "never") {
    throw new TypeError(`gitMainReader: fetch must be "always" or "never" — got ${q(fetch)}`);
  }
  if (
    typeof ref !== "string" ||
    !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes("..")
  ) {
    throw new TypeError(`gitMainReader: ref must be a plain ref name — got ${q(ref)}`);
  }
  const remote = /^([A-Za-z0-9._-]+)\/(.+)$/.exec(ref);
  if (fetch === "always" && remote === null) {
    throw new TypeError(
      `gitMainReader: fetch "always" needs a <remote>/<branch> ref — got ${q(ref)}`,
    );
  }
  let fetched: Promise<void> | undefined;
  const fetchOnce = async (name: string, branch: string): Promise<void> => {
    try {
      const shallow = text.decode(await run(["rev-parse", "--is-shallow-repository"])).trim();
      await run([
        "fetch",
        ...(shallow === "true" ? ["--depth=1"] : []),
        "--no-tags",
        name,
        `+refs/heads/${branch}:refs/remotes/${name}/${branch}`,
      ]);
    } catch (err) {
      failIo(`cannot fetch ${ref}`, err);
    }
  };

  return async (source) => {
    const folder = Object.hasOwn(folders, source) ? folders[source] : undefined;
    if (folder === undefined) fail(`gitMainReader has no folder for source ${q(source)}`);
    if (remote !== null && fetch === "always") {
      fetched ??= fetchOnce(remote[1] as string, remote[2] as string);
      await fetched;
    }
    const where = `${ref}:${folder.path.replace(/^\.\//, "").replace(/\/+$/, "")}/`;
    const git = async (args: readonly string[], what: string): Promise<Uint8Array> => {
      try {
        return await run(args);
      } catch (err) {
        failIo(`source ${q(source)}: cannot ${what}`, err);
      }
    };
    const blob = (name: string) =>
      git(["cat-file", "blob", `${where}${name}`], `read ${where}${name}`);
    const names = listBlobs(source, where, await git(["ls-tree", "-z", where], `list ${where}`));
    const wanted = names.filter(
      (n) => n.endsWith(".sql") || (folder.layout === "sql" && n === "renames.json"),
    );
    const bodies = await Promise.all(wanted.map(blob));
    const files = new Map(wanted.map((n, i) => [n, bodies[i] as Uint8Array]));
    const readFile = (name: string): Uint8Array => {
      const bytes = files.get(name);
      if (bytes === undefined) throw new Error(`no file ${name}`);
      return bytes;
    };
    const opts = { name: source };
    if (folder.layout === "sql") return sqlFolderAt(where, names, readFile, opts);
    return drizzleJournalAt(where, await blob("meta/_journal.json"), readFile, opts);
  };
}

/** The names of the regular files in `ls-tree -z` output; a symlink is refused, a subtree skipped. */
function listBlobs(source: string, where: string, out: Uint8Array): string[] {
  const names: string[] = [];
  for (const record of text.decode(out).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type] = record.slice(0, tab).split(" ");
    const name = record.slice(tab + 1);
    if (type !== "blob") continue;
    if (mode === "120000") {
      fail(
        `source ${q(source)}: ${where}${name} is a symlink on the ref — the order check cannot read through it`,
      );
    }
    names.push(name);
  }
  return names;
}
