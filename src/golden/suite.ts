import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { type CapabilityId, isCapabilityId } from "./capabilities.ts";
import { diffCanonicalTexts, type PathDiff } from "./diff.ts";
import { GoldenCaseError, GoldenFileError } from "./errors.ts";

export const GOLDEN_FORMAT = 1;

/**
 * One recorded behavior. `input` is hashed, never stored: it may be large,
 * and fixture content belongs in the consumer repo, not duplicated into
 * every golden file. `run` must be deterministic — no clock, no randomness,
 * no network (use `createRecordingFetch`), no shared database.
 */
export interface GoldenCase {
  id: string;
  input: unknown;
  run: () => unknown | Promise<unknown>;
}

export interface GoldenSuite {
  capability: CapabilityId;
  /** Names the behavior variant, e.g. "mycel-v1", "dian-articles". */
  profile: string;
  cases: GoldenCase[];
}

export interface GoldenFile {
  format: typeof GOLDEN_FORMAT;
  repo: string;
  capability: CapabilityId;
  profile: string;
  /** The commit whose code produced these outputs. */
  capturedFrom: string;
  cases: GoldenFileCase[];
}

export interface GoldenFileCase {
  id: string;
  inputSha256: string;
  output: unknown;
}

export type GoldenProblem =
  | { kind: "missing-file"; path: string }
  | { kind: "header-mismatch"; path: string; detail: string }
  | { kind: "missing-case"; id: string }
  | { kind: "extra-case"; id: string }
  | { kind: "input-drift"; id: string; expected: string; actual: string }
  | {
      kind: "output-mismatch";
      id: string;
      expected: string;
      actual: string;
      /** Where the outputs differ, at most 20 entries; `diffsOmitted` counts the rest. */
      diffs: PathDiff[];
      diffsOmitted: number;
    };

export interface SuiteReport {
  capability: CapabilityId;
  profile: string;
  path: string;
  problems: GoldenProblem[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

export function goldenPath(dir: string, suite: GoldenSuite): string {
  return join(dir, suite.capability, `${suite.profile}.json`);
}

export function validateSuites(suites: GoldenSuite[]): void {
  const seen = new Set<string>();
  for (const suite of suites) {
    if (!isCapabilityId(suite.capability)) {
      throw new Error(`golden: unknown capability "${suite.capability}"`);
    }
    if (!PROFILE_PATTERN.test(suite.profile)) {
      throw new Error(`golden: bad profile "${suite.profile}"`);
    }
    const key = `${suite.capability}/${suite.profile}`;
    if (seen.has(key)) throw new Error(`golden: duplicate suite ${key}`);
    seen.add(key);
    if (suite.cases.length === 0) {
      throw new Error(`golden: suite ${key} has no cases`);
    }
    const ids = new Set<string>();
    for (const c of suite.cases) {
      if (!ID_PATTERN.test(c.id)) {
        throw new Error(`golden: bad case id "${c.id}" in ${key}`);
      }
      if (ids.has(c.id)) {
        throw new Error(`golden: duplicate case id "${c.id}" in ${key}`);
      }
      ids.add(c.id);
    }
  }
}

/** Runs one case and returns its output as canonical JSON (validating it). */
export async function runCase(
  c: GoldenCase,
): Promise<{ inputSha256: string; output: unknown; canonical: string }> {
  const inputSha256 = sha256Hex(canonicalJson(c.input));
  const output = await c.run();
  return { inputSha256, output, canonical: canonicalJson(output) };
}

/**
 * Like `runCase`, but a throw is rethrown as a `GoldenCaseError` naming the
 * suite, the case and the phase that threw.
 */
export async function runSuiteCase(
  suite: GoldenSuite,
  c: GoldenCase,
): Promise<{ inputSha256: string; output: unknown; canonical: string }> {
  const fail = (phase: "input" | "run" | "output", cause: unknown) =>
    new GoldenCaseError(suite.capability, suite.profile, c.id, phase, { cause });
  let inputSha256: string;
  try {
    inputSha256 = sha256Hex(canonicalJson(c.input));
  } catch (cause) {
    throw fail("input", cause);
  }
  let output: unknown;
  try {
    output = await c.run();
  } catch (cause) {
    throw fail("run", cause);
  }
  try {
    return { inputSha256, output, canonical: canonicalJson(output) };
  } catch (cause) {
    throw fail("output", cause);
  }
}

/**
 * Runs every suite and writes its golden file. Returns the written paths.
 *
 * Every case of every suite runs before anything is written, so a case that
 * throws (rejecting with `GoldenCaseError`) leaves every existing golden file
 * as it was. The files are then written in one synchronous pass, each to
 * `<path>.rootstock-tmp` and renamed into place.
 */
export async function captureSuites(
  suites: GoldenSuite[],
  opts: { dir: string; repo: string; capturedFrom: string },
): Promise<string[]> {
  validateSuites(suites);
  const pending: { dir: string; path: string; text: string }[] = [];
  for (const suite of suites) {
    const cases: GoldenFileCase[] = [];
    // Sequential on purpose: cases share fixtures and must not race.
    for (const c of suite.cases) {
      const { inputSha256, output } = await runSuiteCase(suite, c);
      cases.push({ id: c.id, inputSha256, output });
    }
    const file: GoldenFile = {
      format: GOLDEN_FORMAT,
      repo: opts.repo,
      capability: suite.capability,
      profile: suite.profile,
      capturedFrom: opts.capturedFrom,
      cases,
    };
    pending.push({
      dir: join(opts.dir, suite.capability),
      path: goldenPath(opts.dir, suite),
      text: `${canonicalJson(file, 2)}\n`,
    });
  }
  const written: string[] = [];
  for (const { dir, path, text } of pending) {
    mkdirSync(dir, { recursive: true });
    const temp = `${path}.rootstock-tmp`;
    try {
      writeFileSync(temp, text);
      renameSync(temp, path);
    } catch (err) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // The write error is the one worth reporting.
      }
      throw err;
    }
    written.push(path);
  }
  return written;
}

export async function readGoldenFile(path: string): Promise<GoldenFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as GoldenFile;
}

/** Reads a committed golden file for `checkSuites`; anything unusable is a `GoldenFileError`. */
async function readCommittedFile(path: string): Promise<GoldenFile | undefined> {
  let file: GoldenFile | undefined;
  try {
    file = await readGoldenFile(path);
  } catch (cause) {
    throw new GoldenFileError(path, { cause });
  }
  if (
    file &&
    (!Array.isArray(file.cases) || file.cases.some((c) => typeof c !== "object" || c === null))
  ) {
    throw new GoldenFileError(path, { cause: new TypeError("cases is not a list of objects") });
  }
  return file;
}

/**
 * Re-runs every suite against its committed golden file. The first case that
 * throws, in suite order, rejects with `GoldenCaseError`; a golden file that
 * cannot be parsed rejects with `GoldenFileError`.
 */
export async function checkSuites(
  suites: GoldenSuite[],
  opts: { dir: string },
): Promise<SuiteReport[]> {
  validateSuites(suites);
  const reports: SuiteReport[] = [];
  for (const suite of suites) {
    const path = goldenPath(opts.dir, suite);
    const problems: GoldenProblem[] = [];
    const file = await readCommittedFile(path);
    if (!file) {
      problems.push({ kind: "missing-file", path });
    } else {
      if (
        file.format !== GOLDEN_FORMAT ||
        file.capability !== suite.capability ||
        file.profile !== suite.profile
      ) {
        problems.push({
          kind: "header-mismatch",
          path,
          detail: `file says ${file.format}/${file.capability}/${file.profile}`,
        });
      }
      const recorded = new Map(file.cases.map((c) => [c.id, c]));
      for (const c of suite.cases) {
        const expected = recorded.get(c.id);
        if (!expected) {
          problems.push({ kind: "missing-case", id: c.id });
          continue;
        }
        recorded.delete(c.id);
        const actual = await runSuiteCase(suite, c);
        if (actual.inputSha256 !== expected.inputSha256) {
          problems.push({
            kind: "input-drift",
            id: c.id,
            expected: expected.inputSha256,
            actual: actual.inputSha256,
          });
        }
        let expectedCanonical: string;
        try {
          expectedCanonical = canonicalJson(expected.output);
        } catch (cause) {
          throw new GoldenFileError(path, { cause });
        }
        if (actual.canonical !== expectedCanonical) {
          problems.push({
            kind: "output-mismatch",
            id: c.id,
            expected: expectedCanonical,
            actual: actual.canonical,
            ...diffCanonicalTexts(expectedCanonical, actual.canonical),
          });
        }
      }
      for (const id of recorded.keys()) problems.push({ kind: "extra-case", id });
    }
    reports.push({
      capability: suite.capability,
      profile: suite.profile,
      path,
      problems,
    });
  }
  return reports;
}

/** Golden files under `dir` that no suite produces (renamed or deleted suites). */
export async function orphanGoldenFiles(suites: GoldenSuite[], dir: string): Promise<string[]> {
  const expected = new Set(suites.map((s) => goldenPath(dir, s)));
  const orphans: string[] = [];
  let capabilities: string[];
  try {
    capabilities = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  for (const cap of capabilities) {
    if (!isCapabilityId(cap)) continue;
    for (const name of await readdir(join(dir, cap))) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, cap, name);
      if (!expected.has(path)) orphans.push(relative(dir, path));
    }
  }
  return orphans.sort();
}
