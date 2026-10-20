import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGES, suitesUnder, TRANSACTORS, testsPassed } from "./test-db.ts";

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
