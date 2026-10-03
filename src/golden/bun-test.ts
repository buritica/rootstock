import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical.ts";
import { type GoldenSuite, goldenPath, readGoldenFile, runCase, validateSuites } from "./suite.ts";

/**
 * Registers one `bun test` per golden case, plus a case-set check per suite.
 * Kept in its own entry point because it imports `bun:test`.
 */
export function registerGoldenTests(suites: GoldenSuite[], opts: { dir: string }): void {
  validateSuites(suites);
  for (const suite of suites) {
    const path = goldenPath(opts.dir, suite);
    describe(`golden ${suite.capability}/${suite.profile}`, () => {
      test("golden file matches the suite's case set", async () => {
        const file = await readGoldenFile(path);
        expect(file, `missing ${path} — run capture`).toBeDefined();
        expect(file?.capability).toBe(suite.capability);
        expect(file?.profile).toBe(suite.profile);
        expect(file?.cases.map((c) => c.id).sort()).toEqual(suite.cases.map((c) => c.id).sort());
      });
      for (const c of suite.cases) {
        test(c.id, async () => {
          const file = await readGoldenFile(path);
          const expected = file?.cases.find((x) => x.id === c.id);
          expect(expected, `case ${c.id} not recorded in ${path}`).toBeDefined();
          const actual = await runCase(c);
          expect(actual.inputSha256, "fixture input changed since capture").toBe(
            expected?.inputSha256 ?? "",
          );
          expect(actual.canonical).toBe(canonicalJson(expected?.output));
        });
      }
    });
  }
}
