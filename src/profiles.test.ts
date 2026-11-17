import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path/posix";
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
  "src/runs/",
  "src/runner/",
] as const;
// The one cross-subpath import a pure subpath may make: the shared slice
// parser pieces, which are pure themselves and are no package export.
const SHARED_INTERNAL = "../internal/slice.ts";
// A pure subpath that builds on another pure one may import it by its index.
const PURE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/lock/": ["../db/index.ts"],
  "src/queue/": ["../db/index.ts"],
  "src/runs/": ["../db/index.ts", "../lock/index.ts"],
  "src/runner/": [
    "../db/index.ts",
    "../lock/index.ts",
    "../queue/index.ts",
    "../runs/index.ts",
    "../concurrency/index.ts",
  ],
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
const nameReads = (names: string): string[] => [
  `${NOT_MEMBER}\\b(${names})\\b(?!\\s*\\??:)`,
  `(?<!${KEY_POSITION})${NOT_MEMBER}\\b(${names})\\b(?=\\s*\\??:)`,
];
// `Date` is a clock when read as a value: `Date.now()`, `Date['now']`,
// `Date()`, `new Date()`, `new Date` and `const D = Date`. `new Date(ms)`,
// `Date.UTC(...)`, `instanceof Date` and the type are not.
const DATE_READS = [
  `${NOT_MEMBER}\\bDate\\s*\\??\\.\\s*now\\b`,
  `${NOT_MEMBER}\\bDate\\s*\\[(?!\\s*\\])`,
  `${NOT_MEMBER}(?<!\\bnew\\s+)\\bDate\\s*\\(`,
  "\\bnew\\s+Date\\s*(\\(\\s*\\)|(?!\\s*\\())",
  `${NOT_MEMBER}(?<!\\bnew\\s+|\\binstanceof\\s+|${TYPE_POSITION})\\bDate\\b${NO_MEMBER_OR_CALL}`,
  `(?<=${TYPE_POSITION})\\bDate\\b(?!${TYPE_END}|\\s*\\??\\.|\\s*\\[)`,
];
const ABORT_SIGNAL_READS = [
  `${NOT_MEMBER}\\bAbortSignal${MEMBER}`,
  `${NOT_MEMBER}(?<!${TYPE_POSITION})\\bAbortSignal\\b(?!\\s*(?:\\??\\.|\\[))`,
  `(?<=${TYPE_POSITION})\\bAbortSignal\\b(?!${TYPE_END}|${MEMBER})`,
];
const FORBIDDEN_GLOBALS = new RegExp(
  [...nameReads(GLOBAL_NAMES), ...ABORT_SIGNAL_READS, ...DATE_READS].join("|"),
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
// a quoted string's text is blanked, since `"Date"` names nothing, unless
// `keepStrings` asks for comments alone to go (to read import specifiers).
function stripComments(source: string, keepStrings = false): string {
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
      const blank = !keepStrings && (c === '"' || c === "'");
      out += blank ? `${c}${" ".repeat(Math.max(0, text.length - 2))}${c}` : text;
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
    "../runs/index.ts",
    "../usage/index.ts",
    // The slice file only: serve's index loads the MCP SDK, an optional peer.
    "../serve/slice.ts",
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

// The W5 subpaths (`serve`, `serve/auth`, `usage`). Relative specifiers are
// resolved to repo paths first, so a nested file cannot dodge a rule by its
// depth. The first rule whose prefix matches a file applies. `own` is the
// tree a file may import freely; `targets` are repo paths (a "/" suffix
// admits the folder); `packages` admit the package and its subpaths.
interface ImportRule {
  readonly prefix: string;
  readonly own: string | null;
  readonly notOwn?: string;
  readonly targets: readonly string[];
  /** Repo paths admitted through `import type` / `export type` only. */
  readonly typeTargets?: readonly string[];
  readonly packages: readonly string[];
}
const W5_RULES: readonly ImportRule[] = [
  // Pure: nothing outside itself.
  { prefix: "src/serve/types.ts", own: null, targets: [], packages: [] },
  {
    prefix: "src/serve/auth/",
    own: "src/serve/auth/",
    targets: ["src/serve/types.ts", "src/internal/"],
    packages: ["better-auth", "@better-auth/mcp", "@better-auth/cimd"],
  },
  // The serve config slice: `config` loads it, so a value import here may
  // never reach the MCP SDK (an optional peer); the runtime types are types only.
  {
    prefix: "src/serve/slice.ts",
    own: null,
    targets: ["src/internal/slice.ts", "src/serve/errors.ts"],
    typeTargets: ["src/serve/limits.ts", "src/serve/probes.ts", "src/serve/types.ts"],
    packages: [],
  },
  // Never Better Auth, never serve/auth: `serve` loads without the auth peers.
  {
    prefix: "src/serve/",
    own: "src/serve/",
    notOwn: "src/serve/auth/",
    targets: [
      "src/serve/types.ts",
      "src/db/index.ts",
      "src/migrate/index.ts",
      "src/internal/",
      "src/retry/token-bucket-math.ts",
    ],
    packages: ["@modelcontextprotocol/server", "node:async_hooks"],
  },
  {
    prefix: "src/usage/",
    own: "src/usage/",
    targets: ["src/serve/types.ts", "src/db/index.ts", "src/runs/index.ts", "src/internal/"],
    packages: [],
  },
];
// Time, timers, ids, I/O and output are injected (contract: no `console`,
// `Bun.*`, `Date`, `performance`, `setTimeout`, `crypto`): the same names the
// pure subpaths forbid. serve/auth alone may read `fetch`, which Better Auth's
// cimd plugin takes as a parameter.
const w5Globals = (names: string): RegExp =>
  new RegExp([...nameReads(names), ...ABORT_SIGNAL_READS, ...DATE_READS].join("|"));
const W5_GLOBALS = w5Globals(GLOBAL_NAMES);
const W5_AUTH_GLOBALS = w5Globals(
  GLOBAL_NAMES.split("|")
    .filter((n) => n !== "fetch")
    .join("|"),
);
// A dynamic `import(` whose argument is not one plain string literal names a
// module no scan can check, so it fails closed. Run on stripped code, where a
// string's quotes stay and its text is blank.
const NON_LITERAL_IMPORT = /(?<![.\w$])\bimport\s*\((?!\s*(["'])[^"'\n]*\1\s*\))/g;

const TYPE_ONLY_IMPORT = /\b(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["']/g;

function w5Offenders(path: string, source: string): string[] {
  const rule = W5_RULES.find((r) => allowed(path, [r.prefix]));
  if (rule === undefined || TEST_FILE.test(path)) return [];
  const offenders: string[] = [];
  const stripped = stripComments(source, true);
  // What a value import loads; `import type` and `export type` load nothing.
  const valueSpecs = new Set(specifiers(stripped.replace(TYPE_ONLY_IMPORT, "")));
  for (const spec of specifiers(stripped)) {
    if (spec.startsWith(".")) {
      const target = join(dirname(path), spec);
      const inOwn =
        rule.own !== null &&
        target.startsWith(rule.own) &&
        !(rule.notOwn !== undefined && target.startsWith(rule.notOwn));
      const typeOnly = allowed(target, rule.typeTargets ?? []) && !valueSpecs.has(spec);
      if (!inOwn && !typeOnly && !allowed(target, rule.targets)) {
        offenders.push(`${path} imports ${spec}`);
      }
    } else if (!rule.packages.some((p) => spec === p || spec.startsWith(`${p}/`))) {
      offenders.push(`${path} imports ${spec}`);
    }
  }
  const code = stripComments(source);
  const globals = rule.prefix === "src/serve/auth/" ? W5_AUTH_GLOBALS : W5_GLOBALS;
  code.split("\n").forEach((line, i) => {
    const m = line.match(globals);
    if (m) offenders.push(`${path}:${i + 1} uses ${m[0]}`);
  });
  for (const m of code.matchAll(NON_LITERAL_IMPORT)) {
    const line = code.slice(0, m.index).split("\n").length;
    offenders.push(`${path}:${line} imports a non-literal specifier`);
  }
  return offenders;
}

describe("serve, serve/auth and usage", () => {
  test("non-test files import only their allowlist and reach no ambient clock, timer or id", async () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const path of await sourceFiles()) {
      if (!W5_RULES.some((r) => allowed(path, [r.prefix])) || TEST_FILE.test(path)) continue;
      scanned++;
      offenders.push(...w5Offenders(path, await Bun.file(`${ROOT}/${path}`).text()));
    }
    expect(scanned).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  test("the scan admits each allowlisted import", () => {
    const admitted: [string, string][] = [
      ["src/serve/index.ts", "./types.ts"],
      ["src/serve/index.ts", "./pipeline.ts"],
      ["src/serve/index.ts", "@modelcontextprotocol/server"],
      ["src/serve/index.ts", "node:async_hooks"],
      ["src/serve/index.ts", "../db/index.ts"],
      ["src/serve/index.ts", "../migrate/index.ts"],
      ["src/serve/index.ts", "../internal/slice.ts"],
      ["src/serve/index.ts", "../retry/token-bucket-math.ts"],
      ["src/serve/limits/bucket.ts", "../../retry/token-bucket-math.ts"],
      ["src/serve/auth/index.ts", "../types.ts"],
      ["src/serve/auth/index.ts", "./pages.ts"],
      ["src/serve/auth/index.ts", "better-auth"],
      ["src/serve/auth/index.ts", "better-auth/plugins"],
      ["src/serve/auth/index.ts", "@better-auth/mcp"],
      ["src/serve/auth/index.ts", "@better-auth/cimd"],
      ["src/serve/auth/index.ts", "../../internal/slice.ts"],
      ["src/usage/index.ts", "./sinks.ts"],
      ["src/usage/index.ts", "../serve/types.ts"],
      ["src/usage/index.ts", "../db/index.ts"],
      ["src/usage/index.ts", "../runs/index.ts"],
      ["src/usage/index.ts", "../internal/slice.ts"],
      ["src/serve/slice.ts", "../internal/slice.ts"],
      ["src/serve/slice.ts", "./errors.ts"],
    ];
    const typeOnly: [string, string][] = [
      ["src/serve/slice.ts", 'import type { Limits } from "./limits.ts";'],
      ["src/serve/slice.ts", 'import type { ProbeTiming } from "./probes.ts";'],
      ["src/serve/slice.ts", 'import type { Caller } from "./types.ts";'],
    ];
    expect(typeOnly.filter(([path, src]) => w5Offenders(path, src).length)).toEqual([]);
    const wrong = admitted.filter(([path, spec]) => w5Offenders(path, `import "${spec}";`).length);
    expect(wrong).toEqual([]);
  });

  test("the scan fails on a planted violation", () => {
    const planted: [string, string][] = [
      // types.ts is pure: not even a sibling.
      ["src/serve/types.ts", 'import { x } from "./limits.ts";'],
      ["src/serve/types.ts", 'import type { SqlSubset } from "../db/index.ts";'],
      // serve never loads Better Auth, directly or through serve/auth.
      ["src/serve/index.ts", 'import { betterAuth } from "better-auth";'],
      ["src/serve/index.ts", 'import { mcp } from "@better-auth/mcp";'],
      ["src/serve/index.ts", 'export * from "./auth/index.ts";'],
      ["src/serve/limits/bucket.ts", 'import "../auth/index.ts";'],
      ["src/serve/index.ts", 'import { x } from "../retry/index.ts";'],
      ["src/serve/index.ts", 'import { sql } from "postgres";'],
      ["src/serve/index.ts", 'import { McpServer } from "@modelcontextprotocol/node";'],
      ["src/serve/index.ts", 'import { x } from "../usage/index.ts";'],
      // serve's config slice loads no runtime module, so never the MCP SDK.
      ["src/serve/slice.ts", 'import { createRateLimiter } from "./limits.ts";'],
      ["src/serve/slice.ts", 'import { type Limits } from "./limits.ts";'],
      ["src/serve/slice.ts", 'import { createMcpService } from "./service.ts";'],
      ["src/serve/slice.ts", 'import { McpServer } from "@modelcontextprotocol/server";'],
      // serve/auth sees the shared types only.
      ["src/serve/auth/index.ts", 'import { createMcpService } from "../index.ts";'],
      ["src/serve/auth/index.ts", 'import { McpServer } from "@modelcontextprotocol/server";'],
      ["src/serve/auth/index.ts", 'import { x } from "../../db/index.ts";'],
      ["src/serve/auth/index.ts", 'import { SignJWT } from "jose";'],
      // usage reaches serve through types.ts only.
      ["src/usage/index.ts", 'import { currentCall } from "../serve/index.ts";'],
      ["src/usage/index.ts", 'import { x } from "../lock/index.ts";'],
      ["src/usage/index.ts", 'const m = await import("node:fs");'],
      // Ambient clocks, timers, ids and output.
      ["src/serve/index.ts", "const t = Date.now();"],
      ["src/serve/index.ts", "const d = new Date();"],
      ["src/serve/index.ts", "const t = performance.now();"],
      ["src/serve/index.ts", "setTimeout(fn, 5);"],
      ["src/serve/auth/index.ts", "const id = crypto.randomUUID();"],
      ["src/usage/index.ts", "console.log(x);"],
      ["src/usage/index.ts", "await Bun.sleep(1);"],
      ["src/serve/types.ts", "const r = Math.random();"],
      // Every global the pure subpaths forbid, however it is reached.
      ["src/serve/index.ts", "globalThis.setTimeout(f, 5);"],
      ["src/serve/index.ts", 'const t = globalThis["Date"].now();'],
      ["src/serve/index.ts", "const g = globalThis;"],
      ["src/serve/index.ts", "const s = AbortSignal.timeout(5);"],
      ["src/serve/index.ts", "const s = AbortSignal.any([a, b]);"],
      ["src/serve/index.ts", "queueMicrotask(f);"],
      ["src/serve/index.ts", "const t = process.hrtime();"],
      ["src/usage/index.ts", "const { env } = process;"],
      ["src/serve/index.ts", "const r = await fetch(u);"],
      ["src/usage/index.ts", "const f = fetch;"],
      ["src/serve/auth/index.ts", "const s = AbortSignal.timeout(5);"],
      ["src/serve/auth/index.ts", "const g = globalThis.fetch;"],
      // Every way to load a module the specifier scan cannot read.
      ["src/serve/index.ts", 'const fs = require("node:fs");'],
      ["src/serve/index.ts", 'import fs = require("node:fs");'],
      ["src/serve/auth/index.ts", 'const m = require("./pages.ts");'],
      ["src/usage/index.ts", "const m = await import(`node:fs`);"],
      ["src/usage/index.ts", "const m = await import(name);"],
      ["src/usage/index.ts", 'const m = await import("./sinks" + ".ts");'],
      ["src/usage/index.ts", 'const m = await import(/* c */ "node:fs");'],
      ["src/usage/index.ts", 'const m = await import(\n  "node:fs"\n);'],
    ];
    const missed = planted.filter(([path, src]) => w5Offenders(path, src).length !== 1);
    expect(missed).toEqual([]);
  });

  test("injected names and test files are not violations", () => {
    const clean = [
      "const t = deps.clock.now();",
      "const cancel = o.timers.set(5, fn);",
      'log("serve.request", { ms });',
      "const at = new Date(ms).toISOString();",
      "type T = { at: Date; timers: Timers };",
      "const r = await deps.fetch(u);",
      'import x from "./sinks.ts"; // import "node:fs"',
      '/* import("node:fs") */ const s = "import(name)";',
    ];
    expect(clean.flatMap((src) => w5Offenders("src/serve/index.ts", src))).toEqual([]);
    expect(w5Offenders("src/serve/auth/index.ts", "const r = await fetch(u);")).toEqual([]);
    expect(w5Offenders("src/serve/index.test.ts", 'import "better-auth"; Date.now();')).toEqual([]);
  });
});
