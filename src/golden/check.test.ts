import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldenCaseError, GoldenFileError } from "./errors.ts";
import { captureSuites, checkSuites, type GoldenSuite, goldenPath } from "./suite.ts";

const HELLO_SHA = "5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a";
const HELLO_BANG_SHA = "d4aa734920dae98d8807ddc10edac9b3c08a097d06ee3142b1f3fff421c06f3d";

function suite(
  profile: string,
  run: (s: string) => unknown,
  input: unknown = "hello",
): GoldenSuite {
  return {
    capability: "chunk.split",
    profile,
    cases: [
      { id: "one", input, run: () => run(String(input)) },
      { id: "two", input: "x", run: () => run("x") },
    ],
  };
}

const upper = (s: string) => ({ text: s.toUpperCase(), n: s.length });

async function captured(...suites: GoldenSuite[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-check-"));
  await captureSuites(suites, { dir, repo: "test", capturedFrom: "abc" });
  return dir;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("check: a throwing case", () => {
  test("run phase", async () => {
    const dir = await captured(suite("test-v1", upper));
    const boom = new Error("boom");
    const err = await rejection(
      checkSuites(
        [
          suite("test-v1", (s) => {
            if (s === "x") throw boom;
            return upper(s);
          }),
        ],
        { dir },
      ),
    );
    expect(err).toBeInstanceOf(GoldenCaseError);
    expect(err).toBeInstanceOf(Error);
    const e = err as GoldenCaseError;
    expect(e.name).toBe("GoldenCaseError");
    expect(e.message).toBe("golden case chunk.split/test-v1/two threw (run): boom");
    expect([e.capability, e.profile, e.caseId, e.phase]).toEqual([
      "chunk.split",
      "test-v1",
      "two",
      "run",
    ]);
    expect(e.cause).toBe(boom);
  });

  test("output phase: an output canonical JSON refuses", async () => {
    const dir = await captured(suite("test-v1", upper));
    const e = (await rejection(
      checkSuites([suite("test-v1", () => ({ n: Number.NaN }))], { dir }),
    )) as GoldenCaseError;
    expect(e.phase).toBe("output");
    expect(e.message).toBe(
      "golden case chunk.split/test-v1/one threw (output): canonicalJson: non-finite number at $.n",
    );
  });

  test("input phase: an input canonical JSON refuses", async () => {
    const dir = await captured(suite("test-v1", upper));
    const e = (await rejection(
      checkSuites([suite("test-v1", upper, new Map())], { dir }),
    )) as GoldenCaseError;
    expect(e.phase).toBe("input");
    expect(e.message).toBe(
      "golden case chunk.split/test-v1/one threw (input): canonicalJson: unsupported Map at $",
    );
  });

  test("a non-Error throw is named by its string form", async () => {
    const dir = await captured(suite("test-v1", upper));
    const e = (await rejection(
      checkSuites(
        [
          suite("test-v1", () => {
            throw "plain";
          }),
        ],
        { dir },
      ),
    )) as GoldenCaseError;
    expect(e.message).toBe("golden case chunk.split/test-v1/one threw (run): plain");
    expect(e.cause).toBe("plain");
  });

  test("the first throwing case in suite order wins", async () => {
    const dir = await captured(suite("a-v1", upper), suite("b-v1", upper), suite("c-v1", upper));
    const e = (await rejection(
      checkSuites(
        [
          suite("a-v1", upper),
          suite("b-v1", (s) => {
            if (s === "x") throw new Error("second case of b");
            return upper(s);
          }),
          suite("c-v1", () => {
            throw new Error("every case of c");
          }),
        ],
        { dir },
      ),
    )) as GoldenCaseError;
    expect([e.profile, e.caseId]).toEqual(["b-v1", "two"]);
  });

  test("a case missing from the file is not run", async () => {
    const dir = await captured(suite("test-v1", upper));
    const extra: GoldenSuite = {
      ...suite("test-v1", upper),
      cases: [
        ...suite("test-v1", upper).cases,
        {
          id: "three",
          input: 3,
          run: () => {
            throw new Error("never runs");
          },
        },
      ],
    };
    expect((await checkSuites([extra], { dir }))[0]?.problems).toEqual([
      { kind: "missing-case", id: "three" },
    ]);
  });
});

describe("check: unreadable golden files", () => {
  async function withFile(text: string): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "golden-check-"));
    const path = goldenPath(dir, suite("test-v1", upper));
    await mkdir(join(dir, "chunk.split"));
    await writeFile(path, text);
    return { dir, path };
  }

  test("a truncated file", async () => {
    const good = await captured(suite("test-v1", upper));
    const text = await readFile(goldenPath(good, suite("test-v1", upper)), "utf8");
    const { dir, path } = await withFile(text.slice(0, 80));
    const err = await rejection(checkSuites([suite("test-v1", upper)], { dir }));
    expect(err).toBeInstanceOf(GoldenFileError);
    const e = err as GoldenFileError;
    expect(e.name).toBe("GoldenFileError");
    expect(e.path).toBe(path);
    expect(e.cause).toBeInstanceOf(SyntaxError);
    expect(e.message.startsWith(`golden file ${path} is unreadable: `)).toBe(true);
  });

  test("cases that are not a list of objects", async () => {
    for (const text of ['{"format":1,"cases":5}', '{"format":1,"cases":[null]}']) {
      const { dir, path } = await withFile(text);
      const e = (await rejection(
        checkSuites([suite("test-v1", upper)], { dir }),
      )) as GoldenFileError;
      expect(e).toBeInstanceOf(GoldenFileError);
      expect(e.message).toBe(`golden file ${path} is unreadable: cases is not a list of objects`);
    }
  });

  test("a recorded output canonical JSON refuses", async () => {
    const { dir, path } = await withFile(
      `{"capability":"chunk.split","profile":"test-v1","format":1,"cases":[{"id":"one","inputSha256":"${HELLO_SHA}","output":1e999}]}`,
    );
    const e = (await rejection(checkSuites([suite("test-v1", upper)], { dir }))) as GoldenFileError;
    expect(e).toBeInstanceOf(GoldenFileError);
    expect(e.message).toBe(
      `golden file ${path} is unreadable: canonicalJson: non-finite number at $`,
    );
  });
});

describe("check: problems", () => {
  test("input drift and an output change are both reported, drift first", async () => {
    const dir = await captured(suite("test-v1", upper));
    const reports = await checkSuites([suite("test-v1", (s) => ({ text: s, n: 2 }), "hello!")], {
      dir,
    });
    expect(reports[0]?.problems).toEqual([
      { kind: "input-drift", id: "one", expected: HELLO_SHA, actual: HELLO_BANG_SHA },
      {
        kind: "output-mismatch",
        id: "one",
        expected: '{"n":5,"text":"HELLO"}',
        actual: '{"n":2,"text":"hello!"}',
        diffs: [
          { path: "$.n", change: "changed", expected: "5", actual: "2" },
          {
            path: "$.text",
            change: "changed",
            expected: '"HELLO"',
            actual: '"hello!"',
            at: 0,
            expectedLength: 5,
            actualLength: 6,
          },
        ],
        diffsOmitted: 0,
      },
      {
        kind: "output-mismatch",
        id: "two",
        expected: '{"n":1,"text":"X"}',
        actual: '{"n":2,"text":"x"}',
        diffs: [
          { path: "$.n", change: "changed", expected: "1", actual: "2" },
          {
            path: "$.text",
            change: "changed",
            expected: '"X"',
            actual: '"x"',
            at: 0,
            expectedLength: 1,
            actualLength: 1,
          },
        ],
        diffsOmitted: 0,
      },
    ]);
  });

  test("an output that differs only by -0 is clean", async () => {
    const dir = await captured(suite("test-v1", () => ({ z: 0 })));
    expect(
      (await checkSuites([suite("test-v1", () => ({ z: -0 }))], { dir }))[0]?.problems,
    ).toEqual([]);
  });
});

describe("capture", () => {
  test("a throw in suite 2 leaves suite 1's file untouched and writes nothing", async () => {
    const dir = await captured(suite("a-v1", upper));
    const path = goldenPath(dir, suite("a-v1", upper));
    const before = await readFile(path);
    const err = await rejection(
      captureSuites(
        [
          suite("a-v1", (s) => ({ text: s, changed: true })),
          suite("b-v1", () => {
            throw new Error("suite 2 fails");
          }),
        ],
        { dir, repo: "test", capturedFrom: "def" },
      ),
    );
    expect(err).toBeInstanceOf(GoldenCaseError);
    expect((err as Error).message).toBe(
      "golden case chunk.split/b-v1/one threw (run): suite 2 fails",
    );
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(join(dir, "chunk.split"))).toEqual(["a-v1.json"]);
  });

  test("writes every suite in order and leaves no temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-check-"));
    const written = await captureSuites(
      [suite("b-v1", upper), { ...suite("a-v1", upper), capability: "slugify" }],
      { dir, repo: "test", capturedFrom: "abc" },
    );
    expect(written).toEqual([
      join(dir, "chunk.split", "b-v1.json"),
      join(dir, "slugify", "a-v1.json"),
    ]);
    expect(await readdir(join(dir, "chunk.split"))).toEqual(["b-v1.json"]);
    expect(await readdir(join(dir, "slugify"))).toEqual(["a-v1.json"]);
  });

  test("a failed rename removes its temp file and rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-check-"));
    // A directory where the golden file should go: the rename onto it fails.
    await mkdir(join(dir, "chunk.split", "a-v1.json"), { recursive: true });
    await rejection(
      captureSuites([suite("a-v1", upper)], { dir, repo: "test", capturedFrom: "abc" }),
    );
    expect(await readdir(join(dir, "chunk.split"))).toEqual(["a-v1.json"]);
  });
});
