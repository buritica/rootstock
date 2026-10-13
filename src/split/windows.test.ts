import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  locateWindows,
  splitBodyWithinBudget,
  type WindowBodyPlan,
  type WindowParams,
  windowBody,
} from "./index.ts";

/** The message `fn` throws, so a refusal is matched exactly rather than as a substring. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a throw");
}

// A production parameter set (numeric values as a consumer runs them), as test literals.
const P: WindowParams = Object.freeze({
  charsPerToken: 2.8,
  labelReserveChars: 0,
  tokenMargin: 8,
  joinChars: 4,
  minSectionChars: 400,
  rebalanceStep: 1.05,
  refusalLabel: "windower",
});

// A unit parameter set: the body budget is exactly maxInputTokens - title.length - headChars.
const U: WindowParams = Object.freeze({
  charsPerToken: 1,
  labelReserveChars: 0,
  tokenMargin: 0,
  joinChars: 0,
  minSectionChars: 1,
  rebalanceStep: 1.5,
  refusalLabel: "win",
});

const plan = (
  body: string,
  maxInputTokens: number,
  params: WindowParams,
  title = "",
  headChars = 0,
) => windowBody({ title, headChars, body, maxInputTokens }, params);

const bodies = (p: WindowBodyPlan): string[] =>
  p.kind === "windows" ? p.windows.map((w) => w.body) : [];

/** [length, first line (12 units), charStart, charEnd] per window. */
const shape = (p: WindowBodyPlan) =>
  p.kind === "windows"
    ? p.windows.map((w) => [
        w.body.length,
        w.body.split("\n")[0]?.slice(0, 12),
        w.charStart,
        w.charEnd,
      ])
    : p;

/** A heading block, a blank line, then filler, `total` units long. */
const section = (heading: string, total: number) =>
  `${heading}\n\n${"w".repeat(total - heading.length - 2)}`;

describe("windowBody plans", () => {
  test("whole, at budget 1 and an empty body", () => {
    expect(plan("", 10, U, "", 9)).toEqual({ kind: "whole", charStart: 0, charEnd: 0 });
    expect(plan("a", 10, U, "", 9)).toEqual({ kind: "whole", charStart: 0, charEnd: 1 });
  });

  test("windows at budget 1", () => {
    expect(plan("ab", 10, U, "", 9)).toEqual({
      kind: "windows",
      windows: [
        { body: "a", charStart: 0, charEnd: 1 },
        { body: "b", charStart: 1, charEnd: 2 },
      ],
    });
  });

  test("no-room at budget 0 and below", () => {
    expect(plan("a", 10, U, "", 10)).toEqual({ kind: "no-room" });
    expect(plan("", 10, U, "abc", 9)).toEqual({ kind: "no-room" });
  });

  const budgetEdges: Array<[string, string, number, number, string, WindowBodyPlan["kind"]]> = [
    // name, title, headChars, maxInputTokens, body, kind — with P: floor((M - 8) * 2.8 - (title + 4)) - headChars
    ["budget 1 (M 10: floor(1.6))", "", 0, 10, "a", "whole"],
    ["budget 0 (one head char)", "", 1, 10, "a", "no-room"],
    ["budget 0 (one title char)", "t", 0, 10, "", "no-room"],
    ["the window less the margin is no room", "", 0, 8, "", "no-room"],
  ];
  for (const [name, title, headChars, maxInputTokens, body, kind] of budgetEdges) {
    test(name, () => {
      expect(plan(body, maxInputTokens, P, title, headChars).kind).toBe(kind);
    });
  }

  test("NaN maxInputTokens takes the windows path and the splitter refuses, naming the title", () => {
    expect(messageOf(() => plan("x", Number.NaN, P, 'My "T"'))).toBe(
      'windower: char budget for title "My \\"T\\"" is NaN — the title alone exceeds the embedding window',
    );
  });

  test("NaN maxInputTokens with an empty body is one unlocated empty window", () => {
    expect(plan("", Number.NaN, P, "t")).toEqual({
      kind: "windows",
      windows: [{ body: "", charStart: null, charEnd: null }],
    });
  });
});

describe("windowBody sections", () => {
  test("only a block starting with 1-6 '#', a space and a non-space opens a section", () => {
    const body = ["# a", "t", "#x", "####### g", "## b", "#  y", "###### c", "# z"].join("\n\n");
    expect(bodies(plan(body, 21, U))).toEqual([
      "# a\n\nt\n\n#x\n\n####### g",
      "## b\n\n#  y",
      "###### c",
      "# z",
    ]);
  });

  test("a heading after a single newline does not open a section", () => {
    expect(bodies(plan("intro\n# inline\n\n# real", 14, U))).toEqual(["intro\n# inline", "# real"]);
  });

  // With P at maxInputTokens 368 the body budget is 1003.
  test("budget at maxInputTokens 368", () => {
    expect(plan("w".repeat(1003), 368, P)).toEqual({ kind: "whole", charStart: 0, charEnd: 1003 });
    expect(plan("w".repeat(1004), 368, P).kind).toBe("windows");
  });

  const A = section("# A", 500);
  const C = section("### C", 500);
  const cases: Array<[string, string, unknown]> = [
    [
      "a section of exactly minSectionChars stands alone",
      [A, section("## B", 400), C].join("\n\n"),
      [
        [500, "# A", 0, 500],
        [400, "## B", 502, 902],
        [500, "### C", 904, 1404],
      ],
    ],
    [
      "one char short merges into the previous section",
      [A, section("## B", 399), C].join("\n\n"),
      [
        [901, "# A", 0, 901],
        [500, "### C", 903, 1403],
      ],
    ],
    [
      "a small section that cannot pair with the previous is carried into the next",
      [section("# A", 960), section("## T", 50), C].join("\n\n"),
      [
        [960, "# A", 0, 960],
        [552, "## T", 962, 1514],
      ],
    ],
    [
      "a small first section is carried; the carried pair then splits",
      [section("## T", 50), section("# A", 960), C].join("\n\n"),
      [
        [55, "## T", 0, 55],
        [955, "wwwwwwwwwwww", 57, 1012],
        [500, "### C", 1014, 1514],
      ],
    ],
    [
      "a tiny last section that fits merges into the previous",
      [A, C, section("## T", 30)].join("\n\n"),
      [
        [500, "# A", 0, 500],
        [532, "### C", 502, 1034],
      ],
    ],
    [
      "a tiny last section that does not fit is still appended, then split",
      [section("# A", 990), section("## T", 30)].join("\n\n"),
      [
        [996, "# A", 0, 996],
        [24, "wwwwwwwwwwww", 998, 1022],
      ],
    ],
  ];
  for (const [name, body, expected] of cases) {
    test(name, () => {
      expect(shape(plan(body, 368, P))).toEqual(expected as never);
    });
  }

  test("plan digests", () => {
    const digest = (p: WindowBodyPlan) =>
      createHash("sha256").update(JSON.stringify(p)).digest("hex");
    expect(digest(plan([A, section("## B", 400), C].join("\n\n"), 368, P))).toBe(
      "5b19e3704f9c14981da333f6642b8759e6f0e8873b6b6fca86e29ad9787a274c",
    );
    const paragraphs = Array.from({ length: 9 }, (_, i) => `${"abcdefghi"[i]}${"p".repeat(219)}`);
    expect(digest(plan(paragraphs.join("\n\n"), 368, P))).toBe(
      "6967d734884c2f4c441490f3c75b1f5306ee3fe8639773eb3df6443bec02450d",
    );
  });
});

describe("windowBody rebalancing", () => {
  test("same window count as the greedy split, never larger windows", () => {
    const paragraphs = Array.from({ length: 9 }, (_, i) => `${"abcdefghi"[i]}${"p".repeat(219)}`);
    const body = paragraphs.join("\n\n");
    expect(body.length).toBe(1996);
    const greedy = splitBodyWithinBudget("", body, { charBudget: 1003, adapter: "x" });
    expect(greedy.map((p) => p.length)).toEqual([886, 886, 220]);
    expect(shape(plan(body, 368, P))).toEqual([
      [664, "appppppppppp", 0, 664],
      [664, "dppppppppppp", 666, 1330],
      [664, "gppppppppppp", 1332, 1996],
    ]);
  });

  const body = "aaaaaaa\n\nb\n\nc\n\ndddddd\n\ne";
  test("the trial budget grows by rebalanceStep (8 -> 9 finds three windows)", () => {
    expect(bodies(plan(body, 10, { ...U, rebalanceStep: 1.01 }))).toEqual([
      "aaaaaaa",
      "b\n\nc",
      "dddddd\n\ne",
    ]);
  });

  test("a step past the budget falls back to the greedy split (8 -> 12)", () => {
    expect(bodies(plan(body, 10, { ...U, rebalanceStep: 1.5 }))).toEqual([
      "aaaaaaa\n\nb",
      "c\n\ndddddd",
      "e",
    ]);
  });
});

describe("windowBody parameters", () => {
  // Each budget parameter moves a body of 6 units from whole to windows at the edge.
  const edges: Array<[string, Partial<WindowParams>, number, WindowBodyPlan["kind"]]> = [
    ["unit base fits", {}, 6, "whole"],
    ["charsPerToken", { charsPerToken: 0.9 }, 6, "windows"],
    ["labelReserveChars", { labelReserveChars: 1 }, 6, "windows"],
    ["tokenMargin", { tokenMargin: 1 }, 6, "windows"],
    ["joinChars", { joinChars: 1 }, 6, "windows"],
    [
      "all budget parameters to no room",
      { tokenMargin: 2, joinChars: 2, labelReserveChars: 2 },
      6,
      "no-room",
    ],
  ];
  for (const [name, override, maxInputTokens, kind] of edges) {
    test(name, () => {
      expect(plan("abc\n\nd", maxInputTokens, { ...U, ...override }).kind).toBe(kind);
    });
  }

  test("minSectionChars decides merging and carrying", () => {
    const body = "# a\n\nxx\n\n# b\n\nyy\n\n# c";
    expect(bodies(plan(body, 12, U))).toEqual(["# a\n\nxx", "# b\n\nyy", "# c"]);
    expect(bodies(plan(body, 12, { ...U, minSectionChars: 8 }))).toEqual([
      "# a\n\nxx\n\n# b",
      "yy\n\n# c",
    ]);
  });

  test("a pair merges when it fits the budget exactly, not when one char over", () => {
    const body = "# aaaaaa\n\n# b\n\n# cccccccccc";
    expect(plan(body, 13, { ...U, minSectionChars: 5 })).toEqual({
      kind: "windows",
      windows: [
        { body: "# aaaaaa\n\n# b", charStart: 0, charEnd: 13 },
        { body: "# cccccccccc", charStart: 15, charEnd: 27 },
      ],
    });
    expect(bodies(plan(body, 12, { ...U, minSectionChars: 5 }))).toEqual([
      "# aaaaaa",
      "# b",
      "# cccccccccc",
    ]);
  });

  test("sections are trimmed and whitespace-only blocks are dropped", () => {
    expect(plan(" \n\n# aaaa\n\n# bbbb  ", 10, U)).toEqual({
      kind: "windows",
      windows: [
        { body: "# aaaa", charStart: 3, charEnd: 9 },
        { body: "# bbbb", charStart: 11, charEnd: 17 },
      ],
    });
    expect(bodies(plan("# aaaa\n\n \n\n# bbbb", 12, U))).toEqual(["# aaaa", "# bbbb"]);
  });

  test("refusalLabel names the caller in the refusal", () => {
    expect(messageOf(() => plan("x", Number.NaN, { ...U, refusalLabel: "my-label" }, "t"))).toBe(
      'my-label: char budget for title "t" is NaN — the title alone exceeds the embedding window',
    );
  });

  test("budget reads: params in the same order as the formula, then headChars", () => {
    const reads: string[] = [];
    const spy = <T extends object>(tag: string, target: T): T =>
      new Proxy(target, {
        get(t, key, receiver) {
          reads.push(`${tag}.${String(key)}`);
          return Reflect.get(t, key, receiver);
        },
      });
    const result = windowBody(
      spy("input", { title: "t", headChars: 0, body: "b", maxInputTokens: 0 }),
      spy("params", { ...U }),
    );
    expect(result).toEqual({ kind: "no-room" });
    expect(reads).toEqual([
      "input.title",
      "input.body",
      "params.charsPerToken",
      "input.maxInputTokens",
      "params.labelReserveChars",
      "params.tokenMargin",
      "params.joinChars",
      "input.headChars",
    ]);
  });

  test("accepts frozen params and does not mutate them", () => {
    const before = JSON.stringify(P);
    plan([section("# A", 500), section("## B", 600)].join("\n\n"), 368, P);
    expect(JSON.stringify(P)).toBe(before);
  });
});

describe("locateWindows", () => {
  const cases: Array<[string, string, string[], unknown]> = [
    [
      "a part that is not found gets nulls and does not move the cursor",
      "aaa\nbbb\nccc",
      ["aaa", "zzz", "ccc"],
      [
        { charStart: 0, charEnd: 3 },
        { charStart: null, charEnd: null },
        { charStart: 8, charEnd: 11 },
      ],
    ],
    [
      "empty and blank-only parts get nulls",
      "aaa\nbbb",
      ["", "\n\n", "bbb"],
      [
        { charStart: null, charEnd: null },
        { charStart: null, charEnd: null },
        { charStart: 4, charEnd: 7 },
      ],
    ],
    [
      "a collapsed blank run makes the span longer than the part",
      "one\n\n\n\ntwo\n\nthree",
      ["one\n\ntwo", "three"],
      [
        { charStart: 0, charEnd: 10 },
        { charStart: 12, charEnd: 17 },
      ],
    ],
    [
      "a repeated part is found after the cursor",
      "dup\n\nmid\n\ndup",
      ["dup", "dup"],
      [
        { charStart: 0, charEnd: 3 },
        { charStart: 10, charEnd: 13 },
      ],
    ],
    [
      "the head probe is the first 64 units: a later difference is ignored",
      `${"A".repeat(64)}C\nend`,
      [`${"A".repeat(64)}B\nend`],
      [{ charStart: 0, charEnd: 69 }],
    ],
    [
      "the head probe within 64 units must match",
      `${"A".repeat(63)}C\nend`,
      [`${"A".repeat(64)}\nend`],
      [{ charStart: null, charEnd: null }],
    ],
    [
      "the tail probe is the last 64 units: an earlier difference is ignored",
      `x\nS${"R".repeat(64)}`,
      [`x\nQ${"R".repeat(64)}`],
      [{ charStart: 0, charEnd: 67 }],
    ],
    [
      "the tail probe within 64 units must match",
      `x\nS${"R".repeat(63)}`,
      [`x\nQ${"R".repeat(64)}`],
      [{ charStart: null, charEnd: null }],
    ],
    ["no parts", "abc", [], []],
  ];
  for (const [name, body, parts, expected] of cases) {
    test(name, () => {
      expect(locateWindows(body, parts)).toEqual(expected as never);
    });
  }

  test("offsets carry exactly the keys charStart, charEnd", () => {
    const [found, missing] = locateWindows("ab", ["ab", "zz"]);
    expect(Object.keys(found ?? {})).toEqual(["charStart", "charEnd"]);
    expect(Object.keys(missing ?? {})).toEqual(["charStart", "charEnd"]);
  });

  test("window keys are body, charStart, charEnd", () => {
    const p = plan("ab", 10, U, "", 9);
    expect(p.kind === "windows" ? Object.keys(p.windows[0] ?? {}) : []).toEqual([
      "body",
      "charStart",
      "charEnd",
    ]);
  });
});
