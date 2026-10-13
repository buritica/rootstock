import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSuites, type GoldenSuite } from "./suite.ts";

// registerGoldenTests registers real `bun test` cases, so it is exercised in a
// child `bun test` run against goldens captured here.

const CAPTURED: GoldenSuite = {
  capability: "chunk.split",
  profile: "child-v1",
  cases: [
    { id: "same", input: "a", run: () => ({ v: 1 }) },
    { id: "out", input: "b", run: () => ({ v: 1 }) },
    { id: "both", input: "c", run: () => ({ v: 1 }) },
    { id: "input", input: "d", run: () => ({ v: 1 }) },
    { id: "throws", input: "e", run: () => ({ v: 1 }) },
  ],
};

const CHILD = (harness: string, dir: string) => `
import { registerGoldenTests } from ${JSON.stringify(harness)};
registerGoldenTests(
  [
    {
      capability: "chunk.split",
      profile: "child-v1",
      cases: [
        { id: "same", input: "a", run: () => ({ v: 1 }) },
        { id: "out", input: "b", run: () => ({ v: 2 }) },
        { id: "both", input: "c-changed", run: () => ({ v: 2 }) },
        { id: "input", input: "d-changed", run: () => ({ v: 1 }) },
        { id: "throws", input: "e", run: () => { throw new Error("child boom"); } },
      ],
    },
  ],
  { dir: ${JSON.stringify(dir)} },
);
`;

/** The report lines for one failing test: after the previous "(fail)" line, up to this test's. */
function blockFor(output: string, id: string): string[] {
  const lines = output.split("\n");
  const end = lines.findIndex((line) =>
    line.startsWith(`(fail) golden chunk.split/child-v1 > ${id} `),
  );
  if (end < 0) return [];
  let start = end - 1;
  while (start >= 0 && !(lines[start] ?? "").startsWith("(fail) ")) start--;
  return lines.slice(start + 1, end);
}

test("each failure names what moved", async () => {
  const root = await mkdtemp(join(tmpdir(), "golden-bun-test-"));
  const dir = join(root, "data");
  await captureSuites([CAPTURED], { dir, repo: "test", capturedFrom: "abc" });
  await writeFile(join(root, "child.test.ts"), CHILD(join(import.meta.dir, "bun-test.ts"), dir));

  const proc = Bun.spawnSync([process.execPath, "test", "./child.test.ts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  expect(proc.exitCode).toBe(1);

  // Bun reports only failures when stdout is not a terminal.
  expect(output).toContain(" 2 pass\n");
  expect(output).toContain(" 4 fail\n");
  expect(output).not.toContain("(fail) golden chunk.split/child-v1 > same ");
  expect(output).not.toContain("(fail) golden chunk.split/child-v1 > golden file matches");

  const out = blockFor(output, "out");
  expect(out).toContain("error: output differs");
  expect(out).toContain('+   "v": 2');

  expect(blockFor(output, "both")).toContain("error: output differs (fixture input also changed)");

  const input = blockFor(output, "input");
  expect(input).toContain("error: fixture input changed since capture (output unchanged)");
  expect(input.filter((line) => line.startsWith("error: "))).toHaveLength(1);

  expect(blockFor(output, "throws")).toContain(
    "GoldenCaseError: golden case chunk.split/child-v1/throws threw (run): child boom",
  );
});
