/**
 * `chunk.split/mycel-v1`: paragraph-bounded line chunks of a raw text, each
 * carrying its 1-indexed inclusive line range in the original text.
 */

export interface LineChunk {
  chunkIndex: number;
  /** 1-indexed, inclusive, counted in the original text (frontmatter included). */
  startLine: number;
  /** 1-indexed, inclusive, counted in the original text (frontmatter included). */
  endLine: number;
  text: string;
}

const MAX_WORDS = 400;

/** Whitespace-separated words of `text`, after trimming; 0 for blank text. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Index of the first body line: past a leading frontmatter block whose
 * opening and closing lines both trim to `---`. Without a closing line the
 * text has no frontmatter and the body starts at 0.
 */
function bodyStartIndex(lines: string[]): number {
  if (lines[0]?.trim() !== "---") {
    return 0;
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return i + 1;
    }
  }
  return 0;
}

interface ParagraphBlock {
  startLine: number;
  endLine: number;
  text: string;
}

/** Runs of non-blank lines (a blank line trims to ""), each with its 1-indexed line range. */
function collectParagraphs(lines: string[], fromIndex: number): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let blockLines: string[] = [];
  let blockStart = -1;

  function flush(endIndex: number) {
    if (blockLines.length === 0) return;
    blocks.push({
      startLine: blockStart + 1,
      endLine: endIndex,
      text: blockLines.join("\n"),
    });
    blockLines = [];
    blockStart = -1;
  }

  for (let i = fromIndex; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      flush(i);
      continue;
    }
    if (blockStart === -1) blockStart = i;
    blockLines.push(line);
  }
  flush(lines.length);

  return blocks;
}

/**
 * Chunks `rawText` after normalizing `\r\n` to `\n` and skipping frontmatter.
 * Paragraphs accumulate until the next one would push the chunk past 400
 * words; a single larger paragraph ships alone. Each chunk's `text` is the
 * exact `\n`-joined slice of lines `[startLine, endLine]`.
 */
function chunkText(rawText: string): LineChunk[] {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const paragraphs = collectParagraphs(lines, bodyStartIndex(lines));

  const chunks: LineChunk[] = [];
  let current: ParagraphBlock[] = [];
  let currentWords = 0;

  function closeCurrent() {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    chunks.push({
      chunkIndex: chunks.length,
      startLine: first.startLine,
      endLine: last.endLine,
      text: lines.slice(first.startLine - 1, last.endLine).join("\n"),
    });
    current = [];
    currentWords = 0;
  }

  for (const para of paragraphs) {
    const paraWords = wordCount(para.text);
    if (currentWords > 0 && currentWords + paraWords > MAX_WORDS) {
      closeCurrent();
    }
    current.push(para);
    currentWords += paraWords;
  }
  closeCurrent();

  return chunks;
}

/** `chunk.split/mycel-v1`. */
export const mycelV1: {
  readonly id: "mycel-v1";
  readonly maxWords: 400;
  readonly chunkText: (rawText: string) => LineChunk[];
  readonly wordCount: (text: string) => number;
} = Object.freeze({
  id: "mycel-v1",
  maxWords: MAX_WORDS,
  chunkText,
  wordCount,
});
