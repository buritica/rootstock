import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../hash/index.ts";
import { q } from "../internal/slice.ts";
import { type MigrationKind, markerPattern, matchMarker } from "./marker.ts";

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
   * journal entry (drizzle stores it as `created_at`), or the filename.
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
  /** The marker's prefix: `-- <prefix>-migration: additive|heavy`. */
  readonly prefix: string;
  /**
   * The last id that predates the marker: a journal tag (no `.sql`) or a
   * filename (with `.sql`). It must be in the source; omit it when every file
   * is marked.
   */
  readonly baseline?: string;
}

export interface SourceOptions {
  readonly name: string;
  readonly marker: MarkerRule;
}

// drizzle-kit's separator, split as drizzle splits it: anywhere, untrimmed.
// rootstock's own files use a whole-line split instead (migrations.ts).
const DRIZZLE_BREAKPOINT = "--> statement-breakpoint";

// drizzle reads with fs's utf8, which keeps a byte-order mark, and hashes that
// text, so the journal reader decodes the same way to reproduce its hash.
const KEEP_BOM = new TextDecoder("utf-8", { ignoreBOM: true });
// The SQL-folder origin reads with Bun.file().text(), which drops it.
const DROP_BOM = new TextDecoder("utf-8");

function fail(message: string): never {
  throw new Error(`rootstock migrate: ${message}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Opened {
  dir: URL;
  /** The folder as a path, for messages. */
  path: string;
  source: string;
  pattern: RegExp;
  baseline: string | undefined;
}

/** Checks a reader's arguments once, before any file is read. */
function open(folder: string | URL, opts: SourceOptions): Opened {
  const { name, marker } = (opts ?? {}) as Partial<SourceOptions>;
  if (typeof name !== "string" || name.trim() === "") {
    fail(`a source name must be a non-empty string — got ${q(name)}`);
  }
  if (marker === null || typeof marker !== "object") {
    fail(`source ${q(name)}: marker must be an object — got ${q(marker)}`);
  }
  if (marker.baseline !== undefined && typeof marker.baseline !== "string") {
    fail(`source ${q(name)}: marker baseline must be a string — got ${q(marker.baseline)}`);
  }
  let dir: URL;
  if (folder instanceof URL) {
    if (folder.protocol !== "file:") {
      fail(`a source folder must be a file: URL — got ${q(folder.href)}`);
    }
    dir = new URL(folder.href);
  } else {
    if (typeof folder !== "string" || !isAbsolute(folder)) {
      fail(`a source folder must be an absolute path or a file: URL — got ${q(folder)}`);
    }
    dir = pathToFileURL(folder);
  }
  if (!dir.pathname.endsWith("/")) dir.pathname += "/";
  return {
    dir,
    path: fileURLToPath(dir),
    source: name,
    pattern: markerPattern(marker.prefix),
    baseline: marker.baseline,
  };
}

interface Draft {
  id: string;
  key: string;
  sha256: string;
  text: string;
  statements: readonly string[];
}

function build(
  { source, pattern, baseline }: Opened,
  drafts: readonly Draft[],
): readonly SourceMigration[] {
  const at = baseline === undefined ? -1 : drafts.findIndex((d) => d.id === baseline);
  if (baseline !== undefined && at === -1) {
    fail(
      `source ${q(source)}: marker baseline ${q(baseline)} is not one of its migrations — the marker check would pass empty`,
    );
  }
  return Object.freeze(
    drafts.map((d, i) =>
      Object.freeze({
        source,
        id: d.id,
        key: d.key,
        sha256: d.sha256,
        kind: matchMarker(d.text, pattern),
        baselined: i <= at,
        statements: Object.freeze(d.statements),
      }),
    ),
  );
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/**
 * A drizzle-kit folder: `meta/_journal.json` in journal order, each `<tag>.sql`
 * split on `--> statement-breakpoint` as drizzle splits it. The hash is drizzle's
 * (`sha256` of the file text) and the key is the entry's `when`, which is what
 * drizzle stores in `__drizzle_migrations` as `hash` and `created_at`.
 *
 * Order is journal order. `when` need not increase: applying by set makes an
 * older `when` legitimate after two branches cross, and a status check names it.
 * Refuses an empty or malformed journal, a duplicate tag or `when`, and a
 * missing file, because each of those would read as "nothing pending".
 */
export function drizzleJournal(
  folder: string | URL,
  opts: SourceOptions,
): readonly SourceMigration[] {
  const opened = open(folder, opts);
  const { dir, path, source } = opened;
  let parsed: unknown;
  try {
    parsed = JSON.parse(KEEP_BOM.decode(readFileSync(new URL("meta/_journal.json", dir))));
  } catch (err) {
    fail(`source ${q(source)}: cannot read ${path}meta/_journal.json — ${reason(err)}`);
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
    let text: string;
    try {
      text = KEEP_BOM.decode(readFileSync(new URL(`${r.tag}.sql`, dir)));
    } catch (err) {
      fail(
        `source ${q(source)}: journal entry ${q(r.tag)} has no readable file ${r.tag}.sql — ${reason(err)}`,
      );
    }
    return {
      id: r.tag,
      key: String(r.when),
      sha256: sha256Hex(text),
      text,
      statements: text.split(DRIZZLE_BREAKPOINT).filter((s) => s.trim() !== ""),
    };
  });
  return build(opened, drafts);
}

/**
 * A folder of `.sql` files (lower-case extension, as the origin runner reads
 * them) applied in filename order (code-unit sort), each file as one statement
 * batch with any byte-order mark dropped (the simple query protocol runs it
 * whole). A symlink to a file counts as the file. Subfolders are ignored.
 * Refuses a folder with no `.sql` file, and a file it cannot read.
 */
export function sqlFolder(folder: string | URL, opts: SourceOptions): readonly SourceMigration[] {
  const opened = open(folder, opts);
  const { dir, path, source } = opened;
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    fail(`source ${q(source)}: cannot list ${path} — ${reason(err)}`);
  }
  const drafts: Draft[] = [];
  for (const file of names) {
    const url = new URL(file, dir);
    try {
      if (!statSync(url).isFile()) continue; // a subfolder named *.sql
      const bytes = readFileSync(url);
      const text = DROP_BOM.decode(bytes);
      drafts.push({ id: file, key: file, sha256: sha256Hex(bytes), text, statements: [text] });
    } catch (err) {
      fail(`source ${q(source)}: cannot read ${file} in ${path} — ${reason(err)}`);
    }
  }
  if (drafts.length === 0) fail(`source ${q(source)}: ${path} holds no .sql file — wrong folder?`);
  return build(opened, drafts);
}

/** Migrations after the baseline that carry no marker, for a PR-time check. */
export function unmarkedAfterBaseline(migrations: readonly SourceMigration[]): readonly string[] {
  return migrations.filter((m) => !m.baselined && m.kind === null).map((m) => m.id);
}
