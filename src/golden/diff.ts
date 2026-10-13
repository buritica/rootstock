import { canonicalJson } from "./canonical.ts";

/**
 * One difference between a recorded golden output and a fresh one, located by
 * a JSONPath-like `path`. `expected`/`actual` are canonical JSON, cut short;
 * for two strings they are instead JSON-escaped excerpts around `at`, the
 * first differing UTF-16 code unit.
 */
export interface PathDiff {
  /**
   * "$", "$.a", "$[\"a b\"]", "$[\"10\"]", "$.list[3]": dot form only for /^[A-Za-z_$][\w$]*$/ keys.
   * A bracket key containing U+2028/U+2029 has them escaped as \\u2028/\\u2029.
   */
  path: string;
  change: "changed" | "added" | "removed" | "type";
  /**
   * Canonical JSON, cut to <= 160 UTF-16 code units + "…(+N)"; never splits a surrogate pair. U+2028/U+2029 are
   * escaped after the cut, so each one adds five code units.
   */
  expected?: string;
  actual?: string;
  /** Strings only: first differing UTF-16 code-unit index; expected/actual are then JSON-escaped ±32-unit excerpts
   *  (U+2028/U+2029 escaped). */
  at?: number;
  expectedLength?: number;
  actualLength?: number;
}

const DIFF_LIMIT = 20;
const VALUE_UNITS = 160;
const EXCERPT_RADIUS = 32;
const DOT_KEY = /^[A-Za-z_$][\w$]*$/;

/** JSON.stringify leaves U+2028/U+2029 raw; escape them so a diff never carries a line separator. */
function escapeSeparators(text: string): string {
  return text.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Differences between two canonical JSON texts, depth-first with object keys
 * in code-unit order and arrays index by index. The first `DIFF_LIMIT` are
 * returned; the rest are only counted. Comparing the parsed canonical texts
 * (not the live values) means anything canonical JSON already equates, such
 * as `-0` and `0` or a Date and its ISO string, never shows up.
 */
export function diffCanonicalTexts(
  expectedText: string,
  actualText: string,
): { diffs: PathDiff[]; diffsOmitted: number } {
  const diffs: PathDiff[] = [];
  let diffsOmitted = 0;
  const emit = (diff: PathDiff) => {
    if (diffs.length < DIFF_LIMIT) diffs.push(diff);
    else diffsOmitted++;
  };
  walk(JSON.parse(expectedText) as Json, JSON.parse(actualText) as Json, "$", emit);
  return { diffs, diffsOmitted };
}

function kindOf(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walk(expected: Json, actual: Json, path: string, emit: (diff: PathDiff) => void): void {
  const kind = kindOf(expected);
  if (kind !== kindOf(actual)) {
    emit({ path, change: "type", expected: render(expected), actual: render(actual) });
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) {
      const itemPath = `${path}[${i}]`;
      if (i >= actual.length) {
        emit({ path: itemPath, change: "removed", expected: render(expected[i] as Json) });
      } else if (i >= expected.length) {
        emit({ path: itemPath, change: "added", actual: render(actual[i] as Json) });
      } else {
        walk(expected[i] as Json, actual[i] as Json, itemPath, emit);
      }
    }
    return;
  }
  if (kind === "object") {
    const e = expected as { [key: string]: Json };
    const a = actual as { [key: string]: Json };
    const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
    for (const key of keys) {
      const keyPath = DOT_KEY.test(key)
        ? `${path}.${key}`
        : `${path}[${escapeSeparators(JSON.stringify(key))}]`;
      if (!Object.hasOwn(a, key)) {
        emit({ path: keyPath, change: "removed", expected: render(e[key] as Json) });
      } else if (!Object.hasOwn(e, key)) {
        emit({ path: keyPath, change: "added", actual: render(a[key] as Json) });
      } else {
        walk(e[key] as Json, a[key] as Json, keyPath, emit);
      }
    }
    return;
  }
  if (expected === actual) return;
  if (typeof expected === "string" && typeof actual === "string") {
    const at = firstDifference(expected, actual);
    emit({
      path,
      change: "changed",
      expected: excerpt(expected, at),
      actual: excerpt(actual, at),
      at,
      expectedLength: expected.length,
      actualLength: actual.length,
    });
    return;
  }
  emit({ path, change: "changed", expected: render(expected), actual: render(actual) });
}

function firstDifference(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return shorter;
}

function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** True when cutting `s` before index `i` would separate a surrogate pair. */
function splitsPair(s: string, i: number): boolean {
  return i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i));
}

function render(value: Json): string {
  const text = canonicalJson(value);
  if (text.length <= VALUE_UNITS) return escapeSeparators(text);
  const cut = splitsPair(text, VALUE_UNITS) ? VALUE_UNITS - 1 : VALUE_UNITS;
  return `${escapeSeparators(text.slice(0, cut))}…(+${text.length - cut})`;
}

function excerpt(s: string, at: number): string {
  let start = Math.max(0, at - EXCERPT_RADIUS);
  let end = Math.min(s.length, at + EXCERPT_RADIUS);
  if (splitsPair(s, start)) start++;
  if (splitsPair(s, end)) end--;
  return escapeSeparators(JSON.stringify(s.slice(start, end)));
}
