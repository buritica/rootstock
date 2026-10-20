import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

const ROOT = `${import.meta.dir}/..`;
const OFFICE_PEERS = new Set(["jszip", "mammoth", "unpdf"]);
// Unit tests, DB suites (`*.pg.ts`) and their support modules (`*.pg-support.ts`)
// import drivers and read the environment by design; every scan skips them.
const TEST_FILE = /\.(test|pg|pg-support)\.ts$/;

test("the published files exclude every test-file suffix", () => {
  for (const suffix of ["test", "pg", "pg-support"]) {
    expect(TEST_FILE.test(`x.${suffix}.ts`)).toBe(true);
    expect(pkg.files).toContain(`!src/**/*.${suffix}.ts`);
  }
});

function walk(value: unknown, seen: Set<object>, visit: (v: object) => void): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (typeof value === "function") return;
  for (const key of Reflect.ownKeys(value)) {
    walk((value as Record<PropertyKey, unknown>)[key], seen, visit);
  }
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.ts").scan({ cwd: ROOT })) files.push(path);
  return files.sort();
}

describe("every subpath export", () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    test(`${subpath}: profiles are deep-frozen, well-named, and carry no stateful RegExp`, async () => {
      const mod: Record<string, unknown> = await import(`${ROOT}/${target}`);
      for (const [name, value] of Object.entries(mod)) {
        if (value === null || typeof value !== "object" || !("id" in value)) continue;
        expect(String((value as { id: unknown }).id)).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
        walk(value, new Set(), (v) => {
          if (typeof v !== "function") expect(Object.isFrozen(v), `${subpath}.${name}`).toBe(true);
          if (v instanceof RegExp) {
            expect(v.flags, `${subpath}.${name} ${v}`).not.toMatch(/[gy]/);
          }
        });
      }
    });
  }
});

test("only office-extract loads the office parsers", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (path.startsWith("src/office-extract/")) continue;
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      if (OFFICE_PEERS.has(spec.split("/")[0] ?? "") || spec.includes("office-extract")) {
        offenders.push(`${path} imports ${spec}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("webhook-verify depends on node:crypto only", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (!path.startsWith("src/webhook-verify/")) continue;
    const isTest = TEST_FILE.test(path);
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      const ok = spec === "node:crypto" || spec.startsWith("./") || (isTest && spec === "bun:test");
      if (!ok) offenders.push(`${path} imports ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

const PURE_SUBPATHS = ["src/retry/", "src/slack/", "src/db/", "src/concurrency/"] as const;
const FORBIDDEN_GLOBALS =
  /\b(fetch|Date|setTimeout|setInterval|setImmediate|queueMicrotask|performance|Math\.random|AbortSignal|crypto|process|console|Bun|globalThis|require)\b/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("pure subpaths (every clock, timer and I/O is injected)", () => {
  test("non-test files import only their own subpath", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles()) {
      if (!PURE_SUBPATHS.some((p) => path.startsWith(p)) || TEST_FILE.test(path)) continue;
      for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
        if (!spec.startsWith("./")) offenders.push(`${path} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("non-test files reach no ambient global once comments are stripped", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles()) {
      if (!PURE_SUBPATHS.some((p) => path.startsWith(p)) || TEST_FILE.test(path)) continue;
      const code = stripComments(await Bun.file(`${ROOT}/${path}`).text());
      code.split("\n").forEach((line, i) => {
        const m = line.match(FORBIDDEN_GLOBALS);
        if (m) offenders.push(`${path}:${i + 1} uses ${m[0]}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("they export no profiles", async () => {
    for (const sub of PURE_SUBPATHS) {
      const mod: Record<string, unknown> = await import(`${ROOT}/${sub}index.ts`);
      for (const [name, value] of Object.entries(mod)) {
        const isProfile = value !== null && typeof value === "object" && "id" in value;
        expect(isProfile, `${sub}.${name}`).toBe(false);
      }
    }
  });
});

// Non-test files of these subpaths may import only what is listed. A prefix
// entry ending in "/" admits any specifier starting with it.
const IMPORT_ALLOWLIST: Record<string, readonly string[]> = {
  "src/migrate/": ["./", "../db/index.ts", "../hash/index.ts", "node:fs"],
  "src/config/": [
    "./",
    "../db/index.ts",
    "../migrate/index.ts",
    "../concurrency/index.ts",
    "../golden/canonical.ts",
  ],
};

function allowed(spec: string, list: readonly string[]): boolean {
  return list.some((entry) => (entry.endsWith("/") ? spec.startsWith(entry) : spec === entry));
}

test("migrate and config import only their allowlist", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (TEST_FILE.test(path)) continue;
    const prefix = Object.keys(IMPORT_ALLOWLIST).find((p) => path.startsWith(p));
    if (prefix === undefined) continue;
    const list = IMPORT_ALLOWLIST[prefix] ?? [];
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      if (!allowed(spec, list)) offenders.push(`${path} imports ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

// The published `./golden/bun-test` adapter exists to wrap bun:test, so it is
// the one non-test file that may import it.
const BUN_TEST_ADAPTER = "src/golden/bun-test.ts";

test("no non-test file imports a database driver, and bun:test stays in tests", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (TEST_FILE.test(path)) continue;
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      const driver = spec === "postgres" || spec === "bun" || spec.startsWith("drizzle-orm");
      const bunTest = spec === "bun:test" && path !== BUN_TEST_ADAPTER;
      if (driver || bunTest) offenders.push(`${path} imports ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});
