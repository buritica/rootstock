import type { PathDiff } from "./diff.ts";
import { GoldenCaseError, messageOf } from "./errors.ts";
import {
  captureSuites,
  checkSuites,
  type GoldenProblem,
  type GoldenSuite,
  orphanGoldenFiles,
} from "./suite.ts";

/**
 * `runGoldenCli` exit codes. `mismatch` is the only code that means behavior
 * moved; `aborted` means the run could not compare at all.
 */
export const GOLDEN_EXIT = { ok: 0, mismatch: 1, usage: 2, aborted: 3 } as const;
export type GoldenExitCode = (typeof GOLDEN_EXIT)[keyof typeof GOLDEN_EXIT];

/** Runs `git` with `args`; `out` is trimmed stdout. */
export type GitRunner = (args: string[]) => { code: number; out: string };

export interface GoldenCliOptions {
  dir: string;
  repo: string;
  /** Paths whose code must match `base` at capture time. Default `["src"]`. */
  srcPaths?: string[];
  /** Ref the capture is pinned to. Default `"origin/main"`. */
  base?: string;
  /** Default `process.argv.slice(2)`. */
  argv?: string[];
  /**
   * Receives each stdout message, without its trailing newline. Default `process.stdout`.
   * A message is one line except the capture refusal, which keeps the v0.0.1 text: the header and the
   * changed-file list are one message joined by newlines.
   */
  write?: (line: string) => void;
  /** Receives each stderr line, without its newline. Default `process.stderr`. */
  writeErr?: (line: string) => void;
  /** Default `Bun.spawnSync(["git", ...args])`. */
  git?: GitRunner;
}

const MAX_CAUSES = 10;

function spawnGit(args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString().trim() };
}

function stdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function stderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** A golden file is committed data: a hash may be missing or not a string. */
function short(sha: unknown): string {
  if (sha === undefined) return "(missing)";
  if (typeof sha !== "string") return `(${sha === null ? "null" : typeof sha})`;
  return `${sha.slice(0, 8)}…`;
}

function diffLine(diff: PathDiff): string {
  switch (diff.change) {
    case "added":
      return `${diff.path} added: ${diff.actual}`;
    case "removed":
      return `${diff.path} removed: ${diff.expected}`;
    case "type":
      return `${diff.path} type: ${diff.expected} -> ${diff.actual}`;
    case "changed":
      if (diff.at !== undefined) {
        return `${diff.path} changed at ${diff.at} (length ${diff.expectedLength} -> ${diff.actualLength}): ${diff.expected} -> ${diff.actual}`;
      }
      return `${diff.path} changed: ${diff.expected} -> ${diff.actual}`;
  }
}

function problemLines(problem: GoldenProblem): string[] {
  switch (problem.kind) {
    case "missing-file":
      return [`missing-file ${problem.path}: run capture`];
    case "header-mismatch":
      return [`header-mismatch ${problem.path}: ${problem.detail}`];
    case "missing-case":
      return [`missing-case ${problem.id}: not recorded in the golden file`];
    case "extra-case":
      return [`extra-case ${problem.id}: recorded but no suite case produces it`];
    case "input-drift":
      return [
        `input-drift ${problem.id}: fixture input changed since capture (${short(problem.expected)} -> ${short(problem.actual)})`,
      ];
    case "output-mismatch": {
      const lines = [`output-mismatch ${problem.id}: output differs from capture`];
      for (const diff of problem.diffs) lines.push(`  ${diffLine(diff)}`);
      if (problem.diffsOmitted > 0) lines.push(`  … ${problem.diffsOmitted} more`);
      return lines;
    }
  }
}

/** The stack (or message) of `err` and of each `cause` under it. */
function errorReport(err: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSES; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const text =
      current instanceof Error ? (current.stack ?? `${current.name}: ${current.message}`) : null;
    lines.push(...`${depth === 0 ? "" : "caused by: "}${text ?? messageOf(current)}`.split("\n"));
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  return lines;
}

async function runCommand(
  suites: GoldenSuite[],
  opts: GoldenCliOptions,
  write: (line: string) => void,
): Promise<GoldenExitCode> {
  const argv = opts.argv ?? process.argv.slice(2);
  const command = argv[0];
  const base = opts.base ?? "origin/main";
  const srcPaths = opts.srcPaths ?? ["src"];
  const git = opts.git ?? spawnGit;

  if (command === "capture") {
    const mergeBase = git(["merge-base", "HEAD", base]);
    if (mergeBase.code !== 0 || !mergeBase.out) {
      write(`golden capture: cannot resolve merge-base with ${base}`);
      return GOLDEN_EXIT.usage;
    }
    const diff = git(["diff", "--name-only", mergeBase.out, "--", ...srcPaths]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...srcPaths]);
    // A failed listing would read as "nothing changed" and let the guard pass.
    for (const [what, result] of [
      ["git diff", diff],
      ["git ls-files", untracked],
    ] as const) {
      if (result.code !== 0) {
        throw new Error(`golden capture: ${what} failed with exit code ${result.code}`);
      }
    }
    const changed = [diff.out, untracked.out].filter(Boolean).join("\n");
    if (changed && !argv.includes("--allow-src-changes")) {
      write(
        `golden capture: refusing, these source files differ from ${mergeBase.out.slice(0, 12)}:\n${changed}`,
      );
      write(
        "re-run with --allow-src-changes only for an intentional behavior change, and say so in the PR",
      );
      return GOLDEN_EXIT.usage;
    }
    const written = await captureSuites(suites, {
      dir: opts.dir,
      repo: opts.repo,
      capturedFrom: changed ? `${mergeBase.out}+modified` : mergeBase.out,
    });
    for (const path of written) write(`wrote ${path}`);
    for (const orphan of await orphanGoldenFiles(suites, opts.dir)) {
      write(`orphan golden file (no suite produces it): ${orphan}`);
    }
    return GOLDEN_EXIT.ok;
  }

  if (command === "check") {
    const reports = await checkSuites(suites, { dir: opts.dir });
    let failed = 0;
    for (const report of reports) {
      const label = `${report.capability}/${report.profile}`;
      if (report.problems.length === 0) {
        write(`ok   ${label}`);
        continue;
      }
      failed++;
      write(`FAIL ${label}`);
      for (const problem of report.problems) {
        for (const line of problemLines(problem)) write(`     ${line}`);
      }
    }
    const orphans = await orphanGoldenFiles(suites, opts.dir);
    for (const orphan of orphans) write(`FAIL orphan golden file: ${orphan}`);
    return failed > 0 || orphans.length > 0 ? GOLDEN_EXIT.mismatch : GOLDEN_EXIT.ok;
  }

  write("usage: capture [--allow-src-changes] | check");
  return GOLDEN_EXIT.usage;
}

/**
 * `capture` records goldens; `check` compares against them. Capture refuses
 * (exit 2) when the source paths differ from the merge-base with `base`, so a
 * golden is never recorded from modified code by accident; pass
 * `--allow-src-changes` only for an intentional, outcome-changing re-capture,
 * which stamps `capturedFrom` as `<sha>+modified`.
 *
 * Never rejects. A case that throws, an unparseable golden file or any other
 * error prints one `ABORT` line, writes the stack and its `cause` chain to
 * `writeErr`, and resolves `GOLDEN_EXIT.aborted`.
 */
export async function runGoldenCli(
  suites: GoldenSuite[],
  opts: GoldenCliOptions,
): Promise<GoldenExitCode> {
  const write = opts.write ?? stdoutLine;
  const writeErr = opts.writeErr ?? stderrLine;
  try {
    return await runCommand(suites, opts, write);
  } catch (err) {
    try {
      write(
        err instanceof GoldenCaseError
          ? `ABORT ${err.capability}/${err.profile}/${err.caseId} threw (${err.phase}): ${messageOf(err.cause)}`
          : `ABORT run: ${messageOf(err)}`,
      );
      for (const line of errorReport(err)) writeErr(line);
    } catch {
      // Reporting is best effort; the exit code still says the run aborted.
    }
    return GOLDEN_EXIT.aborted;
  }
}
