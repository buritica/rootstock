import { describe, expect, test } from "bun:test";
import { dianArticles } from "./dian-articles.ts";

const {
  normalizeForQuoteMatch,
  normalizeQuoteForMatch,
  splitOnElision,
  quoteRowsAreIntact,
  quoteIsSupported,
  nearestSupportingSpan,
} = dianArticles;

// Fragments of exactly 24 and 23 characters, the elision threshold and one under it.
const A24 = "alpha bravo charlie delt";
const B24T = "echo foxtrot golf hotels";
const A23 = "alpha bravo charlie del";
const B23 = "echo foxtrot golf hotel";

describe("surface", () => {
  test("subpath exports exactly dianArticles", async () => {
    expect(Object.keys(await import("@buritica/rootstock/grounding-quote")).sort()).toEqual([
      "dianArticles",
    ]);
  });

  test("profile keys, values and freeze", () => {
    expect(Object.keys(dianArticles)).toEqual([
      "id",
      "minElidedSegmentChars",
      "nearestSpanMinWords",
      "nearestSpanMinScore",
      "normalizeForQuoteMatch",
      "normalizeQuoteForMatch",
      "splitOnElision",
      "quoteRowsAreIntact",
      "quoteIsSupported",
      "nearestSupportingSpan",
    ]);
    expect(dianArticles.id).toBe("dian-articles");
    expect(dianArticles.minElidedSegmentChars).toBe(24);
    expect(dianArticles.nearestSpanMinWords).toBe(4);
    expect(dianArticles.nearestSpanMinScore).toBe(0.6);
    expect(Object.isFrozen(dianArticles)).toBe(true);
  });

  test("members work destructured from the profile", () => {
    expect(quoteIsSupported("Some body text.", "body TEXT")).toBe(true);
    expect(splitOnElision(`${A24} ... ${B24T}`)).toEqual([A24, B24T]);
  });
});

describe("normalizeForQuoteMatch", () => {
  const cases: [string, string][] = [
    ["\u0130", "i"],
    ["\u00df", "\u00df"],
    ["Stra\u00dfe", "stra\u00dfe"],
    ["\u00c1rbol  \u00d1and\u00fa", "arbol nandu"],
    ["A\u0301", "a"],
    ["  Mixed\tCase\r\nText  ", "mixed case text"],
    ["a\u00a0b\u2003c", "a b c"],
    ["12-3", "12-3"],
    ["\u201cq\u201d \u2013 x", "\u201cq\u201d \u2013 x"],
    ["", ""],
    ["   ", ""],
  ];
  test.each(cases)("%j -> %j", (input, expected) => {
    expect(normalizeForQuoteMatch(input)).toBe(expected);
  });
});

describe("normalizeQuoteForMatch", () => {
  const QUOTES = [
    '"',
    "'",
    "\u2018",
    "\u2019",
    "\u201a",
    "\u201c",
    "\u201d",
    "\u201e",
    "\u2032",
    "\u00ab",
    "\u00bb",
  ];
  const DASHES = ["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212", "\u00ad"];

  test.each(QUOTES)("quote %j is removed", (c) => {
    expect(normalizeQuoteForMatch(`a${c}b`)).toBe("ab");
  });

  test.each(DASHES)("dash %j becomes a hyphen", (c) => {
    expect(normalizeQuoteForMatch(`a${c}b`)).toBe("a-b");
  });

  const cases: [string, string][] = [
    ["a\u201bb", "a\u201bb"],
    ["a\u2033b", "a\u2033b"],
    ["co\u00adop", "co-op"],
    ["a - b", "a - b"],
    ["\u201c Quoted \u201d text", "quoted text"],
    ["say \u00ab x \u00bb now", "say x now"],
    ["\u0130STANBUL \u2014 \u00c9T\u00c9", "istanbul - ete"],
    ["\u2018\u2019", ""],
    ["it's  \u201cfine\u201d.", "its fine."],
  ];
  test.each(cases)("%j -> %j", (input, expected) => {
    expect(normalizeQuoteForMatch(input)).toBe(expected);
  });
});

describe("splitOnElision", () => {
  const cases: [string, string[] | null][] = [
    [`${A24} [...] ${B24T}`, [A24, B24T]],
    [`${A24}[...]${B24T}`, [A24, B24T]],
    [`${A24} [\u2026] ${B24T}`, [A24, B24T]],
    [`${A24} [ ... ] ${B24T}`, [A24, B24T]],
    [`${A24} \u2026 ${B24T}`, [A24, B24T]],
    [`${A24} ... ${B24T}`, [A24, B24T]],
    [`${A24} ... ${B24T} [...] ${A24}`, [A24, B24T, A24]],
    [`${A24}....${B24T}`, [A24, `.${B24T}`]],
    [`${A23} ... ${B24T}`, null],
    [`${A24} ... ${B23}`, null],
    [`[...] ${A24}`, null],
    [`${A24} [...]`, null],
    [`... ${A24} ...`, null],
    [`${A24} ${B24T}`, null],
    [`${A24} .. ${B24T}`, null],
    [`${A24} [..] ${B24T}`, null],
    ["", null],
    [`  ${A24.toUpperCase()}  ...  ${B24T}  `, [A24.toUpperCase(), B24T]],
  ];
  test.each(cases)("%j", (input, expected) => {
    expect(splitOnElision(input)).toEqual(expected);
  });

  test("called twice in a row gives the same answer", () => {
    const q = `${A24} [...] ${B24T}`;
    expect(splitOnElision(q)).toEqual([A24, B24T]);
    expect(splitOnElision(q)).toEqual([A24, B24T]);
  });

  test("a late marker followed by an early marker still splits", () => {
    expect(splitOnElision(`${A24} ${B24T} ${A24} ... ${B24T}`)).toEqual([
      `${A24} ${B24T} ${A24}`,
      B24T,
    ]);
    expect(splitOnElision(`${A24}...${B24T}`)).toEqual([A24, B24T]);
  });

  test("quoteIsSupported called twice in a row gives the same answer", () => {
    const body = `${A24} middle words here ${B24T}.`;
    const q = `${A24} [...] ${B24T}`;
    expect(quoteIsSupported(body, q)).toBe(true);
    expect(quoteIsSupported(body, q)).toBe(true);
  });
});

describe("quoteIsSupported", () => {
  const PROSE =
    "The first clause sets the general rule for every filer. " +
    "The second clause adds an exception for small filers; it applies only once.";
  const TABLE =
    "Rates are set as follows:\n" +
    "| lower bound of band | rate applied |\n" +
    "| from zero to one thousand | five percent |\n" +
    "| from one thousand upward | nine percent |\n" +
    "Closing remark.";
  const CRLF = "Alpha beta gamma.\r\n| column one header | column two header |\r\nDelta epsilon.";
  const OVERLAP = "abcdefghijklmnopqrstuvwxyz0123456789";

  const cases: [string, string, string, boolean][] = [
    ["blank quote", PROSE, "", true],
    ["whitespace-only quote", PROSE, "  \r\n\t", true],
    ["blank quote, empty body", "", "", true],
    ["exact substring", PROSE, "sets the general rule", true],
    [
      "case, accent, quote and spacing noise",
      PROSE,
      "\u201cSets  th\u00c9 GENERAL rule\u201d",
      true,
    ],
    ["changed word", PROSE, "sets the special rule", false],
    ["sentence boundary crossed", PROSE, "every filer. The second", true],
    [
      "elided, in order",
      PROSE,
      "The first clause sets the general [...] for small filers; it applies",
      true,
    ],
    [
      "elided, out of order",
      PROSE,
      "an exception for small filers [...] sets the general rule for every",
      false,
    ],
    [
      "elided fragments may not overlap",
      OVERLAP,
      "abcdefghijklmnopqrstuvwxyz ... efghijklmnopqrstuvwxyz0123",
      false,
    ],
    [
      "elided fragments may be adjacent",
      `${OVERLAP}${OVERLAP}`,
      "abcdefghijklmnopqrstuvwx ... yz0123456789abcdefghijkl",
      true,
    ],
    ["short fragments fall back to the whole quote", "a ... b", "a ... b", true],
    ["short fragments do not match loosely", PROSE, "first ... rule", false],
    ["one table row", TABLE, "| from zero to one thousand | five percent |", true],
    ["row, case-folded and partial", TABLE, "| FROM ZERO TO ONE THOUSAND | five percent", true],
    ["row straddle", TABLE, "five percent |\n| from one thousand", false],
    ["row straddle on one line", TABLE, "five percent | | from one thousand", false],
    [
      "elided across rows, each fragment in one row",
      TABLE,
      "| lower bound of band | rate [...] | from one thousand upward |",
      true,
    ],
    [
      "elided table fragment straddling rows",
      TABLE,
      "| lower bound of band | rate applied | | from [...] | from one thousand upward |",
      false,
    ],
    [
      "prose quote in a table-bearing body is unconstrained",
      TABLE,
      "Rates are set as follows",
      true,
    ],
    ["piped quote spanning a row and prose", TABLE, "nine percent | closing remark", false],
    ["piped quote spanning prose and a row", TABLE, "follows: | lower", false],
    ["crlf: row", CRLF, "| column one header | column two header |", true],
    ["crlf: prose across the break", CRLF, "gamma. | column one", false],
    ["crlf: prose spanning lines", "Alpha beta gamma.\r\nDelta epsilon.", "gamma. Delta", true],
    ["crlf: last line", CRLF, "delta epsilon", true],
  ];
  test.each(cases)("%s", (_label, body, quote, expected) => {
    expect(quoteIsSupported(body, quote)).toBe(expected);
  });
});

describe("quoteRowsAreIntact", () => {
  const BODY = "Intro line.\n| a cell | b cell |\n| c cell | d cell |\nOutro.";
  const BODY_CRLF = "Intro line.\r\n| a cell | b cell |\r\n| c cell | d cell |\r\nOutro.";
  const cases: [string, string, string, boolean][] = [
    ["no pipe in the quote", BODY, "Intro line. a cell", true],
    ["blank quote", BODY, "", true],
    ["inside one row", BODY, "| a cell | b cell |", true],
    ["straddles two rows", BODY, "b cell | | c cell", false],
    ["straddles via newline", BODY, "b cell |\n| c cell", false],
    ["table fragment absent from the body", BODY, "| z cell |", false],
    ["crlf body row", BODY_CRLF, "| c cell | d cell |", true],
    ["crlf body straddle", BODY_CRLF, "b cell | | c cell", false],
    [
      "body row is normalized line by line (case, accents, curly quotes, spaces)",
      "Intro.\n| A\u00d1O  Base | \u201cTarifa\u201d |\nEnd.",
      "| ano base | tarifa |",
      true,
    ],
    [
      "a normalized fragment still cannot straddle two body rows",
      "Intro.\n| A\u00d1O  Base |\n| \u201cTarifa\u201d |\nEnd.",
      "| ano base | tarifa |",
      false,
    ],
  ];
  test.each(cases)("%s", (_label, body, quote, expected) => {
    expect(quoteRowsAreIntact(body, quote)).toBe(expected);
  });

  test("short elided fragments are judged as one whole fragment", () => {
    expect(quoteRowsAreIntact(BODY, "| a cell ... d cell |")).toBe(false);
  });
});

describe("nearestSupportingSpan", () => {
  const cases: [string, string, string, string | undefined][] = [
    [
      "3 of 5 words is a hit (score 0.6)",
      "Nothing here matches. Amber birch cedar stand together; other words follow.",
      "amber birch cedar delta ember",
      "Amber birch cedar stand together;",
    ],
    [
      "2 of 4 words is a miss (score 0.5)",
      "Amber birch only here. Unrelated sentence entirely.",
      "amber birch cedar delta",
      undefined,
    ],
    [
      "tie keeps the first sentence",
      "Ember delta cedar first. Amber birch cedar second.",
      "amber birch cedar delta ember",
      "Ember delta cedar first.",
    ],
    [
      "a later higher score wins",
      "Amber birch cedar here. Amber birch cedar delta there.",
      "amber birch cedar delta ember",
      "Amber birch cedar delta there.",
    ],
    ["fewer than 4 distinct content words", "Amber birch cedar.", "amber birch cedar", undefined],
    [
      "repeats do not count twice",
      "Amber birch cedar.",
      "amber amber birch birch cedar cedar",
      undefined,
    ],
    [
      "words under 4 letters are ignored",
      "Amber birch cedar delta.",
      "amber birch cedar delta cat sat mat",
      "Amber birch cedar delta.",
    ],
    [
      "accents fold before matching",
      "\u00c1mber b\u00efrch c\u00e9dar d\u00e9lta.",
      "amber birch cedar delta",
      "\u00c1mber b\u00efrch c\u00e9dar d\u00e9lta.",
    ],
    [
      "sentences split on newlines and on . ; : followed by space",
      "Lead: amber birch\ncedar delta ember here.",
      "amber birch cedar delta ember",
      "cedar delta ember here.",
    ],
    ["empty body", "", "amber birch cedar delta", undefined],
    ["separator-only body", "\n\n  \n", "amber birch cedar delta", undefined],
  ];
  test.each(cases)("%s", (_label, body, quote, expected) => {
    expect(nearestSupportingSpan(body, quote)).toBe(expected);
  });
});

describe("compat pin", () => {
  // A seeded synthetic corpus, run through every member; the digest of the
  // outputs pins the profile's behavior as a whole.
  const ALPHABET = [
    "a",
    "B",
    "\u00e9",
    "\u0130",
    "\u00df",
    " ",
    "\n",
    "\r\n",
    "|",
    ".",
    ";",
    "...",
    "[\u2026]",
    "\u2026",
    "\u201c",
    "\u201b",
    "\u2014",
    "\u00ad",
    "-",
    "word ",
    "amber ",
    "cedar ",
    "0123456789",
    "\ud800",
  ];

  function corpus(seed: number, n: number): string[] {
    let s = seed >>> 0;
    const next = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    };
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const len = next() % 40;
      let t = "";
      for (let j = 0; j < len; j++) t += ALPHABET[next() % ALPHABET.length];
      out.push(t);
    }
    return out;
  }

  test("digest of outputs over 2000 seeded inputs", () => {
    const xs = corpus(20261012, 2000);
    const rows = xs.map((x, i) => {
      const body = xs[(i * 7 + 3) % xs.length] ?? "";
      return [
        normalizeForQuoteMatch(x),
        normalizeQuoteForMatch(x),
        splitOnElision(x),
        quoteRowsAreIntact(body + x, x),
        quoteIsSupported(body + x + body, x),
        quoteIsSupported(body, x),
        nearestSupportingSpan(body + x, x) ?? null,
      ];
    });
    const digest = new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex");
    expect(digest).toBe("3b81f4bcacaffe462913cbc9fc3b694b06adf8ef2e3371b5fa1aed913c2f4359");
  });
});
