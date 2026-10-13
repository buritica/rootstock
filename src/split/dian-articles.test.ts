import { describe, expect, test } from "bun:test";
import { dianArticles } from "./index.ts";

const {
  legalAbbreviations,
  oversizedChunks,
  sentenceSegments,
  splitBlockForChunking,
  splitProseForChunking,
  splitTableForChunking,
} = dianArticles;

const ABBREVIATIONS = [
  "art",
  "arts",
  "num",
  "núm",
  "nums",
  "lit",
  "lits",
  "inc",
  "incs",
  "par",
  "parág",
  "nro",
  "dcto",
  "dto",
  "res",
  "ord",
  "cfr",
];

describe("dianArticles.sentenceSegments abbreviations", () => {
  test("the 17 abbreviations, in order", () => {
    expect(legalAbbreviations).toEqual(ABBREVIATIONS);
  });

  for (const abbr of ABBREVIATIONS) {
    test(`"${abbr}." does not end a sentence, in any case`, () => {
      for (const text of [
        `Ver ${abbr}. Siguiente`,
        `Ver ${abbr.toUpperCase()}. Siguiente`,
        `Ver (${abbr}. Siguiente`,
      ]) {
        expect(sentenceSegments(text)).toEqual([{ sentence: text, separator: "" }]);
      }
    });
  }
});

describe("dianArticles.sentenceSegments boundaries", () => {
  const cases: Array<[string, string, Array<[string, string]>]> = [
    [
      "a word that is not an abbreviation ends",
      "Ver arte. Siguiente",
      [
        ["Ver arte.", " "],
        ["Siguiente", ""],
      ],
    ],
    ["dotted initials", "Del E.T. Sigue", [["Del E.T. Sigue", ""]]],
    ["dotted initials, two letters", "La S.A. Paga", [["La S.A. Paga", ""]]],
    ["a single letter", "Ver C. Otro", [["Ver C. Otro", ""]]],
    ["a single accented letter", "Ver é. Sigue", [["Ver é. Sigue", ""]]],
    [
      "two letters without dots end",
      "Ver AB. Otro",
      [
        ["Ver AB.", " "],
        ["Otro", ""],
      ],
    ],
    [
      '"No." splits',
      "Dijo No. Luego",
      [
        ["Dijo No.", " "],
        ["Luego", ""],
      ],
    ],
    ['"No." before a digit continues', "Ver No. 5 hoy", [["Ver No. 5 hoy", ""]]],
    [
      "a digit token ends",
      "Ver 3. Sigue",
      [
        ["Ver 3.", " "],
        ["Sigue", ""],
      ],
    ],
    [
      "an astral lowercase letter after the space IS a boundary",
      "Uno. 𝐚dos",
      [
        ["Uno.", " "],
        ["𝐚dos", ""],
      ],
    ],
    ["an ASCII lowercase letter continues", "Uno. ados", [["Uno. ados", ""]]],
    ["a BMP lowercase letter continues", "Uno. ñu", [["Uno. ñu", ""]]],
    [
      "every terminal mark",
      "Uno; Dos: Tres! Cuatro? Cinco",
      [
        ["Uno;", " "],
        ["Dos:", " "],
        ["Tres!", " "],
        ["Cuatro?", " "],
        ["Cinco", ""],
      ],
    ],
    ["no trailing segment for a final period", "Fin.", [["Fin.", ""]]],
    ["trailing whitespace stays in the last sentence", "Fin. ", [["Fin. ", ""]]],
    [
      "the separator keeps its newlines",
      "Uno.\n\nDos",
      [
        ["Uno.", "\n\n"],
        ["Dos", ""],
      ],
    ],
    ["a curly quote starts a token", "Ver “art. Siguiente", [["Ver “art. Siguiente", ""]]],
    ["a guillemet starts a token", "Ver «E.T. Sigue", [["Ver «E.T. Sigue", ""]]],
    [
      "a dot does not start a token",
      "Ver x.art. Sigue",
      [
        ["Ver x.art.", " "],
        ["Sigue", ""],
      ],
    ],
  ];
  for (const [name, text, segments] of cases) {
    test(name, () => {
      expect(sentenceSegments(text)).toEqual(
        segments.map(([sentence, separator]) => ({ sentence, separator })),
      );
    });
  }

  test("segments round-trip to the block", () => {
    const block =
      "Primera. Segunda;\tTercera:\n\nCuarta del E.T. sigue. Art. 5 aquí!  Quinta? 𝐚 sexta.  ";
    const segments = sentenceSegments(block);
    expect(segments.map((s) => s.sentence)).toEqual([
      "Primera.",
      "Segunda;",
      "Tercera:",
      "Cuarta del E.T. sigue.",
      "Art. 5 aquí!",
      "Quinta?",
      "𝐚 sexta.  ",
    ]);
    expect(segments.map((s) => s.sentence + s.separator).join("")).toBe(block);
  });

  test("segment keys are sentence, separator", () => {
    expect(Object.keys(sentenceSegments("a")[0] ?? {})).toEqual(["sentence", "separator"]);
  });
});

describe("dianArticles.splitTableForChunking", () => {
  const table = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "| 5 | 6 |"].join("\n");
  const head = "| a | b |\n| --- | --- |";
  const cases: Array<[string, string, number, string[]]> = [
    ["a table that fits is unchanged", table, 100, [table]],
    [
      "rows split with the header repeated",
      table,
      45,
      [`${head}\n| 1 | 2 |\n| 3 | 4 |`, `${head}\n| 5 | 6 |`],
    ],
    [
      "a row joining to exactly max still fits (43 = header + two rows)",
      table,
      43,
      [`${head}\n| 1 | 2 |\n| 3 | 4 |`, `${head}\n| 5 | 6 |`],
    ],
    [
      "one row per chunk when only one fits",
      table,
      40,
      [`${head}\n| 1 | 2 |`, `${head}\n| 3 | 4 |`, `${head}\n| 5 | 6 |`],
    ],
    [
      "header + separator equal to max: one row per chunk",
      table,
      23,
      [`${head}\n| 1 | 2 |`, `${head}\n| 3 | 4 |`, `${head}\n| 5 | 6 |`],
    ],
    [
      "header + separator over max: one row per chunk",
      table,
      20,
      [`${head}\n| 1 | 2 |`, `${head}\n| 3 | 4 |`, `${head}\n| 5 | 6 |`],
    ],
    [
      "prose is unchanged",
      "long prose without table structure here",
      10,
      ["long prose without table structure here"],
    ],
    ["no rows is unchanged", "| a |\n| --- |", 5, ["| a |\n| --- |"]],
    ["a two-dash separator is not a table", "| a |\n| -- |\n| b |", 5, ["| a |\n| -- |\n| b |"]],
  ];
  for (const [name, block, maxChars, out] of cases) {
    test(name, () => {
      expect(splitTableForChunking(block, maxChars)).toEqual(out);
    });
  }

  test("a separator row padded with whitespace still splits by rows, kept verbatim", () => {
    const sep = "  | --- | --- |  ";
    const block = ["| a | b |", sep, "| 1 | 2 |", "| 3 | 4 |"].join("\n");
    expect(block.length).toBe(47);
    expect(splitTableForChunking(block, 40)).toEqual([
      `| a | b |\n${sep}\n| 1 | 2 |`,
      `| a | b |\n${sep}\n| 3 | 4 |`,
    ]);
  });

  test("a pipe-less header still splits by rows", () => {
    const block = ["Encabezado sin tubos", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
    expect(splitTableForChunking(block, 50)).toEqual([
      "Encabezado sin tubos\n| --- | --- |\n| 1 | 2 |",
      "Encabezado sin tubos\n| --- | --- |\n| 3 | 4 |",
    ]);
  });
});

describe("dianArticles.splitProseForChunking and splitBlockForChunking", () => {
  const prose: Array<[string, string, number, string[]]> = [
    ["a block that fits is unchanged", "Uno dos. Tres.", 20, ["Uno dos. Tres."]],
    [
      "packs sentences up to max",
      "Uno dos. Tres cuatro. Cinco seis.",
      20,
      ["Uno dos.", "Tres cuatro.", "Cinco seis."],
    ],
    [
      "an oversize sentence ships alone",
      "Una frase muy larga sin cortes. Otra.",
      10,
      ["Una frase muy larga sin cortes.", "Otra."],
    ],
    ["chunks keep the source whitespace", "Uno.\n\nDos.  Tres.", 9, ["Uno.", "Dos.", "Tres."]],
    ["rejoins with the original gap", "Ab. Cd.\nEf. Gh.", 7, ["Ab. Cd.", "Ef. Gh."]],
  ];
  for (const [name, block, maxChars, out] of prose) {
    test(`prose: ${name}`, () => {
      expect(splitProseForChunking(block, maxChars)).toEqual(out);
    });
  }

  test("block: a table splits by rows and stays a table", () => {
    const table = ["| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "| 5 | 6 |"].join("\n");
    expect(splitBlockForChunking(table, 40)).toEqual([
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "| a | b |\n| --- | --- |\n| 3 | 4 |",
      "| a | b |\n| --- | --- |\n| 5 | 6 |",
    ]);
  });

  test("block: prose splits at sentences", () => {
    expect(splitBlockForChunking("Uno dos. Tres cuatro. Cinco seis.", 20)).toEqual([
      "Uno dos.",
      "Tres cuatro.",
      "Cinco seis.",
    ]);
  });

  test("block: a table piece whose first line has no space after the pipe is not re-split as prose", () => {
    const block = ["|x|y|", "|---|---|", "|Uno. Dos|2|"].join("\n");
    expect(block.length).toBe(28);
    expect(splitBlockForChunking(block, 20)).toEqual([block]);
  });

  test("block: pieces of a pipe-less-header table are re-split as prose", () => {
    const block = ["Uno. Dos tres. Cuatro", "|---|", "| x |", "| y |"].join("\n");
    expect(splitBlockForChunking(block, 30)).toEqual([
      "Uno. Dos tres.",
      "Cuatro\n|---|\n| x |",
      "Uno. Dos tres.",
      "Cuatro\n|---|\n| y |",
    ]);
  });
});

describe("dianArticles.oversizedChunks", () => {
  test("default max is 1500", () => {
    const fits = `${"a".repeat(1499)}.`;
    const oneSentence = `${"a".repeat(1500)}.`;
    const twoSentences = `${"a".repeat(800)}. B${"b".repeat(799)}`;
    const twoLines = `${"a".repeat(800)}\n${"b".repeat(800)}`;
    expect(
      oversizedChunks([fits, oneSentence, twoSentences, twoLines]).map((o) => [
        o.length,
        o.indivisible,
        o.text === oneSentence,
      ]),
    ).toEqual([
      [1501, true, true],
      [1602, false, false],
      [1601, false, false],
    ]);
  });

  test("explicit max", () => {
    expect(oversizedChunks(["abc", "abcd. Efg", "ab\ncd", "abcd"], 3)).toEqual([
      { length: 9, indivisible: false, text: "abcd. Efg" },
      { length: 5, indivisible: false, text: "ab\ncd" },
      { length: 4, indivisible: true, text: "abcd" },
    ]);
    expect(oversizedChunks([], 3)).toEqual([]);
  });

  test("key order is length, indivisible, text", () => {
    expect(Object.keys(oversizedChunks(["abcd"], 3)[0] ?? {})).toEqual([
      "length",
      "indivisible",
      "text",
    ]);
  });
});

describe("dianArticles profile", () => {
  test("data fields", () => {
    expect(dianArticles.id).toBe("dian-articles");
    expect(dianArticles.maxChunkChars).toBe(1500);
    expect(Object.keys(dianArticles)).toEqual([
      "id",
      "maxChunkChars",
      "legalAbbreviations",
      "splitBlockForChunking",
      "splitTableForChunking",
      "splitProseForChunking",
      "sentenceSegments",
      "oversizedChunks",
    ]);
  });

  test("deep-frozen, including the abbreviation list", () => {
    expect(Object.isFrozen(dianArticles)).toBe(true);
    expect(Object.isFrozen(dianArticles.legalAbbreviations)).toBe(true);
    expect(() => {
      (dianArticles.legalAbbreviations as string[]).push("x");
    }).toThrow(TypeError);
  });

  test("destructured members work without the profile", () => {
    expect(splitBlockForChunking("Ab. Cd.", 4)).toEqual(["Ab.", "Cd."]);
  });
});
