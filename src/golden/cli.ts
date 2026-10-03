import { canonicalJson } from "./canonical.ts";
import { captureSuites, checkSuites, type GoldenSuite, orphanGoldenFiles } from "./suite.ts";

function git(args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString().trim() };
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * `capture` records goldens; `check` compares against them (exit 1 on any
 * problem). Capture refuses when the source paths differ from the base
 * commit, so a golden can never be recorded from modified code by accident.
 * Pass `--allow-src-changes` only for an intentional, outcome-changing
 * re-capture (Phase 2), and say so in the PR.
 */
export async function runGoldenCli(
  suites: GoldenSuite[],
  opts: {
    dir: string;
    repo: string;
    /** Paths whose code must match `base` at capture time. */
    srcPaths?: string[];
    /** Ref the capture is pinned to. */
    base?: string;
    argv?: string[];
  },
): Promise<number> {
  const argv = opts.argv ?? process.argv.slice(2);
  const command = argv[0];
  const base = opts.base ?? "origin/main";
  const srcPaths = opts.srcPaths ?? ["src"];

  if (command === "capture") {
    const mergeBase = git(["merge-base", "HEAD", base]);
    if (mergeBase.code !== 0 || !mergeBase.out) {
      write(`golden capture: cannot resolve merge-base with ${base}`);
      return 2;
    }
    const diff = git(["diff", "--name-only", mergeBase.out, "--", ...srcPaths]);
    const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...srcPaths]);
    const changed = [diff.out, untracked.out].filter(Boolean).join("\n");
    if (changed && !argv.includes("--allow-src-changes")) {
      write(
        `golden capture: refusing, these source files differ from ${mergeBase.out.slice(0, 12)}:\n${changed}`,
      );
      return 2;
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
    return 0;
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
      for (const problem of report.problems) write(`     ${canonicalJson(problem)}`);
    }
    const orphans = await orphanGoldenFiles(suites, opts.dir);
    for (const orphan of orphans) write(`FAIL orphan golden file: ${orphan}`);
    return failed > 0 || orphans.length > 0 ? 1 : 0;
  }

  write("usage: capture [--allow-src-changes] | check");
  return 2;
}
