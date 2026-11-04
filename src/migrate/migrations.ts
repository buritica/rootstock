import { readFileSync } from "node:fs";
import { sha256Hex } from "../hash/index.ts";
import { MANIFEST } from "./manifest.ts";
import { MARKER_WINDOW_LINES, type MigrationKind, markerPattern, matchMarker } from "./marker.ts";

export type { MigrationKind } from "./marker.ts";

export interface RootstockMigration {
  readonly filename: string;
  /** Lowercase hex of the file's bytes. */
  readonly sha256: string;
  readonly kind: MigrationKind;
  readonly statements: readonly string[];
}

const MARKER = markerPattern("rootstock");
const BREAKPOINT = /^--> statement-breakpoint$/m;

/** Hashes, classifies and splits one migration file's bytes. */
export function parseMigration(filename: string, bytes: Uint8Array): RootstockMigration {
  const text = new TextDecoder().decode(bytes);
  const kind = matchMarker(text, MARKER);
  if (kind === null) {
    throw new Error(
      `rootstockMigrations: ${filename} has no "-- rootstock-migration: additive|heavy" line in its first ${MARKER_WINDOW_LINES} lines`,
    );
  }
  return Object.freeze({
    filename,
    sha256: sha256Hex(bytes),
    kind,
    statements: Object.freeze(
      text
        .split(BREAKPOINT)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  });
}

let shipped: readonly RootstockMigration[] | undefined;

/** The migrations this package ships, in filename order. Read once per process. */
export function rootstockMigrations(): readonly RootstockMigration[] {
  shipped ??= Object.freeze(
    MANIFEST.map((f) =>
      parseMigration(f, readFileSync(new URL(`./migrations/${f}`, import.meta.url))),
    ),
  );
  return shipped;
}
