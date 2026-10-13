import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitRunner, type GoldenCliOptions, runGoldenCli } from "./cli.ts";
import { captureSuites, type GoldenSuite, goldenPath } from "./suite.ts";

const BASE_SHA = "a".repeat(40);

function suite(run: (s: string) => unknown, input = "hello", profile = "test-v1"): GoldenSuite {
  return {
    capability: "chunk.split",
    profile,
    cases: [
      { id: "one", input, run: () => run(input) },
      { id: "two", input: "x", run: () => run("x") },
    ],
  };
}

const upper = (s: string) => ({ text: s.toUpperCase(), n: s.length });

/** A git stand-in: merge-base answers BASE_SHA, the two listings answer `changed`. */
function fakeGit(
  changed = "",
  overrides: Partial<Record<string, { code: number; out: string }>> = {},
): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = (args) => {
    calls.push(args);
    const sub = args[0] ?? "";
    const override = overrides[sub];
    if (override) return override;
    if (sub === "merge-base") return { code: 0, out: BASE_SHA };
    if (sub === "diff") return { code: 0, out: changed };
    return { code: 0, out: "" };
  };
  return { git, calls };
}

async function cli(
  suites: GoldenSuite[],
  argv: string[],
  extra: Partial<GoldenCliOptions> & { dir?: string } = {},
): Promise<{ code: number; out: string[]; err: string[]; dir: string }> {
  const dir = extra.dir ?? (await mkdtemp(join(tmpdir(), "golden-cli-")));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runGoldenCli(suites, {
    dir,
    repo: "test",
    argv,
    git: fakeGit().git,
    write: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    ...extra,
  });
  return { code, out, err, dir };
}

async function capturedDir(...suites: GoldenSuite[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-cli-"));
  await captureSuites(suites, { dir, repo: "test", capturedFrom: BASE_SHA });
  return dir;
}

describe("check", () => {
  test("0 when every suite matches", async () => {
    const dir = await capturedDir(suite(upper));
    expect(await cli([suite(upper)], ["check"], { dir })).toMatchObject({
      code: 0,
      out: ["ok   chunk.split/test-v1"],
      err: [],
    });
  });

  test("1 with readable problem lines", async () => {
    const dir = await capturedDir(suite(upper));
    const result = await cli([suite((s) => ({ text: s, n: s.length }), "hello!")], ["check"], {
      dir,
    });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      "FAIL chunk.split/test-v1",
      "     input-drift one: fixture input changed since capture (5aa762ae… -> d4aa7349…)",
      "     output-mismatch one: output differs from capture",
      "       $.n changed: 5 -> 6",
      '       $.text changed at 0 (length 5 -> 6): "HELLO" -> "hello!"',
      "     output-mismatch two: output differs from capture",
      '       $.text changed at 0 (length 1 -> 1): "X" -> "x"',
    ]);
  });

  test("added, removed, type and omitted lines", async () => {
    const wide = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    const dir = await capturedDir(suite(() => ({ a: 1, b: "s", list: [1], wide: wide(22) })));
    const result = await cli(
      [suite(() => ({ b: 1, c: null, list: [1, 2], wide: wide(0) }))],
      ["check"],
      { dir },
    );
    expect(result.code).toBe(1);
    expect(result.out.slice(0, 9)).toEqual([
      "FAIL chunk.split/test-v1",
      "     output-mismatch one: output differs from capture",
      "       $.a removed: 1",
      '       $.b type: "s" -> 1',
      "       $.c added: null",
      "       $.list[1] added: 2",
      "       $.wide.k0 removed: 0",
      "       $.wide.k1 removed: 1",
      "       $.wide.k10 removed: 10",
    ]);
    expect(result.out[22]).toBe("       … 6 more");
  });

  test("missing file, missing case, extra case and header lines", async () => {
    const dir = await capturedDir(suite(upper));
    const path = goldenPath(dir, suite(upper));
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"format": 1', '"format": 2'));
    const renamed: GoldenSuite = {
      ...suite(upper),
      cases: [
        { id: "one", input: "hello", run: () => upper("hello") },
        { id: "three", input: 3, run: () => 3 },
      ],
    };
    const result = await cli([renamed, suite(upper, "hello", "absent-v1")], ["check"], { dir });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      "FAIL chunk.split/test-v1",
      `     header-mismatch ${path}: file says 2/chunk.split/test-v1`,
      "     missing-case three: not recorded in the golden file",
      "     extra-case two: recorded but no suite case produces it",
      "FAIL chunk.split/absent-v1",
      `     missing-file ${join(dir, "chunk.split", "absent-v1.json")}: run capture`,
    ]);
  });

  test("1 for an orphan file alone", async () => {
    const dir = await capturedDir(suite(upper));
    await writeFile(join(dir, "chunk.split", "old-v1.json"), "{}");
    expect(await cli([suite(upper)], ["check"], { dir })).toMatchObject({
      code: 1,
      out: ["ok   chunk.split/test-v1", "FAIL orphan golden file: chunk.split/old-v1.json"],
    });
  });

  test("3 with an ABORT line and the stack plus cause on writeErr when a case throws", async () => {
    const dir = await capturedDir(suite(upper));
    const result = await cli(
      [
        suite((s) => {
          if (s === "x") throw new Error("boom");
          return upper(s);
        }),
      ],
      ["check"],
      { dir },
    );
    expect(result.code).toBe(3);
    expect(result.out).toEqual(["ABORT chunk.split/test-v1/two threw (run): boom"]);
    expect(result.err[0]).toBe(
      "GoldenCaseError: golden case chunk.split/test-v1/two threw (run): boom",
    );
    expect(result.err[1]).toStartWith("    at ");
    expect(result.err).toContain("caused by: Error: boom");
  });

  test("3 for an unparseable golden file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-cli-"));
    await mkdir(join(dir, "chunk.split"));
    const path = join(dir, "chunk.split", "test-v1.json");
    await writeFile(path, '{"format": 1, "cases": [');
    const result = await cli([suite(upper)], ["check"], { dir });
    expect(result.code).toBe(3);
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toStartWith(`ABORT run: golden file ${path} is unreadable: `);
    expect(result.err[0]).toStartWith("GoldenFileError: ");
    expect(result.err.some((line) => line.startsWith("caused by: SyntaxError"))).toBe(true);
  });

  test("3 for an invalid suite", async () => {
    const bad = { ...suite(upper), capability: "nope" } as unknown as GoldenSuite;
    expect(await cli([bad], ["check"])).toMatchObject({
      code: 3,
      out: ['ABORT run: golden: unknown capability "nope"'],
    });
  });
});

describe("capture", () => {
  test("0, writes from a clean tree, and pins capturedFrom to the merge-base", async () => {
    const { git, calls } = fakeGit();
    const result = await cli([suite(upper)], ["capture"], { git, srcPaths: ["src", "lib"] });
    const path = goldenPath(result.dir, suite(upper));
    expect(result).toMatchObject({ code: 0, out: [`wrote ${path}`], err: [] });
    expect(JSON.parse(await readFile(path, "utf8")).capturedFrom).toBe(BASE_SHA);
    expect(calls).toEqual([
      ["merge-base", "HEAD", "origin/main"],
      ["diff", "--name-only", BASE_SHA, "--", "src", "lib"],
      ["ls-files", "--others", "--exclude-standard", "--", "src", "lib"],
    ]);
  });

  test("2 with the refusal hint when sources changed, and nothing written", async () => {
    const result = await cli([suite(upper)], ["capture"], { git: fakeGit("src/a.ts").git });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([
      "golden capture: refusing, these source files differ from aaaaaaaaaaaa:\nsrc/a.ts",
      "re-run with --allow-src-changes only for an intentional behavior change, and say so in the PR",
    ]);
    expect(await readdir(result.dir)).toEqual([]);
  });

  test("--allow-src-changes stamps +modified only when something changed", async () => {
    const changed = await cli([suite(upper)], ["capture", "--allow-src-changes"], {
      git: fakeGit("src/a.ts").git,
    });
    expect(changed.code).toBe(0);
    const changedFile = await readFile(goldenPath(changed.dir, suite(upper)), "utf8");
    expect(JSON.parse(changedFile).capturedFrom).toBe(`${BASE_SHA}+modified`);

    const clean = await cli([suite(upper)], ["capture", "--allow-src-changes"]);
    const cleanFile = await readFile(goldenPath(clean.dir, suite(upper)), "utf8");
    expect(JSON.parse(cleanFile).capturedFrom).toBe(BASE_SHA);
  });

  test("an untracked file counts as a change", async () => {
    const { git } = fakeGit("", { "ls-files": { code: 0, out: "src/new.ts" } });
    expect((await cli([suite(upper)], ["capture"], { git })).code).toBe(2);
  });

  test("2 when the merge-base cannot be resolved", async () => {
    const { git } = fakeGit("", { "merge-base": { code: 128, out: "" } });
    expect(await cli([suite(upper)], ["capture"], { git, base: "origin/trunk" })).toMatchObject({
      code: 2,
      out: ["golden capture: cannot resolve merge-base with origin/trunk"],
    });
  });

  test("3 when a source listing fails, instead of reading it as unchanged", async () => {
    const { git } = fakeGit("", { diff: { code: 128, out: "" } });
    const result = await cli([suite(upper)], ["capture"], { git });
    expect(result.code).toBe(3);
    expect(result.out).toEqual(["ABORT run: golden capture: git diff failed with exit code 128"]);
    expect(await readdir(result.dir)).toEqual([]);
  });

  test("3 and nothing written when a case throws", async () => {
    const result = await cli(
      [
        suite(upper, "hello", "a-v1"),
        suite(
          () => {
            throw new TypeError("bad");
          },
          "hello",
          "b-v1",
        ),
      ],
      ["capture"],
    );
    expect(result.code).toBe(3);
    expect(result.out).toEqual(["ABORT chunk.split/b-v1/one threw (run): bad"]);
    expect(await readdir(result.dir)).toEqual([]);
  });

  test("orphans are reported but do not fail a capture", async () => {
    const dir = await capturedDir(suite(upper, "hello", "old-v1"));
    expect(await cli([suite(upper)], ["capture"], { dir })).toMatchObject({
      code: 0,
      out: [
        `wrote ${join(dir, "chunk.split", "test-v1.json")}`,
        "orphan golden file (no suite produces it): chunk.split/old-v1.json",
      ],
    });
  });
});

describe("usage and resilience", () => {
  test("2 for no command or an unknown one", async () => {
    for (const argv of [[], ["recapture"]]) {
      expect(await cli([suite(upper)], argv)).toMatchObject({
        code: 2,
        out: ["usage: capture [--allow-src-changes] | check"],
      });
    }
  });

  test("never rejects: a throwing git runner or writer still resolves 3", async () => {
    const git: GitRunner = () => {
      throw new Error("git: not found");
    };
    expect(await cli([suite(upper)], ["capture"], { git })).toMatchObject({
      code: 3,
      out: ["ABORT run: git: not found"],
    });

    const dir = await capturedDir(suite(upper));
    const code = await runGoldenCli([suite(upper)], {
      dir,
      repo: "test",
      argv: ["check"],
      write: () => {
        throw new Error("stdout closed");
      },
      writeErr: () => {
        throw new Error("stderr closed");
      },
    });
    expect(code).toBe(3);
  });

  test("a cause cycle is reported once", async () => {
    const dir = await capturedDir(suite(upper));
    const looped = new Error("loop");
    looped.cause = looped;
    const result = await cli(
      [
        suite(() => {
          throw looped;
        }),
      ],
      ["check"],
      { dir },
    );
    expect(result.code).toBe(3);
    expect(result.err.filter((line) => line.startsWith("caused by: "))).toEqual([
      "caused by: Error: loop",
    ]);
  });
});
