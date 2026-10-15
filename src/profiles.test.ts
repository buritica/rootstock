import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

const ROOT = `${import.meta.dir}/..`;
const OFFICE_PEERS = new Set(["jszip", "mammoth", "unpdf"]);

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
    const isTest = path.endsWith(".test.ts");
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      const ok = spec === "node:crypto" || spec.startsWith("./") || (isTest && spec === "bun:test");
      if (!ok) offenders.push(`${path} imports ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

const PURE_SUBPATHS = ["src/retry/", "src/slack/"] as const;
const FORBIDDEN_GLOBALS =
  /\b(fetch|Date|setTimeout|setInterval|setImmediate|queueMicrotask|performance|Math\.random|AbortSignal|crypto|process|console|Bun|globalThis|require)\b/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("transport subpaths are pure (every clock, timer and I/O is injected)", () => {
  test("non-test files import only their own subpath", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles()) {
      if (!PURE_SUBPATHS.some((p) => path.startsWith(p)) || path.endsWith(".test.ts")) continue;
      for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
        if (!spec.startsWith("./")) offenders.push(`${path} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("non-test files reach no ambient global once comments are stripped", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles()) {
      if (!PURE_SUBPATHS.some((p) => path.startsWith(p)) || path.endsWith(".test.ts")) continue;
      const code = stripComments(await Bun.file(`${ROOT}/${path}`).text());
      code.split("\n").forEach((line, i) => {
        const m = line.match(FORBIDDEN_GLOBALS);
        if (m) offenders.push(`${path}:${i + 1} uses ${m[0]}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("they export no profiles", async () => {
    for (const sub of ["retry", "slack"]) {
      const mod: Record<string, unknown> = await import(`${ROOT}/src/${sub}/index.ts`);
      for (const [name, value] of Object.entries(mod)) {
        const isProfile = value !== null && typeof value === "object" && "id" in value;
        expect(isProfile, `${sub}.${name}`).toBe(false);
      }
    }
  });
});
