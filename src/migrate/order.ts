import { isRecord, q } from "../internal/slice.ts";
import { fail, failIo } from "./errors.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import { drizzleJournalAt, type SourceMigration, secondOf, sqlFolderAt } from "./sources.ts";
import type { TrackedSource } from "./tracked.ts";

export interface OrderFinding {
  readonly source: string;
  readonly id: string;
  readonly problem:
    | "name"
    | "future-stamp"
    | "older-than-main"
    | "unmarked"
    | "edited-on-main"
    | "key-changed-on-main"
    | "deleted-on-branch"
    | "stale-base"
    | "accepted-unknown-id"
    | "accepted-current-mismatch";
  /** What the fix needs: the main key to beat, the hash to accept, the file it collided with. */
  readonly detail: string;
}

/** The name rule for a migration added after D49; its time is checked by `secondOf`. */
const STAMPED_NAME = /^\d{14}_[a-z0-9_]+(\.sql)?$/;
const DAY_S = 86_400;

/** A drizzle key is its `when`, compared as an integer; any other key is a filename. */
function keyOrder(
  source: TrackedSource,
  main: readonly SourceMigration[],
): (a: string, b: string) => number {
  if (source.tracker.kind === "drizzle") {
    for (const m of [...source.migrations, ...main]) {
      if (!/^\d+$/.test(m.key)) {
        fail(
          `source ${q(source.name)}: ${q(m.id)} has key ${q(m.key)}, but a drizzle key is a when`,
        );
      }
    }
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
 *   rename: only its name and stamp are checked, and an unstamped one is a
 *   branch cut before main's rename (`stale-base`).
 * - An id on both sides must keep its key and its hash. A new id that keeps a
 *   main key with another hash is an edit of that file.
 * - Every key on main must still be on the branch (`deleted-on-branch`): a
 *   deleted file, or a rename without `renames.json`, would re-apply or orphan.
 * - Each finding's `detail` says what the fix needs. A source absent from main
 *   (new in this PR) is compared against an empty history.
 * - Every `accepted` entry must name a migration of a source passed here
 *   (pass every source the slice's list names), whose hash must equal the
 *   entry's `current`.
 *
 * rootstock's own source (named "rootstock", tracker kind "rootstock") is not
 * read from main: its files live in the package. Sources are read from main
 * in parallel. A `readMain` failure rejects the check; it never reads as no
 * findings. Refuses (ERR_ROOTSTOCK_MIG_SRC) a repeated source name, a source
 * whose name and tracker disagree about being rootstock's, a migration whose
 * `source` is not its source's name, and a `readMain` result that is not an array.
 */
export async function checkMigrationOrder(
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
  readMain: (source: string) => Promise<readonly SourceMigration[]>,
  now: () => Date,
): Promise<readonly OrderFinding[]> {
  assertMigrateSlice("checkMigrationOrder", slice);
  const nowMs = now().getTime();
  if (Number.isNaN(nowMs)) fail("checkMigrationOrder: now() returned an invalid Date");
  checkSources(sources);
  const apps = sources.filter((s) => s.tracker.kind !== "rootstock");
  const mains = await Promise.all(apps.map((s) => readMain(s.name)));
  const findings = apps.flatMap((source, i) => {
    const main = mains[i];
    if (!Array.isArray(main)) {
      fail(`checkMigrationOrder: readMain(${q(source.name)}) did not resolve to an array`);
    }
    return compare(source, main, Math.floor(nowMs / 1000));
  });
  findings.push(...checkAccepted(sources, slice.accepted));
  return Object.freeze(findings.map((f) => Object.freeze(f)));
}

function checkSources(sources: readonly TrackedSource[]): void {
  if (!Array.isArray(sources as unknown))
    fail(`checkMigrationOrder: sources must be an array — got ${q(sources)}`);
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name))
      fail(`checkMigrationOrder: source ${q(source.name)} is listed twice`);
    names.add(source.name);
    if ((source.name === "rootstock") !== (source.tracker.kind === "rootstock")) {
      fail(
        `checkMigrationOrder: source ${q(source.name)} has tracker kind ${q(source.tracker.kind)} — only rootstock's own source is named "rootstock" and tracked as rootstock`,
      );
    }
    const stray = source.migrations.find((m) => m.source !== source.name);
    if (stray !== undefined) {
      fail(
        `checkMigrationOrder: source ${q(source.name)} holds ${q(stray.id)} from source ${q(stray.source)}`,
      );
    }
  }
}

/** Every entry, rootstock's own source included; an entry for a source not passed names no migration. */
function checkAccepted(
  sources: readonly TrackedSource[],
  accepted: MigrateSlice["accepted"],
): OrderFinding[] {
  const pair = (source: string, x: string) => JSON.stringify([source, x]);
  const byId = new Map(
    sources.flatMap((s) => s.migrations.map((m) => [pair(s.name, m.id), m] as const)),
  );
  const byKey = new Map(
    sources.flatMap((s) => s.migrations.map((m) => [pair(s.name, m.key), m] as const)),
  );
  return accepted.flatMap((entry): OrderFinding[] => {
    const { source, id } = entry;
    const file = byId.get(pair(source, id));
    if (file === undefined) {
      const renamed = byKey.get(pair(source, id));
      const detail = renamed
        ? `${id} was renamed to ${renamed.id}; accept it under its current id`
        : sources.some((s) => s.name === source)
          ? `source ${source} has no migration ${id}`
          : `no source named ${source} was checked`;
      return [{ source, id, problem: "accepted-unknown-id", detail }];
    }
    if (file.sha256 !== entry.current) {
      const detail = `the file's hash is ${file.sha256}, the entry's current is ${entry.current}`;
      return [{ source, id, problem: "accepted-current-mismatch", detail }];
    }
    return [];
  });
}

function compare(
  source: TrackedSource,
  main: readonly SourceMigration[],
  nowS: number,
): OrderFinding[] {
  const compareKeys = keyOrder(source, main);
  const out: OrderFinding[] = [];
  const add = (id: string, problem: OrderFinding["problem"], detail: string) =>
    out.push({ source: source.name, id, problem, detail });
  const mainById = new Map(main.map((m) => [m.id, m]));
  const mainByKey = new Map(main.map((m) => [m.key, m]));
  const branchKeys = new Set(source.migrations.map((m) => m.key));
  const branchIds = new Set(source.migrations.map((m) => m.id));
  const newest = main.reduce<SourceMigration | undefined>(
    (top, m) => (top === undefined || compareKeys(m.key, top.key) > 0 ? m : top),
    undefined,
  );
  for (const m of source.migrations) {
    const onMain = mainById.get(m.id);
    if (onMain !== undefined) {
      if (onMain.key !== m.key) {
        add(m.id, "key-changed-on-main", `its key is ${onMain.key} on main and ${m.key} here`);
      }
      if (onMain.sha256 !== m.sha256) add(m.id, "edited-on-main", "its text differs from main's");
      continue;
    }
    const sameKey = mainByKey.get(m.key);
    const at = STAMPED_NAME.test(m.id) ? secondOf(m.id) : undefined;
    // Main renamed this file to a stamped name; the branch predates that.
    const behind =
      sameKey !== undefined && sameKey.sha256 === m.sha256 && STAMPED_NAME.test(sameKey.id);
    if (at === undefined && behind) {
      add(m.id, "stale-base", `main holds this file as ${sameKey.id}; update the branch from main`);
      continue;
    }
    if (at === undefined) {
      add(
        m.id,
        "name",
        "a new migration is named YYYYMMDDHHMMSS_<lower-case name>, a real UTC time",
      );
    } else if (at > nowS + DAY_S) {
      add(
        m.id,
        "future-stamp",
        `its stamp is more than a day after now (${new Date(nowS * 1000).toISOString()})`,
      );
    }
    if (sameKey !== undefined) {
      // A rename keeps key and hash; a new name over a main key with new text is an edit.
      if (sameKey.sha256 !== m.sha256) {
        add(
          m.id,
          "edited-on-main",
          `it is main's ${sameKey.id} (same key ${m.key}) with different text`,
        );
      }
      continue;
    }
    if (newest !== undefined && compareKeys(m.key, newest.key) <= 0) {
      add(
        m.id,
        "older-than-main",
        `its key ${m.key} must sort after main's newest, ${newest.key} (${newest.id}); regenerate it on top of main`,
      );
    }
    if (!m.baselined && m.kind === null) {
      add(
        m.id,
        "unmarked",
        "a new migration starts with -- rootstock-migration: additive or heavy",
      );
    }
  }
  for (const m of main) {
    // An id kept under a new key is already key-changed-on-main.
    if (!branchKeys.has(m.key) && !branchIds.has(m.id)) {
      add(
        m.id,
        "deleted-on-branch",
        `main applies ${m.id} (key ${m.key}); a migration is never deleted or renamed without renames.json`,
      );
    }
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
 * The ref is resolved to one commit per reader (after the fetch), and a
 * folder main does not have reads as no migrations: the source is new in this
 * PR. Every failure rejects: a fetch failure names the ref, a read failure the
 * source and `<ref>:<path>/`; a failed fetch is retried by the next call. Files
 * are compared as committed, so a checkout that converts line endings
 * (core.autocrlf) reads as edited. `run` must reject when git exits non-zero.
 * Bad arguments throw ERR_ROOTSTOCK_MIG_SRC. A folder path is relative to the
 * repository root and may not be empty, `.`, absolute or contain `..`.
 */
export function gitMainReader(deps: {
  run: (args: readonly string[]) => Promise<Uint8Array>;
  ref?: string;
  fetch: "always" | "never";
  folders: Readonly<Record<string, GitMainFolder>>;
}): (source: string) => Promise<readonly SourceMigration[]> {
  const { run, fetch, folders } = deps;
  const ref = deps.ref ?? "origin/main";
  if (typeof run !== "function") fail("gitMainReader: run must be a function");
  if (fetch !== "always" && fetch !== "never") {
    fail(`gitMainReader: fetch must be "always" or "never" — got ${q(fetch)}`);
  }
  if (
    typeof ref !== "string" ||
    !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref) ||
    ref.includes("..")
  ) {
    fail(`gitMainReader: ref must be a plain ref name — got ${q(ref)}`);
  }
  if (!isRecord(folders)) fail(`gitMainReader: folders must be an object — got ${q(folders)}`);
  const remote = ref.startsWith("refs/") ? null : /^([A-Za-z0-9._-]+)\/(.+)$/.exec(ref);
  if (fetch === "always" && remote === null) {
    fail(`gitMainReader: fetch "always" needs a <remote>/<branch> ref — got ${q(ref)}`);
  }
  // One commit for the reader's life, resolved after the fetch, so every
  // source and every file is read from the same main even if the ref moves.
  let commit: Promise<string> | undefined;
  const resolve = async (): Promise<string> => {
    if (remote !== null && fetch === "always") {
      const [, name, branch] = remote as unknown as [string, string, string];
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
    }
    let sha: string;
    try {
      sha = text.decode(await run(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    } catch (err) {
      failIo(`cannot resolve ${ref}`, err);
    }
    if (!/^[0-9a-f]{40,64}$/.test(sha))
      fail(`gitMainReader: ${ref} resolved to ${q(sha)}, not a commit`);
    return sha;
  };
  const commitOnce = (): Promise<string> => {
    // A failure is not kept: the next call fetches again.
    commit ??= resolve().catch((err) => {
      commit = undefined;
      throw err;
    });
    return commit;
  };

  return async (source) => {
    const folder = Object.hasOwn(folders, source) ? folders[source] : undefined;
    if (folder === undefined) {
      fail(
        `gitMainReader has no folder for source ${q(source)} — it has ${Object.keys(folders).map(q).join(", ") || "none"}`,
      );
    }
    const path =
      typeof folder.path === "string"
        ? folder.path.replace(/^(\.\/)+/, "").replace(/\/+$/, "")
        : "";
    if (path === "" || path === "." || path.startsWith("/") || path.split("/").includes("..")) {
      fail(
        `gitMainReader: source ${q(source)}: folder path must be relative to the repository root — got ${q(folder.path)}`,
      );
    }
    if (folder.layout !== "drizzle" && folder.layout !== "sql") {
      fail(
        `gitMainReader: source ${q(source)}: layout must be "drizzle" or "sql" — got ${q(folder.layout)}`,
      );
    }
    const sha = await commitOnce();
    const where = `${ref}:${path}/`;
    const git = async (args: readonly string[], what: string): Promise<Uint8Array> => {
      try {
        return await run(args);
      } catch (err) {
        failIo(`source ${q(source)}: cannot ${what}`, err);
      }
    };
    // Listing the path from the root succeeds empty when main does not have
    // it, which tells "new in this PR" apart from a read that failed.
    const probe = await git(["ls-tree", "-z", sha, "--", path], `look for ${where}`);
    if (probe.length === 0) return Object.freeze([]);
    const blob = (name: string) =>
      git(["cat-file", "blob", `${sha}:${path}/${name}`], `read ${where}${name}`);
    const names = listBlobs(
      source,
      where,
      await git(["ls-tree", "-z", `${sha}:${path}/`], `list ${where}`),
    );
    const wanted = names.filter(
      (n) => n.endsWith(".sql") || (folder.layout === "sql" && n === "renames.json"),
    );
    const files = new Map<string, Uint8Array>();
    // A few git processes at a time, not one per file at once.
    const queue = [...wanted];
    await Promise.all(
      Array.from({ length: Math.min(READ_WIDTH, queue.length) }, async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
          files.set(name, await blob(name));
        }
      }),
    );
    const readFile = (name: string): Uint8Array => {
      const bytes = files.get(name);
      if (bytes === undefined) fail(`source ${q(source)}: ${where}${name} is not on the ref`);
      return bytes;
    };
    const opts = { name: source };
    if (folder.layout === "sql") return sqlFolderAt(where, names, readFile, opts);
    return drizzleJournalAt(where, await blob("meta/_journal.json"), readFile, opts);
  };
}

const READ_WIDTH = 8;

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
