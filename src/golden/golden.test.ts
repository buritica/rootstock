import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { createRecordingFetch, redactUrl } from "./fetch.ts";
import {
  captureSuites,
  checkSuites,
  type GoldenSuite,
  goldenPath,
  orphanGoldenFiles,
  validateSuites,
} from "./suite.ts";
import { nearVector, seededVector } from "./vector.ts";

describe("canonicalJson", () => {
  test("sorts keys, including integer-like keys JS would put first", () => {
    expect(canonicalJson({ b: 1, a: 2, "10": 3, "2": 4 })).toBe('{"10":3,"2":4,"a":2,"b":1}');
  });

  test("is independent of insertion order at every depth", () => {
    const a = { x: { q: [1, { z: 1, y: 2 }], p: null }, w: "s" };
    const b = { w: "s", x: { p: null, q: [1, { y: 2, z: 1 }] } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  test("drops undefined object values but refuses undefined array items", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson([1, undefined])).toThrow("$[1]");
  });

  test("refuses values JSON would silently mangle", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow("$.n");
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ m: new Map() })).toThrow("Map");
    expect(() => canonicalJson(1n)).toThrow("bigint");
    expect(() => canonicalJson({ f: () => 1 })).toThrow("function");
  });

  test("serializes dates as ISO strings", () => {
    expect(canonicalJson({ d: new Date("2026-10-03T00:00:00Z") })).toBe(
      '{"d":"2026-10-03T00:00:00.000Z"}',
    );
  });

  test("indented output parses back to the same canonical form", () => {
    const value = { b: [1, 2, { c: "é" }], a: { "1": true } };
    const pretty = canonicalJson(value, 2);
    expect(pretty).toContain("\n  ");
    expect(canonicalJson(JSON.parse(pretty))).toBe(canonicalJson(value));
  });

  test("sha256Hex matches a known digest", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

function suite(output: (s: string) => unknown, input = "hello"): GoldenSuite {
  return {
    capability: "chunk.split",
    profile: "test-v1",
    cases: [
      { id: "one", input, run: () => output(input) },
      { id: "two", input: "x", run: () => output("x") },
    ],
  };
}

describe("capture and check", () => {
  test("a capture checks clean, then catches output and input drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-"));
    const upper = (s: string) => ({ text: s.toUpperCase(), n: s.length });
    await captureSuites([suite(upper)], { dir, repo: "test", capturedFrom: "abc" });

    const clean = await checkSuites([suite(upper)], { dir });
    expect(clean[0]?.problems).toEqual([]);

    const changed = await checkSuites([suite((s) => ({ text: s, n: s.length }))], { dir });
    expect(changed[0]?.problems.map((p) => p.kind)).toEqual(["output-mismatch", "output-mismatch"]);

    const drifted = await checkSuites([suite(upper, "hello!")], { dir });
    expect(drifted[0]?.problems.map((p) => p.kind)).toContain("input-drift");
  });

  test("reports missing files, missing cases and extra cases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-"));
    const id = (s: string) => s;
    const missing = await checkSuites([suite(id)], { dir });
    expect(missing[0]?.problems[0]?.kind).toBe("missing-file");

    await captureSuites([suite(id)], { dir, repo: "test", capturedFrom: "abc" });
    const fewer: GoldenSuite = { ...suite(id), cases: suite(id).cases.slice(0, 1) };
    const more: GoldenSuite = {
      ...suite(id),
      cases: [...suite(id).cases, { id: "three", input: 3, run: () => 3 }],
    };
    expect((await checkSuites([fewer], { dir }))[0]?.problems).toEqual([
      { kind: "extra-case", id: "two" },
    ]);
    expect((await checkSuites([more], { dir }))[0]?.problems).toEqual([
      { kind: "missing-case", id: "three" },
    ]);
  });

  test("golden files are stable, canonical, and record capturedFrom", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-"));
    const s = suite((x) => ({ z: 1, a: x }));
    await captureSuites([s], { dir, repo: "test", capturedFrom: "abc" });
    const first = await readFile(goldenPath(dir, s), "utf8");
    await captureSuites([s], { dir, repo: "test", capturedFrom: "abc" });
    expect(await readFile(goldenPath(dir, s), "utf8")).toBe(first);
    const parsed = JSON.parse(first);
    expect(parsed.capturedFrom).toBe("abc");
    expect(canonicalJson(parsed, 2)).toBe(first.trimEnd());
  });

  test("finds orphan golden files no suite produces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-"));
    const s = suite((x) => x);
    await captureSuites([s], { dir, repo: "test", capturedFrom: "abc" });
    await writeFile(join(dir, "chunk.split", "old-profile.json"), "{}");
    expect(await orphanGoldenFiles([s], dir)).toEqual(["chunk.split/old-profile.json"]);
  });

  test("validateSuites rejects bad ids, duplicates and unknown capabilities", () => {
    const ok = suite((x) => x);
    expect(() => validateSuites([ok, ok])).toThrow("duplicate suite");
    expect(() =>
      validateSuites([{ ...ok, capability: "nope" as GoldenSuite["capability"] }]),
    ).toThrow("unknown capability");
    expect(() =>
      validateSuites([{ ...ok, cases: [{ id: "Bad Id", input: 1, run: () => 1 }] }]),
    ).toThrow("bad case id");
    expect(() => validateSuites([{ ...ok, cases: [] }])).toThrow("no cases");
  });
});

describe("createRecordingFetch", () => {
  test("records requests with credentials redacted and a stable hash", async () => {
    const { fetch: recording, requests } = createRecordingFetch(
      () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
    const res = await recording("https://api.example.com/v1/m:gen?key=SECRET&alt=json", {
      method: "POST",
      headers: { "x-goog-api-key": "SECRET", "content-type": "application/json" },
      body: JSON.stringify({ b: 2, a: 1 }),
    });
    expect(await res.json()).toEqual({ ok: true });
    const [r] = requests;
    expect(r?.url).toBe("https://api.example.com/v1/m:gen?key=%3Credacted%3E&alt=json");
    expect(r?.headers["x-goog-api-key"]).toBe("<redacted>");
    expect(r?.body).toEqual({ a: 1, b: 2 });
    expect(JSON.stringify(requests)).not.toContain("SECRET");

    await recording("https://api.example.com/v1/m:gen?alt=json&key=OTHER", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1, b: 2 }),
    });
    expect(requests[1]?.requestSha256).not.toBe(r?.requestSha256); // param order differs
  });

  test("redactUrl leaves non-secret params alone", () => {
    expect(redactUrl("https://x.test/p?alt=json&token=t")).toBe(
      "https://x.test/p?alt=json&token=%3Credacted%3E",
    );
  });
});

describe("seededVector", () => {
  test("is deterministic, unit length, and seed-sensitive", () => {
    const a = seededVector("doc-1", 1536);
    expect(a).toHaveLength(1536);
    expect(seededVector("doc-1", 1536)).toEqual(a);
    expect(seededVector("doc-2", 1536)).not.toEqual(a);
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-12);
  });

  test("nearVector moves toward the base as weight grows", () => {
    const base = seededVector("query", 64);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    const far = cos(base, nearVector("d", base, 0.1));
    const close = cos(base, nearVector("d", base, 0.9));
    expect(close).toBeGreaterThan(far);
    expect(cos(base, nearVector("d", base, 1))).toBeCloseTo(1, 12);
  });
});
