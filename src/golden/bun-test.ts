import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical.ts";
import {
  type GoldenSuite,
  goldenPath,
  readGoldenFile,
  runSuiteCase,
  validateSuites,
} from "./suite.ts";

/**
 * Registers one `bun test` per golden case, plus a case-set check per suite.
 * Kept in its own entry point because it imports `bun:test`.
 *
 * A case compares its indented canonical output first, so Bun prints a line
 * diff, then its input hash. A case that throws fails with the
 * `GoldenCaseError` message naming the suite, the case and the phase.
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
          const actual = await runSuiteCase(suite, c);
          const recordedInput = expected?.inputSha256 ?? "";
          const inputChanged = actual.inputSha256 !== recordedInput;
          expect(
            canonicalJson(actual.output, 2),
            inputChanged ? "output differs (fixture input also changed)" : "output differs",
          ).toBe(canonicalJson(expected?.output, 2));
          expect(actual.inputSha256, "fixture input changed since capture (output unchanged)").toBe(
            recordedInput,
          );
        });
      }
    });
  }
}
