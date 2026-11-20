import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUITE_MARKERS } from "../src/db/test-client.pg-support.ts";
import {
  HYPOTHESIS_TRANSACTORS,
  IMAGES,
  markerProblem,
  markersOf,
  readSuites,
  type Suite,
  suitesFor,
  suitesUnder,
  TRANSACTORS,
  testsPassed,
} from "./test-db.ts";

const ROOT = `${import.meta.dir}/..`;

test("suites are the *.pg.ts files under src, ./-prefixed and sorted, never support modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "test-db-"));
  await mkdir(join(root, "src/b"), { recursive: true });
  await mkdir(join(root, "src/a"), { recursive: true });
  for (const f of ["src/b/x.pg.ts", "src/a/y.pg.ts", "src/a/y.pg-support.ts", "src/a/z.test.ts"]) {
    await writeFile(join(root, f), "");
  }
  try {
    expect(await suitesUnder(root)).toEqual(["./src/a/y.pg.ts", "./src/b/x.pg.ts"]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("no suites is an empty list, which the runner refuses", async () => {
  const root = await mkdtemp(join(tmpdir(), "test-db-"));
  try {
    expect(await suitesUnder(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("testsPassed reads bun test's pass count, never skips, and 0 when there is none", () => {
  expect(testsPassed(" 3 pass\n 0 fail\nRan 3 tests across 1 file. [12.00ms]\n")).toBe(3);
  expect(testsPassed(" 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 1 file.")).toBe(0);
  expect(testsPassed("error: The following filters did not match any test files")).toBe(0);
  expect(testsPassed("5 pass\n 0 pass\n 1 skip\nRan 1 test across 1 file.")).toBe(0);
});

test("the matrix is two digest-pinned images by three transactor kinds", () => {
  expect(IMAGES.map((i) => i.split("@")[0])).toEqual([
    "pgvector/pgvector:pg17",
    "pgvector/pgvector:pg18",
  ]);
  for (const image of IMAGES) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  expect([...TRANSACTORS]).toEqual(["bun-sql", "postgres-js", "drizzle"]);
});

test("markers are read from the leading comment lines only", () => {
  const both = `${SUITE_MARKERS.driverOnly}\n${SUITE_MARKERS.hypotheses}\nimport x;\n`;
  expect(markersOf(both)).toEqual({ driverOnly: true, hypotheses: true });
  expect(markersOf(`import x;\n${SUITE_MARKERS.driverOnly}\n`)).toEqual({
    driverOnly: false,
    hypotheses: false,
  });
});

test("a hypotheses marker must match hypothesis() calls, both ways", () => {
  const marked = `${SUITE_MARKERS.hypotheses}\n`;
  expect(markerProblem("a", `${marked}hypothesis("H1", f);`)).toBeNull();
  expect(markerProblem("a", `${marked}hypothesisIf(late)("H2", f);`)).toBeNull();
  expect(markerProblem("a", `hypothesis("H1", f);`)).toContain("lacks");
  expect(markerProblem("a", `${marked}test("T", f);`)).toContain("calls no hypothesis()");
  expect(markerProblem("a", `test("T", f);`)).toBeNull();
});

test("drizzle skips driver-only suites; --hypotheses runs only the marked ones", () => {
  const suites: Suite[] = [
    { path: "plain", driverOnly: false, hypotheses: false },
    { path: "driver", driverOnly: true, hypotheses: false },
    { path: "both", driverOnly: true, hypotheses: true },
    { path: "measured", driverOnly: false, hypotheses: true },
  ];
  expect(suitesFor("drizzle", suites, false)).toEqual(["plain", "measured"]);
  expect(suitesFor("bun-sql", suites, false)).toEqual(["plain", "driver", "both", "measured"]);
  expect(suitesFor("postgres-js", suites, true)).toEqual(["both", "measured"]);
});

test("the hypotheses run on one kind per lock driver, never drizzle", () => {
  expect([...HYPOTHESIS_TRANSACTORS]).toEqual(["bun-sql", "postgres-js"]);
});

test("this checkout's markers agree with its suites", async () => {
  const { suites, problems } = await readSuites(ROOT, await suitesUnder(ROOT));
  expect(problems).toEqual([]);
  expect(suites.filter((s) => s.hypotheses).length).toBeGreaterThan(0);
  expect(suites.filter((s) => s.driverOnly).length).toBeGreaterThan(0);
});

test("the hypotheses workflow runs on a change to every hypotheses suite", async () => {
  const workflow = await Bun.file(`${ROOT}/.github/workflows/hypotheses.yml`).text();
  const { suites } = await readSuites(ROOT, await suitesUnder(ROOT));
  const unwatched = suites
    .filter((s) => s.hypotheses)
    .map((s) => s.path.slice(2))
    .filter((path) => !workflow.includes(`- "${path}"`));
  expect(unwatched).toEqual([]);
});
