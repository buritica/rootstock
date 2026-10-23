import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../hash/index.ts";
import { isRecord, q } from "../internal/slice.ts";
import { fail, failIo, reason } from "./errors.ts";
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
   * The identity the source's tracker records. drizzle: the entry's `when` in
   * decimal (drizzle's `created_at`). SQL folder: the file's original name, i.e.
   * its `renames.json` entry's key when it was renamed, else its current
   * filename. A rename never changes a key, so no tracker row is rewritten.
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
   * (with `.sql`), as the file is named now (after any rename), not its key.
   * An unmarked file at or before it is accepted by the PR check. Omit it when
   * every file is marked.
   */
  readonly baseline?: string;
  /**
   * A source-specific prefix accepted, beside the canonical `rootstock-migration`
   * marker, for files up to and including `through` (the current id), e.g.
   * `{ prefix: "legacy", through: "20260101000000_last_legacy" }`. After
   * `through`, only the canonical marker counts.
   */
  readonly legacy?: { readonly prefix: string; readonly through: string };
}

export interface SourceOptions {
  /** `[a-z][a-z0-9-]*`; unique within one run, which the applier enforces. */
  readonly name: string;
  /** Omitted: the canonical marker only, and no baseline. */
  readonly marker?: MarkerRule;
}

/**
 * Reads one file of the source by its name relative to the source's folder.
 * Synchronous; throwing is how it says the file is missing or unreadable.
 */
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

/** Refuses an own key `allowed` does not name, so a stale option shape is never silently read as empty. */
function onlyKeys(
  source: unknown,
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // The one shape change a 0.5.0 upgrade meets names where the key went.
      const moved =
        path === "marker." && key === "prefix" ? "; a prefix moved to marker.legacy.prefix" : "";
      fail(
        `source ${q(source)}: ${path}${q(key)} is not a known key — known: ${allowed.join(", ")}${moved}`,
      );
    }
  }
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
  onlyKeys(name, "", opts as unknown as Record<string, unknown>, ["name", "marker"]);
  if (marker !== undefined && !isRecord(marker)) {
    fail(`source ${q(name)}: marker must be an object — got ${q(marker)}`);
  }
  if (marker !== undefined) onlyKeys(name, "marker.", marker, ["baseline", "legacy"]);
  const { baseline, legacy } = (marker ?? {}) as MarkerRule;
  if (baseline !== undefined && typeof baseline !== "string") {
    fail(`source ${q(name)}: marker baseline must be a string — got ${q(baseline)}`);
  }
  if (legacy !== undefined) {
    if (!isRecord(legacy)) {
      fail(`source ${q(name)}: marker legacy must be an object — got ${q(legacy)}`);
    }
    onlyKeys(name, "marker.legacy.", legacy, ["prefix", "through"]);
    const { prefix, through } = legacy as Partial<NonNullable<MarkerRule["legacy"]>>;
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
      `source ${q(source)}: marker ${field} ${q(id)} is not one of its migrations`,
      "ERR_ROOTSTOCK_MIG_SRC_ID",
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
          legacy !== undefined && i <= through ? legacy.pattern : canonical,
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
    // A reader's own coded refusal (a file a git tree lacks) is a fact, not I/O.
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("ERR_ROOTSTOCK_MIG_")) throw err;
    failIo(what, err);
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

/**
 * `drizzleJournalFrom` for a reader of another tree: decodes the journal as
 * the folder reader does (a byte-order mark kept) and names `where` (ending in
 * `/`) in every refusal. Internal: the index does not export it.
 */
export function drizzleJournalAt(
  where: string,
  journal: Uint8Array,
  readFile: ReadFile,
  opts: SourceOptions,
): readonly SourceMigration[] {
  return journalFrom(open(opts, where), KEEP_BOM.decode(journal), readFile);
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
    fail(`source ${q(source)}: ${where}meta/_journal.json has no entries — wrong folder?`);
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
        `source ${q(source)}: journal entry ${q(r.tag)} has no readable file ${where}${r.tag}.sql`,
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

/** The own keys of a JSON object's text, duplicates included (JSON.parse keeps only the last). */
function rawKeys(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) keys.push(JSON.parse(`"${m[1]}"`));
  return keys;
}

/** `renames.json`: `{ "<name applied under>": "<current name>" }`, returned as current → applied. */
function readRenames(
  source: string,
  where: string,
  names: ReadonlySet<string>,
  readFile: ReadFile,
): ReadonlyMap<string, string> {
  if (!names.has(RENAMES)) return new Map();
  const file = `${where}${RENAMES}`;
  const text = DROP_BOM.decode(
    readOrFail(readFile, RENAMES, `source ${q(source)}: cannot read ${file}`),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`source ${q(source)}: ${file} is not JSON — ${reason(err)}`);
  }
  if (!isRecord(parsed)) {
    fail(`source ${q(source)}: ${file} must map old filenames to new ones — got ${q(parsed)}`);
  }
  const keys = rawKeys(text);
  const repeated = keys.find((k, i) => keys.indexOf(k) !== i);
  if (repeated !== undefined) {
    fail(`source ${q(source)}: ${file} names ${q(repeated)} twice — JSON keeps only the last`);
  }
  const byNew = new Map<string, string>();
  for (const [from, to] of Object.entries(parsed)) {
    if (typeof to !== "string" || !from.endsWith(".sql") || !to.endsWith(".sql")) {
      fail(`source ${q(source)}: ${file} entry ${q(from)} must map a .sql name to a .sql name`);
    }
    if (!names.has(to)) {
      const chained = Object.hasOwn(parsed, to)
        ? ` — renames do not chain: map ${q(from)} straight to ${q(parsed[to])}`
        : "";
      fail(
        `source ${q(source)}: ${file} maps ${q(from)} to ${q(to)}, which is not in the folder${chained}`,
      );
    }
    if (names.has(from)) {
      fail(
        `source ${q(source)}: ${file} maps ${q(from)}, which is a file in the folder — that name is recorded as applied, so a file under it would never run: rename the file`,
      );
    }
    if (byNew.has(to)) fail(`source ${q(source)}: ${file} maps two names to ${q(to)}`);
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
 * and its `key` the old one, so a renamed file is never re-applied. Renames do
 * not chain: renaming a file again rewrites its entry (`old → newest`).
 *
 * `names` must be regular files only (a reader of a git tree drops subtrees).
 * Refuses: a repeated name, a name ending `.sql` in another case (it would
 * never run), a folder with no `.sql` file, a file it cannot read, and a
 * `renames.json` that is not a JSON object of `.sql` names, repeats a key,
 * maps to a name not in the folder, maps from a name still in it, or maps two
 * names to one.
 */
export function sqlFolderFrom(
  names: readonly string[],
  readFile: ReadFile,
  opts: SourceOptions,
): readonly SourceMigration[] {
  return folderFrom(open(opts), names, readFile);
}

/** `sqlFolderFrom` naming `where` (ending in `/`) in every refusal. Internal. */
export function sqlFolderAt(
  where: string,
  names: readonly string[],
  readFile: ReadFile,
  opts: SourceOptions,
): readonly SourceMigration[] {
  return folderFrom(open(opts, where), names, readFile);
}

function folderFrom(
  opened: Opened,
  names: readonly string[],
  readFile: ReadFile,
): readonly SourceMigration[] {
  const { source, where } = opened;
  const present = new Set(names);
  if (present.size !== names.length) {
    const repeated = names.find((n, i) => names.indexOf(n) !== i);
    fail(`source ${q(source)}: ${q(repeated)} is listed twice`);
  }
  const cased = names.find((n) => !n.endsWith(".sql") && n.toLowerCase().endsWith(".sql"));
  if (cased !== undefined) {
    fail(
      `source ${q(source)}: ${q(cased)}${where && ` in ${where}`} would never run — name it .sql`,
    );
  }
  const renamed = readRenames(source, where, present, readFile);
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
    failIo(`source ${q(opened.source)}: cannot list ${opened.where}`, err);
  }
  // Regular files only (a symlink counts as its target): a subfolder named
  // *.sql is skipped, and a dangling link is refused when it is read.
  const names = listed.filter((name) => {
    let isFile: boolean;
    try {
      isFile = statSync(new URL(name, dir)).isFile();
    } catch {
      return true;
    }
    if (name === RENAMES && !isFile) {
      fail(`source ${q(opened.source)}: ${opened.where}${RENAMES} is not a file`);
    }
    return isFile;
  });
  return folderFrom(opened, names, folderReader(dir));
}

/** Migrations after the baseline that carry no marker, for a PR-time check. */
export function unmarkedAfterBaseline(migrations: readonly SourceMigration[]): readonly string[] {
  return migrations.filter((m) => !m.baselined && m.kind === null).map((m) => m.id);
}

const STAMPED = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)_/;
const NUMBERED = /^\d{1,6}_(.+?)(\.sql)?$/;
const SUFFIX = /^[a-z0-9_-]+$/;

/** The UTC `YYYYMMDDHHMMSS` of a second, or undefined outside years 1970–9999. */
function stampOf(second: number): string | undefined {
  if (!Number.isSafeInteger(second) || second < 0) return undefined;
  const iso = new Date(second * 1000).toISOString();
  return /^\d{4}-/.test(iso) ? iso.replace(/\D/g, "").slice(0, 14) : undefined;
}

/** The UTC second a `YYYYMMDDHHMMSS_` name stands for, or undefined when it is not one. */
export function secondOf(id: string): number | undefined {
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

function refuseRename(message: string): never {
  fail(`timestampRenames: ${message}`, "ERR_ROOTSTOCK_MIG_RENAME");
}

/**
 * The timestamped names for a source's numbered files, in the order given,
 * which must be the source's current order (not verified: the caller passes
 * it). A file already named `<YYYYMMDDHHMMSS>_…` keeps its name and needs no
 * `at`. Each numbered file becomes `<at, as UTC YYYYMMDDHHMMSS>_<its name
 * without the number>`, with `-` turned into `_`; when that second is taken,
 * it gets the next free one, so any number of files may share a second.
 * Refuses a date earlier than the one before it, a kept name that does not
 * sort after the name before it, a repeated id, and a date outside 1970–9999.
 * Pure: the caller supplies `at` (`new Date(when)` for a journal entry, or a
 * file's first commit time read once from a full clone) and commits the result.
 */
export function timestampRenames(
  entries: readonly { readonly id: string; readonly at?: Date }[],
): readonly { readonly from: string; readonly to: string }[] {
  const out: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  let lastName = "";
  let lastSecond = Number.NEGATIVE_INFINITY;
  let lastWanted = Number.NEGATIVE_INFINITY;
  for (const { id, at } of entries) {
    if (seen.has(id)) refuseRename(`${q(id)} is listed twice`);
    seen.add(id);
    const kept = secondOf(id);
    if (kept !== undefined) {
      if (id <= lastName) {
        refuseRename(
          `${q(id)} does not sort after ${q(lastName)} (the name before it, which may have moved to the next free second)`,
        );
      }
      lastName = id;
      lastSecond = kept;
      lastWanted = Math.max(lastWanted, kept);
      continue;
    }
    const numbered = NUMBERED.exec(id);
    if (numbered === null) {
      refuseRename(`${q(id)} is neither numbered nor a valid YYYYMMDDHHMMSS_ name`);
    }
    const [, rest = "", ext = ""] = numbered;
    if (!SUFFIX.test(rest)) {
      refuseRename(`${q(id)}: a numbered name must be lower-case [a-z0-9_-] after its number`);
    }
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      refuseRename(
        `${q(id)} needs a valid date — got ${at instanceof Date ? "an invalid Date" : q(at)}`,
      );
    }
    const wanted = Math.floor(at.getTime() / 1000);
    if (wanted < lastWanted) {
      refuseRename(
        `${q(id)} is dated ${at.toISOString()}, before the file ahead of it (${q(lastName)}) — its name would reorder the source`,
      );
    }
    const second = Math.max(wanted, lastSecond + 1);
    const stamp = stampOf(second);
    if (stamp === undefined) {
      refuseRename(`${q(id)} is dated outside 1970–9999 — got ${q(at.getTime())} ms`);
    }
    const to = `${stamp}_${rest.replaceAll("-", "_")}${ext}`;
    out.push({ from: id, to });
    lastName = to;
    lastSecond = second;
    lastWanted = wanted;
  }
  return Object.freeze(out.map((r) => Object.freeze(r)));
}
