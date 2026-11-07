import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

const ROOT = `${import.meta.dir}/..`;
const OFFICE_PEERS = new Set(["jszip", "mammoth", "unpdf"]);
// Unit tests, DB suites (`*.pg.ts`) and their support modules (`*.pg-support.ts`,
// `*.test-support.ts`) import drivers and read the environment by design; every
// scan skips them.
const SUFFIXES = ["test", "pg", "pg-support", "test-support"] as const;
const TEST_FILE = new RegExp(`\\.(${SUFFIXES.join("|")})\\.ts$`);
// A specifier naming a test file; bundler resolution lets it drop its `.ts`.
const TEST_SPECIFIER = new RegExp(`\\.(${SUFFIXES.join("|")})(\\.ts)?$`);

test("the published files exclude every test-file suffix", () => {
  for (const suffix of SUFFIXES) {
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

const PURE_SUBPATHS = [
  "src/retry/",
  "src/slack/",
  "src/db/",
  "src/concurrency/",
  "src/internal/",
  "src/lock/",
  "src/queue/",
] as const;
// The one cross-subpath import a pure subpath may make: the shared slice
// parser pieces, which are pure themselves and are no package export.
const SHARED_INTERNAL = "../internal/slice.ts";
// A pure subpath that builds on another pure one may import it by its index.
const PURE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/lock/": ["../db/index.ts"],
  "src/queue/": ["../db/index.ts"],
};
// A name read as a value. A property access (`deps.setInterval(...)`) and a
// key (`setInterval: …`, `setInterval?: …`) are not the global, and an
// injected dependency is declared and called exactly that way. A name before
// `:` is a key only in key position: at the start of a line or right after
// `{`, `,`, `;` or `(`. Anywhere else (`slow ? setTimeout : noop`,
// `slow ? 0 || setTimeout : noop`) it is a ternary branch, so a read.
const GLOBAL_NAMES =
  "fetch|setTimeout|setInterval|setImmediate|queueMicrotask|performance|Math\\.random|crypto|process|console|Bun|globalThis|require";
const NOT_MEMBER = "(?<![.\\w$])";
const KEY_POSITION = "(?:^|[{,;(])\\s*";
// AbortSignal and Date are also types, and a type is no read. A type position
// is after `:`, `<`, `as`, `satisfies`, or a single `|` or `&` (never
// `||`/`&&`), and the type
// ends at a terminator. Member access (`AbortSignal.timeout`, `Date['now']`)
// is a read whatever precedes it; `X[]` is the array type. A regex cannot
// tell an annotation from a ternary's `: AbortSignal;` branch, which is why
// shipped code spells the name in pieces where it needs the text.
const TYPE_POSITION = "(?:[:<]|(?<![|&])[|&]|\\b(?:as|satisfies)\\s)\\s*";
const TYPE_END = "(?=\\s*(?:[;,)|&>=\\]}]|\\[\\s*\\]|$))";
const MEMBER = "\\s*(?:\\??\\.|\\[(?!\\s*\\]))";
const NO_MEMBER_OR_CALL = "(?!\\s*(?:\\??\\.|\\[|\\())";
// `Date` is a clock when read as a value: `Date.now()`, `Date['now']`,
// `Date()`, `new Date()`, `new Date` and `const D = Date`. `new Date(ms)`,
// `Date.UTC(...)`, `instanceof Date` and the type are not.
const FORBIDDEN_GLOBALS = new RegExp(
  [
    `${NOT_MEMBER}\\b(${GLOBAL_NAMES})\\b(?!\\s*\\??:)`,
    `(?<!${KEY_POSITION})${NOT_MEMBER}\\b(${GLOBAL_NAMES})\\b(?=\\s*\\??:)`,
    `${NOT_MEMBER}\\bAbortSignal${MEMBER}`,
    `${NOT_MEMBER}(?<!${TYPE_POSITION})\\bAbortSignal\\b(?!\\s*(?:\\??\\.|\\[))`,
    `(?<=${TYPE_POSITION})\\bAbortSignal\\b(?!${TYPE_END}|${MEMBER})`,
    `${NOT_MEMBER}\\bDate\\s*\\??\\.\\s*now\\b`,
    `${NOT_MEMBER}\\bDate\\s*\\[(?!\\s*\\])`,
    `${NOT_MEMBER}(?<!\\bnew\\s+)\\bDate\\s*\\(`,
    "\\bnew\\s+Date\\s*(\\(\\s*\\)|(?!\\s*\\())",
    `${NOT_MEMBER}(?<!\\bnew\\s+|\\binstanceof\\s+|${TYPE_POSITION})\\bDate\\b${NO_MEMBER_OR_CALL}`,
    `(?<=${TYPE_POSITION})\\bDate\\b(?!${TYPE_END}|\\s*\\??\\.|\\s*\\[)`,
  ].join("|"),
);

test("the purity scan tells a read from a key", () => {
  const reads = [
    "const t = slow ? setTimeout : noop;",
    "const t = slow?setTimeout:noop;",
    "const t = slow ? noop : setTimeout;",
    "const t = slow ? 0 || setTimeout : noop;",
    "    ? setTimeout : noop",
    "setInterval(fn, 1);",
    "const r = Math.random();",
    "x instanceof AbortSignal",
    "fn({ signal: AbortSignal.timeout(1000) });",
    "const s = a || AbortSignal.timeout(5);",
    "const s = a | AbortSignal.any([]);",
    "const s = AbortSignal['timeout'](5);",
    "const S = AbortSignal;",
    "const S = a || AbortSignal;",
    "const now = Date.now();",
    "const now = Date['now']();",
    "const now = Date?.now();",
    "const D = Date;",
    "const D = a || Date;",
    "const s = Date();",
    "const d = new Date();",
    "const d = new Date;",
  ];
  const keys = [
    "setInterval: (fn: () => void, ms: number) => unknown;",
    "  setTimeout?: typeof noop,",
    "{ setTimeout: st, fetch: f }",
    "deps.setInterval(tick, 5);",
    "a?.setTimeout(fn)",
    "sleep: (ms: number, signal?: AbortSignal) => Promise<void>;",
    "signal: AbortSignal | undefined,",
    "{ signal: AbortSignal }",
    "const all: AbortSignal[] = [];",
    "type T = Promise<AbortSignal>;",
    "type U = X & AbortSignal;",
    "const d = new Date(ms);",
    "if (node instanceof Date) return node.toISOString();",
    "at: Date;",
    "notBefore: date(ms) as Date,",
    "const t = Date.UTC(2026, 0, 1);",
    "const u = 'http://example.test/';",
  ];
  expect(reads.filter((line) => !FORBIDDEN_GLOBALS.test(line))).toEqual([]);
  expect(keys.filter((line) => FORBIDDEN_GLOBALS.test(line))).toEqual([]);
});

test("the scan reads code: comments and quoted text go, templates, regexes and lines stay", () => {
  const src = [
    'const u = "http://x"; fetch(u);',
    "const v = 'a//b'; // gone",
    "const w = `c//d`; /* gone",
    "still gone */ const re = /\\/\\//; setTimeout(f); // gone",
  ].join("\n");
  expect(stripComments(src).split("\n")).toEqual([
    'const u = "        "; fetch(u);',
    "const v = '    '; ",
    "const w = `c//d`; ",
    " const re = /\\/\\//; setTimeout(f); ",
  ]);
});

// A `/` starts a regex literal after one of these (or at the start), and is
// division after anything else (an identifier, a number, `)` or `]`).
const REGEX_PRECEDER = /^$|[(,=:[!&|?{};+\-*%<>~^]$/;

// The index just past the string, template or regex literal opened at `start`.
function literalEnd(source: string, start: number): number {
  const open = source[start];
  let inClass = false;
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n" && open !== "`") return i;
    if (open === "/" && c === "[") inClass = true;
    else if (open === "/" && c === "]") inClass = false;
    else if (c === open && !inClass) return i + 1;
    i++;
  }
  return i;
}

// The code a scan reads: `//` and `/* */` comments outside literals are
// dropped (a block comment keeps its newlines, so line numbers stay true) and
// a quoted string's text is blanked, since `"Date"` names nothing.
function stripComments(source: string): string {
  let out = "";
  let prev = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? source.length : close + 2;
      out += source.slice(i, end).replace(/[^\n]/g, "");
      i = end;
    } else if (c === '"' || c === "'" || c === "`" || (c === "/" && REGEX_PRECEDER.test(prev))) {
      const end = literalEnd(source, i);
      const text = source.slice(i, end);
      // A quoted string's text is no code; a template's `${…}` is, so it stays.
      out += c === '"' || c === "'" ? `${c}${" ".repeat(Math.max(0, text.length - 2))}${c}` : text;
      prev = c;
      i = end;
    } else {
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

describe("pure subpaths (every clock, timer and I/O is injected)", () => {
  test("non-test files import only their own subpath", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles()) {
      if (!PURE_SUBPATHS.some((p) => path.startsWith(p)) || TEST_FILE.test(path)) continue;
      const extra = Object.entries(PURE_IMPORTS).find(([p]) => path.startsWith(p))?.[1] ?? [];
      for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
        if (!spec.startsWith("./") && spec !== SHARED_INTERNAL && !extra.includes(spec)) {
          offenders.push(`${path} imports ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("src/internal is no package export", async () => {
    const pkg = await Bun.file(`${ROOT}/package.json`).json();
    const targets = Object.values(pkg.exports as Record<string, string>);
    expect(targets.filter((t) => t.includes("/internal/"))).toEqual([]);
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
      if (sub === "src/internal/") continue; // no index: nothing is exported from it
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
  "src/migrate/": [
    "./",
    "../db/index.ts",
    "../hash/index.ts",
    "../internal/slice.ts",
    "node:fs",
    "node:path",
    "node:url",
  ],
  "src/config/": [
    "./",
    "../db/index.ts",
    "../migrate/index.ts",
    "../concurrency/index.ts",
    "../lock/index.ts",
    "../queue/index.ts",
    "../internal/slice.ts",
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

const DRIVER = /^(postgres|pg|bun|drizzle-orm)(\/|$)|^bun:(?!test$)/;

test("no non-test file imports a database driver, and bun:test stays in tests", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (TEST_FILE.test(path)) continue;
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      const bunTest = spec === "bun:test" && path !== BUN_TEST_ADAPTER;
      if (DRIVER.test(spec) || bunTest) offenders.push(`${path} imports ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

// Test files are left out of the published package, so a shipped file that
// imports one would fail to load for every consumer.
test("no non-test file imports a test file", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (TEST_FILE.test(path)) continue;
    for (const spec of specifiers(await Bun.file(`${ROOT}/${path}`).text())) {
      if (TEST_SPECIFIER.test(spec)) offenders.push(`${path} imports ${spec}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("no non-test file reads the environment", async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if (TEST_FILE.test(path)) continue;
    const code = stripComments(await Bun.file(`${ROOT}/${path}`).text());
    code.split("\n").forEach((line, i) => {
      if (/\b(process|Bun)\.env\b|\bprocess\[|import\.meta\.env/.test(line)) {
        offenders.push(`${path}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
