import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mycelV1 } from "./index.ts";

const { chunkText, wordCount } = mycelV1;

const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");

describe("mycelV1.chunkText frontmatter", () => {
  const cases: Array<[string, string, unknown]> = [
    [
      "--- block is skipped; lines keep counting",
      "---\nk: v\n---\nbody",
      [{ chunkIndex: 0, startLine: 4, endLine: 4, text: "body" }],
    ],
    [
      '" --- " trims to the delimiter',
      " --- \nk\n --- \n\nbody",
      [{ chunkIndex: 0, startLine: 5, endLine: 5, text: "body" }],
    ],
    [
      "a leading BOM trims away",
      "\uFEFF---\nk\n---\nbody",
      [{ chunkIndex: 0, startLine: 4, endLine: 4, text: "body" }],
    ],
    [
      "an empty block",
      "---\n---\nbody",
      [{ chunkIndex: 0, startLine: 3, endLine: 3, text: "body" }],
    ],
    [
      "unterminated is body",
      "---\nk: v\n\nbody",
      [{ chunkIndex: 0, startLine: 1, endLine: 4, text: "---\nk: v\n\nbody" }],
    ],
    [
      '"--- x" does not open a block',
      "--- x\nk\n---\nbody",
      [{ chunkIndex: 0, startLine: 1, endLine: 4, text: "--- x\nk\n---\nbody" }],
    ],
    [
      "--- after the first line is body",
      "x\n---\ny\n---\nz",
      [{ chunkIndex: 0, startLine: 1, endLine: 5, text: "x\n---\ny\n---\nz" }],
    ],
    ["frontmatter only", "---\nk\n---", []],
    ["frontmatter only, trailing newline", "---\nk\n---\n", []],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(chunkText(input)).toEqual(expected as never);
    });
  }
});

describe("mycelV1.chunkText lines", () => {
  const cases: Array<[string, string, unknown]> = [
    ["empty text", "", []],
    ["blank lines only", "\n\n", []],
    [
      "CRLF normalizes before slicing",
      "a\r\n\r\nb\r\nc",
      [{ chunkIndex: 0, startLine: 1, endLine: 4, text: "a\n\nb\nc" }],
    ],
    [
      "an interior lone \\r is not a line break; a \\r-only line is blank",
      "a\rb\n\r\t\nc",
      [{ chunkIndex: 0, startLine: 1, endLine: 3, text: "a\rb\n\r\t\nc" }],
    ],
    [
      "a NEL-only line is not blank",
      "a\n\u0085\nb",
      [{ chunkIndex: 0, startLine: 1, endLine: 3, text: "a\n\u0085\nb" }],
    ],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(chunkText(input)).toEqual(expected as never);
    });
  }

  describe("what separates paragraphs", () => {
    // 200 + 201 words: one paragraph if the middle line is part of it (401 words ships alone), two if it is blank.
    const span = (separator: string) =>
      chunkText(`${words(200)}\n${separator}\n${words(201)}`).map((c) => [
        c.chunkIndex,
        c.startLine,
        c.endLine,
      ]);
    for (const [name, separator] of [
      ["spaces", "   "],
      ["a single space", " "],
      ["a \\r and a tab", "\r\t"],
    ] as const) {
      test(`a whitespace-only line (${name}) is a paragraph break`, () => {
        expect(span(separator)).toEqual([
          [0, 1, 1],
          [1, 3, 3],
        ]);
      });
    }
    test("a NEL-only line is content, not a break", () => {
      expect(span("\u0085")).toEqual([[0, 1, 3]]);
    });
    test("an empty line is a paragraph break", () => {
      expect(span("")).toEqual([
        [0, 1, 1],
        [1, 3, 3],
      ]);
    });
  });

  test("text is the raw line slice, blank runs and whitespace lines included", () => {
    const doc = [
      "---",
      "title: x",
      "---",
      "",
      "First para line one",
      "line two",
      "",
      "",
      "Second para",
      "   ",
      "Third",
    ].join("\r\n");
    const chunks = chunkText(doc);
    expect(chunks).toEqual([
      {
        chunkIndex: 0,
        startLine: 5,
        endLine: 11,
        text: "First para line one\nline two\n\n\nSecond para\n   \nThird",
      },
    ]);
    expect(createHash("sha256").update(JSON.stringify(chunks)).digest("hex")).toBe(
      "2761d494a957f48dc7325ebc3035a3c97bec044a0c4d97b20ea759530a1037a5",
    );
  });

  test("key order is chunkIndex, startLine, endLine, text", () => {
    expect(Object.keys(chunkText("a")[0] ?? {})).toEqual([
      "chunkIndex",
      "startLine",
      "endLine",
      "text",
    ]);
  });
});

describe("mycelV1.chunkText word budget", () => {
  const summary = (text: string) =>
    chunkText(text).map((c) => [c.chunkIndex, c.startLine, c.endLine, c.text.length]);

  test("200 + 200 = 400 words stays one chunk", () => {
    expect(summary(`${words(200)}\n\n${words(200)}`)).toEqual([[0, 1, 3, 800]]);
  });

  test("200 + 201 = 401 words closes the first chunk", () => {
    expect(summary(`${words(200)}\n\n${words(201)}`)).toEqual([
      [0, 1, 1, 399],
      [1, 3, 3, 401],
    ]);
  });

  test("a single paragraph over 400 words ships alone", () => {
    expect(summary(`${words(401)}\n\nshort`)).toEqual([
      [0, 1, 1, 801],
      [1, 3, 3, 5],
    ]);
  });
});

describe("mycelV1.wordCount", () => {
  const cases: Array<[string, number]> = [
    ["", 0],
    ["  ", 0],
    ["a", 1],
    [" a  b\tc\nd ", 4],
    ["a\rb", 2],
    ["a\u00A0b", 2],
    ["a\u2028b", 2],
    ["\uFEFFa", 1],
    ["a\u0085b", 1],
  ];
  for (const [text, count] of cases) {
    test(`${JSON.stringify(text)} -> ${count}`, () => {
      expect(wordCount(text)).toBe(count);
    });
  }
});

describe("mycelV1 profile", () => {
  test("data fields", () => {
    expect(mycelV1.id).toBe("mycel-v1");
    expect(mycelV1.maxWords).toBe(400);
    expect(Object.keys(mycelV1)).toEqual(["id", "maxWords", "chunkText", "wordCount"]);
  });

  test("frozen", () => {
    expect(Object.isFrozen(mycelV1)).toBe(true);
    expect(() => {
      (mycelV1 as { maxWords: number }).maxWords = 1;
    }).toThrow(TypeError);
  });

  test("destructured members work without the profile", () => {
    expect(chunkText("one\n\ntwo")).toEqual([
      { chunkIndex: 0, startLine: 1, endLine: 3, text: "one\n\ntwo" },
    ]);
    expect(wordCount("one two")).toBe(2);
  });
});
