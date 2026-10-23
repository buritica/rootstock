import { q } from "../internal/slice.ts";
import { assertMigrateSlice, type MigrateSlice } from "./slice.ts";
import type { MarkerRule, SourceMigration } from "./sources.ts";
import { drizzleJournalFrom, sqlFolderFrom } from "./sources.ts";
import { ROOTSTOCK_SOURCE, type TrackedSource } from "./tracked.ts";

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

const STAMPED_ID = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+/;
const DAY_MS = 86_400_000;

/** The second a `YYYYMMDDHHMMSS_` id names, in ms, or undefined when it is not a real UTC time. */
function stampMs(id: string): number | undefined {
  const m = STAMPED_ID.exec(id);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  const same =
    back.getUTCFullYear() === y &&
    back.getUTCMonth() === mo - 1 &&
    back.getUTCDate() === d &&
    back.getUTCHours() === h &&
    back.getUTCMinutes() === mi &&
    back.getUTCSeconds() === s;
  return same ? ms : undefined;
}

/** Keys compare as integers when both are digits (a drizzle `when`), else by code unit (a filename). */
function compareKeys(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
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
 * rootstock's own source is skipped: its files live in the package, not on
 * main. A `readMain` failure rejects the check; it never reads as no findings.
 */
export async function checkMigrationOrder(
  slice: MigrateSlice,
  sources: readonly TrackedSource[],
  readMain: (source: string) => Promise<readonly SourceMigration[]>,
  now: () => Date,
): Promise<readonly OrderFinding[]> {
  assertMigrateSlice("checkMigrationOrder", slice);
  const nowMs = now().getTime();
  if (Number.isNaN(nowMs))
    throw new TypeError("checkMigrationOrder: now() returned an invalid Date");
  const findings: OrderFinding[] = [];
  for (const source of sources) {
    if (source.name === ROOTSTOCK_SOURCE) continue;
    const main = await readMain(source.name);
    findings.push(...compare(source, main, nowMs));
    const byId = new Map(source.migrations.map((m) => [m.id, m]));
    for (const entry of slice.accepted) {
      if (entry.source !== source.name) continue;
      const file = byId.get(entry.id);
      if (file === undefined) {
        findings.push({ source: source.name, id: entry.id, problem: "accepted-unknown-id" });
      } else if (file.sha256 !== entry.current) {
        findings.push({ source: source.name, id: entry.id, problem: "accepted-current-mismatch" });
      }
    }
  }
  return Object.freeze(findings.map((f) => Object.freeze(f)));
}

function compare(
  source: TrackedSource,
  main: readonly SourceMigration[],
  nowMs: number,
): OrderFinding[] {
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
    const at = stampMs(m.id);
    if (at === undefined) add(m.id, "name");
    else if (at > nowMs + DAY_MS) add(m.id, "future-stamp");
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
  /** Accepted for symmetry with the working-tree reader; main is read without it (see gitMainReader). */
  marker?: MarkerRule;
}

const textOf = new TextDecoder("utf-8", { fatal: false });

function gitError(message: string, cause: unknown): never {
  const why = cause instanceof Error ? cause.message : String(cause);
  throw Object.assign(new Error(`rootstock migrate: ${message} — ${why}`, { cause }), {
    code: "ERR_ROOTSTOCK_MIG_IO",
  });
}

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
 * - The files parse through `drizzleJournalFrom` / `sqlFolderFrom`, so main
 *   hashes exactly as the working tree does. Main is read without the marker
 *   rule: the check uses only main's ids, keys and hashes, and a rename PR's
 *   baseline names a file main does not have yet.
 *
 * Every failure rejects, naming the source and the ref.
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
  const fetchOnce = (): Promise<void> => {
    fetched ??= (async () => {
      const [, name, branch] = remote as RegExpExecArray;
      try {
        const shallow = textOf.decode(await run(["rev-parse", "--is-shallow-repository"])).trim();
        await run([
          "fetch",
          ...(shallow === "true" ? ["--depth=1"] : []),
          "--no-tags",
          name as string,
          `+refs/heads/${branch}:refs/remotes/${name}/${branch}`,
        ]);
      } catch (err) {
        gitError(`cannot fetch ${ref}`, err);
      }
    })();
    return fetched;
  };

  return async (source) => {
    const folder = Object.hasOwn(folders, source) ? folders[source] : undefined;
    if (folder === undefined) {
      throw Object.assign(
        new Error(`rootstock migrate: gitMainReader has no folder for source ${q(source)}`),
        {
          code: "ERR_ROOTSTOCK_MIG_SRC",
        },
      );
    }
    if (fetch === "always") await fetchOnce();
    const dir = folder.path.replace(/^\.\//, "").replace(/\/+$/, "");
    const where = `${ref}:${dir}`;
    const git = async (args: readonly string[], what: string): Promise<Uint8Array> => {
      try {
        return await run(args);
      } catch (err) {
        gitError(`source ${q(source)}: cannot ${what} ${where}`, err);
      }
    };
    const files = new Map<string, Uint8Array>();
    const read = async (name: string) => {
      files.set(name, await git(["cat-file", "blob", `${where}/${name}`], `read ${name} in`));
    };
    const blobs = listBlobs(source, where, await git(["ls-tree", "-z", where], "list"));
    const opts = { name: source };
    try {
      if (folder.layout === "drizzle") {
        const metaEntries = listBlobs(
          source,
          `${where}/meta`,
          await git(["ls-tree", "-z", `${where}/meta`], "list meta in"),
        );
        if (!metaEntries.includes("_journal.json")) {
          throw Object.assign(
            new Error(
              `rootstock migrate: source ${q(source)}: ${where}/meta/_journal.json is missing`,
            ),
            {
              code: "ERR_ROOTSTOCK_MIG_SRC",
            },
          );
        }
        await Promise.all(blobs.filter((n) => n.endsWith(".sql")).map(read));
        const journal = await git(
          ["cat-file", "blob", `${where}/meta/_journal.json`],
          "read meta/_journal.json in",
        );
        return drizzleJournalFrom(
          new TextDecoder("utf-8", { ignoreBOM: true }).decode(journal),
          fromMap(files),
          opts,
        );
      }
      await Promise.all(blobs.filter((n) => n.endsWith(".sql") || n === "renames.json").map(read));
      return sqlFolderFrom(blobs, fromMap(files), opts);
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      if (
        typeof e.code === "string" &&
        e.code.startsWith("ERR_ROOTSTOCK_MIG_") &&
        typeof e.message === "string"
      ) {
        // Name the ref: the same text from the working tree would send the reader to the wrong tree.
        e.message = `${e.message} (reading ${where})`;
      }
      throw err;
    }
  };
}

function fromMap(files: ReadonlyMap<string, Uint8Array>) {
  return (name: string): Uint8Array => {
    const bytes = files.get(name);
    if (bytes === undefined) throw new Error(`no file ${name}`);
    return bytes;
  };
}

/** The names of the regular files in `ls-tree -z` output; a symlink is refused, a subtree skipped. */
function listBlobs(source: string, where: string, out: Uint8Array): string[] {
  const names: string[] = [];
  for (const record of textOf.decode(out).split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, type] = record.slice(0, tab).split(" ");
    const name = record.slice(tab + 1);
    if (type !== "blob") continue;
    if (mode === "120000") {
      throw Object.assign(
        new Error(
          `rootstock migrate: source ${q(source)}: ${where}/${name} is a symlink on the ref — the order check cannot read through it`,
        ),
        { code: "ERR_ROOTSTOCK_MIG_SRC" },
      );
    }
    names.push(name);
  }
  return names;
}
