import { existsSync, readdirSync, readFileSync } from "node:fs";
import { sha256Hex } from "../hash/index.ts";
import { q } from "./identifier.ts";
import type { MigrationKind } from "./migrations.ts";

/** One migration file of a consumer's source, as the applier and the checks see it. */
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
  /** Lowercase hex sha256, computed as the origin migrator computes its stored hash. */
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
  /** The last id that predates the marker. It must be in the source; omit it when every file is marked. */
  readonly baseline?: string;
}

export interface SourceOptions {
  readonly name: string;
  readonly marker: MarkerRule;
}

const MARKER_WINDOW_LINES = 40;
const PREFIX = /^[a-z][a-z0-9-]*$/;
const BREAKPOINT = "--> statement-breakpoint";

function fail(message: string): never {
  throw new Error(`rootstock migrate: ${message}`);
}

function markerPattern(prefix: string): RegExp {
  if (!PREFIX.test(prefix)) fail(`marker prefix must match [a-z][a-z0-9-]* — got ${q(prefix)}`);
  return new RegExp(`^--\\s*${prefix}-migration:\\s*(additive|heavy)\\s*$`, "m");
}

/**
 * The `-- <prefix>-migration: additive|heavy` marker in the first 40 lines, or
 * null. Only the header counts, so a marker quoted inside a statement does not.
 */
export function parseMarker(text: string, prefix: string): MigrationKind | null {
  const head = text.split("\n").slice(0, MARKER_WINDOW_LINES).join("\n");
  return (markerPattern(prefix).exec(head)?.[1] as MigrationKind | undefined) ?? null;
}

// Decoded the way the origin migrators read their files (fs's utf8, which keeps
// a byte-order mark), so the hash of the re-encoded text is the one they stored.
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

function readText(folder: URL, file: string): string {
  return UTF8.decode(readFileSync(new URL(file, folder)));
}

function folderUrl(folder: string | URL): URL {
  let url: URL;
  if (folder instanceof URL) url = new URL(folder.href);
  else {
    if (!folder.startsWith("/"))
      fail(`a source folder must be an absolute path or a file: URL — got ${q(folder)}`);
    url = new URL("file:///");
    url.pathname = folder; // percent-encodes what a path may hold and a URL may not
  }
  if (url.protocol !== "file:") fail(`a source folder must be a file: URL — got ${q(url.href)}`);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "")
    fail(`a source name must be a non-empty string — got ${q(name)}`);
  return name;
}

interface Draft {
  id: string;
  key: string;
  text: string;
  statements: readonly string[];
}

function build(opts: SourceOptions, drafts: readonly Draft[]): readonly SourceMigration[] {
  const source = checkName(opts.name);
  const { prefix, baseline } = opts.marker;
  markerPattern(prefix);
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
        sha256: sha256Hex(d.text),
        kind: parseMarker(d.text, prefix),
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
 * Refuses an empty or malformed journal, a duplicate tag or `when`, and a
 * missing file, because each of those would read as "nothing pending".
 */
export function drizzleJournal(
  folder: string | URL,
  opts: SourceOptions,
): readonly SourceMigration[] {
  const dir = folderUrl(folder);
  const name = checkName(opts.name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(dir, "meta/_journal.json"));
  } catch (err) {
    fail(
      `source ${q(name)}: cannot read ${dir.pathname}meta/_journal.json — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`source ${q(name)}: the journal has no entries — wrong folder?`);
  }
  const tags = new Set<string>();
  const whens = new Set<number>();
  const drafts = entries.map((e: unknown): Draft => {
    const r = (e ?? {}) as { tag?: unknown; when?: unknown };
    if (typeof r.tag !== "string" || !/^[\w-]+$/.test(r.tag) || !isInt(r.when)) {
      fail(`source ${q(name)}: journal entry is malformed — got ${q(e)}`);
    }
    if (tags.has(r.tag) || whens.has(r.when)) {
      fail(
        `source ${q(name)}: journal entry ${q(r.tag)} repeats a tag or a when — each must be unique`,
      );
    }
    tags.add(r.tag);
    whens.add(r.when);
    const file = `${r.tag}.sql`;
    if (!existsSync(new URL(file, dir)))
      fail(`source ${q(name)}: journal entry ${q(r.tag)} has no file ${file}`);
    const text = readText(dir, file);
    return {
      id: r.tag,
      key: String(r.when),
      text,
      statements: text.split(BREAKPOINT).filter((s) => s.trim() !== ""),
    };
  });
  return build(opts, drafts);
}

/**
 * A folder of `.sql` files applied in filename order, each file as one
 * statement batch (the simple query protocol runs it whole). Other entries,
 * subfolders included, are ignored. Refuses a folder with no `.sql` file.
 */
export function sqlFolder(folder: string | URL, opts: SourceOptions): readonly SourceMigration[] {
  const dir = folderUrl(folder);
  const name = checkName(opts.name);
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".sql"))
      .map((d) => d.name)
      .sort();
  } catch (err) {
    fail(
      `source ${q(name)}: cannot list ${dir.pathname} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (files.length === 0)
    fail(`source ${q(name)}: ${dir.pathname} holds no .sql file — wrong folder?`);
  return build(
    opts,
    files.map((file) => {
      const text = readText(dir, file);
      return { id: file, key: file, text, statements: [text] };
    }),
  );
}

/** Migrations after the baseline that carry no marker, for a PR-time check. */
export function unmarkedAfterBaseline(migrations: readonly SourceMigration[]): readonly string[] {
  return migrations.filter((m) => !m.baselined && m.kind === null).map((m) => m.id);
}
