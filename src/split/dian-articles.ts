/**
 * `chunk.split/dian-articles`: block splitters that keep Markdown tables at
 * row boundaries (repeating the header) and prose at sentence boundaries
 * that do not fall inside a legal citation.
 */

export interface SentenceSegment {
  sentence: string;
  separator: string;
}

export interface OversizedChunk {
  length: number;
  indivisible: boolean;
  text: string;
}

const MAX_CHUNK_CHARS = 1500;

const SEPARATOR_ROW = /^\|(?:\s*-{3,}\s*\|)+$/;

/**
 * Splits a Markdown table longer than `maxChars` into tables of whole rows,
 * each led by the original header and separator lines. A row that does not
 * fit even alone becomes its own table. A block that is not a table (no
 * separator second line, or no rows) comes back unchanged.
 */
function splitTableForChunking(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const lines = block.split("\n");
  const [header, separator, ...rows] = lines;
  if (
    header === undefined ||
    separator === undefined ||
    !SEPARATOR_ROW.test(separator.trim()) ||
    rows.length === 0
  ) {
    return [block];
  }

  const preamble = `${header}\n${separator}`;
  const chunks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) chunks.push([preamble, ...current].join("\n"));
    current = [];
  };
  for (const row of rows) {
    const wouldBe = [preamble, ...current, row].join("\n").length;
    if (wouldBe > maxChars) flush();
    current.push(row);
  }
  flush();
  return chunks.length > 0 ? chunks : [block];
}

const CANDIDATE_BOUNDARY = /[.;:!?](\s+)/g;

const LEGAL_ABBREVIATIONS_LIST: readonly string[] = Object.freeze([
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
]);

const LEGAL_ABBREVIATIONS = new Set(LEGAL_ABBREVIATIONS_LIST);

const DOTTED_INITIALS = /^(?:\p{L}\.)*\p{L}$/u;
const CONTINUES_SENTENCE = /^[\p{Ll}\d]/u;
const TOKEN_START = /[\s([{"“«]/;

function tokenBefore(text: string, end: number): string {
  let start = end;
  while (start > 0 && !TOKEN_START.test(text.charAt(start - 1))) start--;
  return text.slice(start, end);
}

/**
 * A candidate boundary is taken unless the next char is missing, a lowercase
 * letter or a digit, or the punctuation is a `.` ending dotted initials or a
 * listed abbreviation (case-insensitive).
 */
function isSentenceBoundary(text: string, punctAt: number, nextAt: number): boolean {
  const next = text.charAt(nextAt);
  if (next === "" || CONTINUES_SENTENCE.test(next)) return false;
  if (text.charAt(punctAt) !== ".") return true;
  const token = tokenBefore(text, punctAt);
  if (DOTTED_INITIALS.test(token)) return false;
  return !LEGAL_ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * The block cut into sentences, each with the whitespace that followed it
 * (`""` for the last). Concatenating `sentence + separator` in order
 * reproduces the block exactly.
 */
function sentenceSegments(block: string): SentenceSegment[] {
  const segments: Array<{ sentence: string; separator: string }> = [];
  let start = 0;
  for (const match of block.matchAll(CANDIDATE_BOUNDARY)) {
    const punctAt = match.index;
    const separator = match[1] ?? "";
    const nextAt = punctAt + 1 + separator.length;
    if (!isSentenceBoundary(block, punctAt, nextAt)) continue;
    segments.push({ sentence: block.slice(start, punctAt + 1), separator });
    start = nextAt;
  }
  segments.push({ sentence: block.slice(start), separator: "" });
  return segments;
}

/**
 * Splits prose longer than `maxChars` at sentence boundaries, rejoining
 * sentences with their original whitespace so every chunk is a substring of
 * the block. A single sentence longer than `maxChars` is emitted alone.
 */
function splitProseForChunking(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const chunks: string[] = [];
  let current = "";
  let gap = "";
  for (const { sentence, separator } of sentenceSegments(block)) {
    if (current === "") {
      current = sentence;
    } else if (current.length + gap.length + sentence.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = `${current}${gap}${sentence}`;
    }
    gap = separator;
  }
  if (current !== "") chunks.push(current);
  return chunks.length > 0 ? chunks : [block];
}

/** Splits a table at rows, then splits each piece not starting with `|` as prose. */
function splitBlockForChunking(block: string, maxChars: number): string[] {
  return splitTableForChunking(block, maxChars).flatMap((piece) =>
    piece.startsWith("|") ? [piece] : splitProseForChunking(piece, maxChars),
  );
}

/**
 * The chunks longer than `maxChars` (default 1500), each flagged
 * `indivisible` when it is one line holding one sentence.
 */
function oversizedChunks(
  chunks: readonly string[],
  maxChars = MAX_CHUNK_CHARS,
): Array<{ length: number; indivisible: boolean; text: string }> {
  return chunks
    .filter((c) => c.length > maxChars)
    .map((c) => ({
      length: c.length,
      indivisible: !c.includes("\n") && sentenceSegments(c).length === 1,
      text: c,
    }));
}

/** `chunk.split/dian-articles`. */
export const dianArticles: {
  readonly id: "dian-articles";
  readonly maxChunkChars: 1500;
  readonly legalAbbreviations: readonly string[];
  readonly splitBlockForChunking: (block: string, maxChars: number) => string[];
  readonly splitTableForChunking: (block: string, maxChars: number) => string[];
  readonly splitProseForChunking: (block: string, maxChars: number) => string[];
  readonly sentenceSegments: (block: string) => SentenceSegment[];
  readonly oversizedChunks: (chunks: readonly string[], maxChars?: number) => OversizedChunk[];
} = Object.freeze({
  id: "dian-articles",
  maxChunkChars: MAX_CHUNK_CHARS,
  legalAbbreviations: LEGAL_ABBREVIATIONS_LIST,
  splitBlockForChunking,
  splitTableForChunking,
  splitProseForChunking,
  sentenceSegments,
  oversizedChunks,
});
