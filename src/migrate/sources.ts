import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../hash/index.ts";
import { isRecord, q } from "../internal/slice.ts";
import { type MigrationKind, markerPattern, matchMarker, NAME_RULE } from "./marker.ts";

/**
 * One migration file of a consumer's source, as the applier and the checks see
 * it. `key` is unique within its source only, so anything that tracks files
 * across sources keys on `(source, key)`.
 */
export interface SourceMigration {
  /** The source's name, as the consumer configured it. */
  readonly source: string;
  /** The journal tag (drizzle) or the filename (SQL folder). */
  readonly id: string;
  /**
   * The identity the source's tracker records: the decimal `when` of a drizzle
   * journal entry (drizzle stores it as `created_at`), or the filename the file
   * was applied under, which a SQL folder's `renames.json` maps from its
   * current one. A rename never changes a key, so no tracker row is rewritten.
   */
  readonly key: string;
  /**
   * Lowercase hex sha256. For a drizzle journal it is drizzle's own hash (of the
   * file decoded as UTF-8, a byte-order mark kept), so it equals the stored
   * `__drizzle_migrations.hash`. For an SQL folder, whose origin stores no hash,
   * it is the hash of the file's bytes.
   */
  readonly sha256: string;
  /** The header marker, or null when the file carries none. */
  readonly kind: MigrationKind | null;
  /** At or before the source's marker baseline, so an unmarked file is accepted. */
  readonly baselined: boolean;
  readonly statements: readonly string[];
}

export interface MarkerRule {
  /**
   * The last id that predates markers: a journal tag (no `.sql`) or a filename
   * (with `.sql`). An unmarked file at or before it is accepted by the PR check.
   * Omit it when every file is marked.
   */
  readonly baseline?: string;
  /**
   * A source-specific prefix accepted for files up to and including `through`,
   * e.g. `{ prefix: "legacy", through: "20260101000000_last_legacy" }`. After
   * `through`, only the canonical `rootstock-migration` marker counts.
   */
  readonly legacy?: { readonly prefix: string; readonly through: string };
}

export interface SourceOptions {
  /** `[a-z][a-z0-9-]*`, unique within one run. */
  readonly name: string;
  /** Omitted: the canonical marker only, and no baseline. */
  readonly marker?: MarkerRule;
}

/** Reads one file of the source by its name relative to the source's folder. */
export type ReadFile = (name: string) => Uint8Array;

// drizzle-kit's separator, split as drizzle splits it: anywhere, untrimmed.
// rootstock's own files use a whole-line split instead (migrations.ts).
const DRIZZLE_BREAKPOINT = "--> statement-breakpoint";
const CANONICAL = "rootstock";
const RENAMES = "renames.json";

// drizzle reads with fs's utf8, which keeps a byte-order mark, and hashes that
// text, so the journal reader decodes the same way to reproduce its hash.
const KEEP_BOM = new TextDecoder("utf-8", { ignoreBOM: true });
// The SQL-folder origins differ (Bun.file().text() drops it, fs's utf8 keeps
// it); dropping is the one that runs, since Postgres rejects a leading U+FEFF.
const DROP_BOM = new TextDecoder("utf-8");

function fail(message: string): never {
  throw new Error(`rootstock migrate: ${message}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Opened {
  source: string;
  /** Where the files come from, for messages: a folder path, or empty. */
  where: string;
  baseline: string | undefined;
  /** The marker pattern for files up to and including `through`, and after it. */
  legacy: { pattern: RegExp; through: string } | undefined;
  canonical: RegExp;
}

/** Checks a reader's options once, before any file is read. */
function open(opts: SourceOptions, where = ""): Opened {
  const { name, marker } = (opts ?? {}) as Partial<SourceOptions>;
  if (typeof name !== "string" || !NAME_RULE.test(name)) {
    fail(`a source name must match [a-z][a-z0-9-]* — got ${q(name)}`);
  }
  if (marker !== undefined && !isRecord(marker)) {
    fail(`source ${q(name)}: marker must be an object — got ${q(marker)}`);
  }
  const { baseline, legacy } = (marker ?? {}) as MarkerRule;
  if (baseline !== undefined && typeof baseline !== "string") {
    fail(`source ${q(name)}: marker baseline must be a string — got ${q(baseline)}`);
  }
  if (legacy !== undefined) {
    const { prefix, through } = (isRecord(legacy) ? legacy : {}) as Partial<
      NonNullable<MarkerRule["legacy"]>
    >;
    if (typeof prefix !== "string" || !NAME_RULE.test(prefix)) {
      fail(`source ${q(name)}: marker legacy.prefix must match [a-z][a-z0-9-]* — got ${q(prefix)}`);
    }
    if (typeof through !== "string") {
      fail(`source ${q(name)}: marker legacy.through must be a string — got ${q(through)}`);
    }
  }
  return {
    source: name,
    where,
    baseline,
    legacy:
      legacy === undefined
        ? undefined
        : { pattern: markerPattern(CANONICAL, legacy.prefix), through: legacy.through },
    canonical: markerPattern(CANONICAL),
  };
}

/** A folder argument as a URL ending in `/`, refusing anything not local. */
function folderUrl(folder: string | URL): URL {
  let dir: URL;
  if (folder instanceof URL) {
    if (folder.protocol !== "file:" || (folder.host !== "" && folder.host !== "localhost")) {
      fail(`a source folder must be a local file: URL — got ${q(folder.href)}`);
    }
    dir = new URL(folder.href);
  } else {
    if (typeof folder !== "string" || !isAbsolute(folder)) {
      fail(
        `a source folder must be an absolute path or a file: URL, e.g. new URL("../drizzle/", import.meta.url) — got ${q(folder)}`,
      );
    }
    dir = pathToFileURL(folder);
  }
  if (!dir.pathname.endsWith("/")) dir.pathname += "/";
  return dir;
}

function folderReader(dir: URL): ReadFile {
  return (name) => readFileSync(new URL(name, dir));
}

interface Draft {
  id: string;
  key: string;
  sha256: string;
  text: string;
  statements: readonly string[];
}

function indexOf(source: string, drafts: readonly Draft[], field: string, id: string): number {
  const at = drafts.findIndex((d) => d.id === id);
  if (at === -1) {
    fail(
      `source ${q(source)}: marker ${field} ${q(id)} is not one of its migrations — the marker check would pass empty`,
    );
  }
  return at;
}

function build(opened: Opened, drafts: readonly Draft[]): readonly SourceMigration[] {
  const { source, baseline, legacy, canonical } = opened;
  const at = baseline === undefined ? -1 : indexOf(source, drafts, "baseline", baseline);
  const through =
    legacy === undefined ? -1 : indexOf(source, drafts, "legacy.through", legacy.through);
  return Object.freeze(
    drafts.map((d, i) =>
      Object.freeze({
        source,
        id: d.id,
        key: d.key,
        sha256: d.sha256,
        kind: matchMarker(
          d.text,
          i <= through ? (legacy as { pattern: RegExp }).pattern : canonical,
        ),
        baselined: i <= at,
        statements: Object.freeze(d.statements),
      }),
    ),
  );
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

function readOrFail(readFile: ReadFile, name: string, what: string): Uint8Array {
  try {
    return readFile(name);
  } catch (err) {
    fail(`${what} — ${reason(err)}`);
  }
}

/**
 * The drizzle-kit layout from its parts: the text of `meta/_journal.json` and a
 * reader for each `<tag>.sql`. `drizzleJournal` reads a folder through it; the
 * order check reads a git ref through it, so both hash identically.
 *
 * Each file is split on `--> statement-breakpoint` as drizzle splits it. The
 * hash is drizzle's (`sha256` of the file text) and the key is the entry's
 * `when`, which is what drizzle stores in `__drizzle_migrations` as `hash` and
 * `created_at`. Order is journal order; `when` need not increase, because
 * applying by set makes an older `when` legitimate after two branches cross.
 * Refuses an empty or malformed journal, a duplicate tag or `when`, and a
 * missing file, because each of those would read as "nothing pending".
 */
export function drizzleJournalFrom(
  journalText: string,
  readFile: ReadFile,
  opts: SourceOptions,
): readonly SourceMigration[] {
  return journalFrom(open(opts), journalText, readFile);
}

function journalFrom(
  opened: Opened,
  journalText: string,
  readFile: ReadFile,
): readonly SourceMigration[] {
  const { source, where } = opened;
  let parsed: unknown;
  try {
    parsed = JSON.parse(journalText);
  } catch (err) {
    fail(`source ${q(source)}: ${where}meta/_journal.json is not JSON — ${reason(err)}`);
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`source ${q(source)}: the journal has no entries — wrong folder?`);
  }
  const tags = new Set<string>();
  const whens = new Set<number>();
  const drafts = entries.map((e: unknown): Draft => {
    const r = (e ?? {}) as { tag?: unknown; when?: unknown };
    if (typeof r.tag !== "string" || !/^[\w-]+$/.test(r.tag) || !isInt(r.when)) {
      fail(
        `source ${q(source)}: journal entry is malformed (tag must match [A-Za-z0-9_-]+, when must be an integer) — got ${q(e)}`,
      );
    }
    if (tags.has(r.tag) || whens.has(r.when)) {
      fail(
        `source ${q(source)}: journal entry ${q(r.tag)} repeats a tag or a when — each must be unique`,
      );
    }
    tags.add(r.tag);
    whens.add(r.when);
    const text = KEEP_BOM.decode(
      readOrFail(
        readFile,
        `${r.tag}.sql`,
        `source ${q(source)}: journal entry ${q(r.tag)} has no readable file ${r.tag}.sql`,
      ),
    );
    return {
      id: r.tag,
      key: String(r.when),
      sha256: sha256Hex(text),
      text,
      // Hashed with any byte-order mark, as drizzle hashes; run without it,
      // since Postgres rejects a statement that starts with U+FEFF.
      statements: text
        .replace(/^\uFEFF/, "")
        .split(DRIZZLE_BREAKPOINT)
        .filter((s) => s.trim() !== ""),
    };
  });
  return build(opened, drafts);
}

/** Reads a drizzle-kit folder: `meta/_journal.json` and each `<tag>.sql` (see `drizzleJournalFrom`). */
export function drizzleJournal(
  folder: string | URL,
  opts: SourceOptions,
): readonly SourceMigration[] {
  const dir = folderUrl(folder);
  const opened = open(opts, fileURLToPath(dir));
  const read = folderReader(dir);
  const text = KEEP_BOM.decode(
    readOrFail(
      read,
      "meta/_journal.json",
      `source ${q(opened.source)}: cannot read ${opened.where}meta/_journal.json`,
    ),
  );
  return journalFrom(opened, text, read);
}

/** `renames.json`: `{ "<name applied under>": "<current name>" }`, as current → applied. */
function readRenames(
  source: string,
  names: ReadonlySet<string>,
  readFile: ReadFile,
): ReadonlyMap<string, string> {
  if (!names.has(RENAMES)) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(DROP_BOM.decode(readFile(RENAMES)));
  } catch (err) {
    fail(`source ${q(source)}: cannot read ${RENAMES} — ${reason(err)}`);
  }
  if (!isRecord(parsed)) {
    fail(`source ${q(source)}: ${RENAMES} must map old filenames to new ones — got ${q(parsed)}`);
  }
  const byNew = new Map<string, string>();
  for (const [from, to] of Object.entries(parsed)) {
    if (typeof to !== "string" || !from.endsWith(".sql") || !to.endsWith(".sql")) {
      fail(`source ${q(source)}: ${RENAMES} entry ${q(from)} must map a .sql name to a .sql name`);
    }
    if (!names.has(to)) {
      fail(
        `source ${q(source)}: ${RENAMES} maps ${q(from)} to ${q(to)}, which is not in the folder`,
      );
    }
    if (names.has(from)) {
      fail(
        `source ${q(source)}: ${RENAMES} maps ${q(from)}, which is still in the folder — a renamed file's old name must be gone`,
      );
    }
    if (byNew.has(to)) fail(`source ${q(source)}: ${RENAMES} maps two names to ${q(to)}`);
    byNew.set(to, from);
  }
  return byNew;
}

/**
 * A folder of `.sql` files from its parts: the folder's file names and a reader
 * for each. Files apply in filename order (code-unit sort), each as one
 * statement batch with any byte-order mark dropped (the simple query protocol
 * runs it whole). A `renames.json` in the folder maps the names files were
 * applied under to their current names: such a file's `id` is its current name
 * and its `key` the old one, so a renamed file is never re-applied. Refuses a
 * folder with no `.sql` file, and a file it cannot read.
 */
export function sqlFolderFrom(
  names: readonly string[],
  readFile: ReadFile,
  opts: SourceOptions,
): readonly SourceMigration[] {
  return folderFrom(open(opts), names, readFile);
}

function folderFrom(
  opened: Opened,
  names: readonly string[],
  readFile: ReadFile,
): readonly SourceMigration[] {
  const { source, where } = opened;
  const present = new Set(names);
  const renamed = readRenames(source, present, readFile);
  const files = names.filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    fail(`source ${q(source)}: ${where || "the source"} holds no .sql file — wrong folder?`);
  }
  const drafts = files.map((file): Draft => {
    const bytes = readOrFail(
      readFile,
      file,
      `source ${q(source)}: cannot read ${file}${where && ` in ${where}`}`,
    );
    const text = DROP_BOM.decode(bytes);
    // readRenames refused an old name that is still a file, so keys stay unique.
    const key = renamed.get(file) ?? file;
    return { id: file, key, sha256: sha256Hex(bytes), text, statements: [text] };
  });
  return build(opened, drafts);
}

/**
 * Reads a folder of `.sql` files (see `sqlFolderFrom`). A symlink to a file
 * counts as the file; subfolders are ignored; `renames.json` is read when present.
 */
export function sqlFolder(folder: string | URL, opts: SourceOptions): readonly SourceMigration[] {
  const dir = folderUrl(folder);
  const opened = open(opts, fileURLToPath(dir));
  let listed: string[];
  try {
    listed = readdirSync(dir);
  } catch (err) {
    fail(`source ${q(opened.source)}: cannot list ${opened.where} — ${reason(err)}`);
  }
  // Regular files only (a symlink counts as its target): a subfolder named
  // *.sql is skipped, and a dangling link is refused when it is read.
  const names = listed.filter((name) => {
    try {
      return statSync(new URL(name, dir)).isFile();
    } catch {
      return true;
    }
  });
  return folderFrom(opened, names, folderReader(dir));
}

/** Migrations after the baseline that carry no marker, for a PR-time check. */
export function unmarkedAfterBaseline(migrations: readonly SourceMigration[]): readonly string[] {
  return migrations.filter((m) => !m.baselined && m.kind === null).map((m) => m.id);
}

const STAMPED = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)_/;
const NUMBERED = /^\d{1,6}_([a-z0-9_-]+)(\.sql)?$/;

function stampOf(second: number): string {
  return new Date(second * 1000).toISOString().replace(/\D/g, "").slice(0, 14);
}

/** The UTC second a `YYYYMMDDHHMMSS_` name stands for, or undefined when it is not one. */
function secondOf(id: string): number | undefined {
  const m = STAMPED.exec(id);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const second = Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
  return stampOf(second) === id.slice(0, 14) ? second : undefined;
}

/**
 * The timestamped names for a source's numbered files (D49), in the order
 * given, which must be the source's current order. A file already named
 * `<YYYYMMDDHHMMSS>_…` keeps its name and holds its second (its `at` is
 * ignored). Each numbered file becomes `<at, as UTC YYYYMMDDHHMMSS>_<its name
 * without the number>`, with `-` turned into `_`; when that second is taken, it
 * gets the next free one. Refuses a name or date that would reorder the source.
 * Pure: the caller supplies `at` (a journal's `when`, or a file's first commit
 * time read once from a full clone) and commits the result.
 */
export function timestampRenames(
  entries: readonly { readonly id: string; readonly at: Date }[],
): readonly { readonly from: string; readonly to: string }[] {
  const out: { from: string; to: string }[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const { id, at } of entries) {
    const kept = secondOf(id);
    const numbered = kept === undefined ? NUMBERED.exec(id) : null;
    if (kept === undefined && numbered === null) {
      fail(`timestampRenames: ${q(id)} is neither numbered nor a valid YYYYMMDDHHMMSS_ name`);
    }
    if (numbered !== null && (!(at instanceof Date) || Number.isNaN(at.getTime()))) {
      fail(`timestampRenames: ${q(id)} needs a valid date — got ${q(at)}`);
    }
    const wanted = kept ?? Math.floor(at.getTime() / 1000);
    // A kept name cannot move, so it must clear the one before it; a renamed
    // file may take the next free second, but never an earlier one.
    if (kept !== undefined ? wanted <= last : wanted < last) {
      fail(
        `timestampRenames: ${q(id)} would sort before the name ahead of it — order would change`,
      );
    }
    last = Math.max(wanted, last + 1);
    if (numbered !== null) {
      const [, rest, ext = ""] = numbered;
      out.push({ from: id, to: `${stampOf(last)}_${(rest as string).replaceAll("-", "_")}${ext}` });
    }
  }
  return Object.freeze(out.map((r) => Object.freeze(r)));
}
