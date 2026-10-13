/**
 * Plain-text extraction for PDF and OOXML (docx, xlsx, pptx) bytes.
 *
 * No OCR: a PDF without a text layer extracts to "". The XLSX and PPTX readers
 * refuse a zip whose declared unpacked size exceeds the caller's
 * `maxUnpackedBytes`, checked before any entry is decompressed. DOCX goes
 * through mammoth, which applies no such ceiling.
 */
import JSZip from "jszip";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Extracted text plus the offset of each page (PDF) or slide (PPTX) in it. */
export interface ExtractedText {
  text: string;
  starts: number[];
}

/**
 * Caller policy. `maxUnpackedBytes` is the largest total declared unpacked
 * size, in bytes, of one XLSX or PPTX zip; PDF and DOCX reads ignore it.
 */
type OfficeExtractOptions = { maxUnpackedBytes: number };

const OFFICE_EXTRACT_MIME_TYPES: ReadonlySet<string> = new Set([
  PDF_MIME,
  DOCX_MIME,
  XLSX_MIME,
  PPTX_MIME,
]);

/** True for exactly the four MIME constants above. */
export function isOfficeExtractMime(mimeType: string): boolean {
  return OFFICE_EXTRACT_MIME_TYPES.has(mimeType);
}

/**
 * The text of a supported document. Throws on an unsupported MIME type, on
 * bytes the parser rejects, and on an XLSX or PPTX zip over the ceiling.
 * Returns "" when the document parses but holds no text. A PDF read hands
 * `bytes` to pdf.js, which detaches its buffer; pass a copy to keep them.
 */
export async function extractOfficeText(
  mimeType: string,
  bytes: Uint8Array,
  opts: { maxUnpackedBytes: number },
): Promise<string> {
  return (await extractOfficeTextWithPages(mimeType, bytes, opts)).text;
}

/**
 * `extractOfficeText`'s text, unchanged, plus `starts[i]`: the offset of
 * page or slide i+1 in it, or -1 when that page is blank or its opening
 * cannot be found. DOCX and XLSX always answer `starts: []`.
 */
export async function extractOfficeTextWithPages(
  mimeType: string,
  bytes: Uint8Array,
  opts: { maxUnpackedBytes: number },
): Promise<ExtractedText> {
  switch (mimeType) {
    case PDF_MIME:
      return locatePages(await extractPdfPages(bytes), mergePdfPages);
    case DOCX_MIME:
      return { text: stripNul(await extractDocxText(bytes)), starts: [] };
    case XLSX_MIME:
      return { text: stripNul(await extractXlsxText(bytes, opts)), starts: [] };
    case PPTX_MIME:
      return locatePages(await extractPptxSlides(bytes, opts), joinSlides);
    default:
      throw new Error(`office-extract: unsupported mime type ${mimeType}`);
  }
}

/**
 * Merges `pages`, trims, replaces NUL with a space, then finds each page's
 * first 60 code units in the result, searching forward from just past the
 * previous hit. A page with an empty probe, or a probe not found, is -1.
 */
function locatePages(pages: string[], merge: (pages: readonly string[]) => string): ExtractedText {
  const text = stripNul(merge(pages).trim());
  let cursor = 0;
  const starts = pages.map((page) => {
    const probe = stripNul(merge([page]))
      .trim()
      .slice(0, 60);
    if (probe.length === 0) return -1;
    const at = text.indexOf(probe, cursor);
    if (at < 0) return -1;
    cursor = at + 1;
    return at;
  });
  return { text, starts };
}

/**
 * The PDF page merge: pages joined with "\n", each run of non-newline
 * whitespace collapsed to one space, a single space either side of a newline
 * dropped, and three or more consecutive newlines cut to two. Equal to
 * unpdf's `extractText(.., { mergePages: true })` text.
 */
export function mergePdfPages(pages: readonly string[]): string {
  return pages
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Non-empty slides joined by a blank line. */
function joinSlides(slides: readonly string[]): string {
  return slides.filter((slide) => slide.length > 0).join("\n\n");
}

/** Every U+0000 becomes a space. */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", " ") : text;
}

/** One string per PDF page, before any merge. */
async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes),
  });
  return value.trim();
}

/** Decodes the five predefined XML entities, `&amp;` last. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Sums each entry's declared uncompressed size from the zip's central
 * directory (jszip's `_data.uncompressedSize`, read without decompressing)
 * and throws when the sum exceeds `opts.maxUnpackedBytes`. An entry without the
 * field counts as 0.
 */
function assertUnpackedSize(zip: JSZip, opts: OfficeExtractOptions): void {
  let total = 0;
  for (const file of Object.values(zip.files)) {
    total +=
      (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  }
  if (total > opts.maxUnpackedBytes) {
    throw new Error(
      `office-extract: this archive unpacks to ${total} bytes, over the ${opts.maxUnpackedBytes} ceiling — refusing to materialise it. A file small enough to download can still unpack into gigabytes, and an ingest run walks thousands of files unattended.`,
    );
  }
}

/** The number N in a part name ending `N.xml`, or 0. */
function partIndex(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/**
 * One string per `ppt/slides/slideN.xml`, in numeric N order, "" for a slide
 * without text. Within a slide, `<a:t>` runs concatenate into a paragraph,
 * blank paragraphs drop, and paragraphs join with "\n".
 */
async function extractPptxSlides(bytes: Uint8Array, opts: OfficeExtractOptions): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  assertUnpackedSize(zip, opts);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => partIndex(a) - partIndex(b));
  const slides: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)?.async("text");
    if (xml === undefined) continue;
    const paragraphs = Array.from(xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g), (para) =>
      Array.from((para[1] ?? "").matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g), (m) =>
        decodeXmlEntities(m[1] ?? ""),
      ).join(""),
    ).filter((line) => line.trim().length > 0);
    slides.push(paragraphs.join("\n"));
  }
  return slides;
}

/** Each `<si>` of `xl/sharedStrings.xml`, its `<t>` runs concatenated. */
async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const xml = await file.async("text");
  return Array.from(xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g), (m) =>
    Array.from((m[1] ?? "").matchAll(/<t[^>]*>([^<]*)<\/t>/g), (t) =>
      decodeXmlEntities(t[1] ?? ""),
    ).join(""),
  );
}

/**
 * One cell's text by its `t` attribute: `s` indexes the shared strings,
 * `inlineStr` concatenates its `<t>` runs, `str` decodes its `<v>`, and any
 * other type returns the raw `<v>`. Undefined when there is nothing to read.
 */
function cellText(cellXml: string, sharedStrings: string[]): string | undefined {
  const type = /\st="([^"]+)"/.exec(cellXml)?.[1];
  if (type === "s") {
    const idx = Number(/<v>(\d+)<\/v>/.exec(cellXml)?.[1]);
    return Number.isNaN(idx) ? undefined : sharedStrings[idx];
  }
  if (type === "inlineStr") {
    const runs = Array.from(cellXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g), (m) =>
      decodeXmlEntities(m[1] ?? ""),
    );
    return runs.length === 0 ? undefined : runs.join("");
  }
  if (type === "str") {
    const v = /<v>([^<]*)<\/v>/.exec(cellXml)?.[1];
    return v === undefined ? undefined : decodeXmlEntities(v);
  }
  return /<v>([^<]*)<\/v>/.exec(cellXml)?.[1];
}

/** A sheet's non-empty cells, space-joined per row, rows joined with "\n". */
function extractSheetText(xml: string, sharedStrings: string[]): string {
  const rows: string[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/g)) {
      const text = cellText(cellMatch[0], sharedStrings);
      if (text) cells.push(text);
    }
    if (cells.length > 0) rows.push(cells.join(" "));
  }
  return rows.join("\n");
}

/** Non-empty sheets in numeric `sheetN.xml` order, joined with "\n", trimmed. */
async function extractXlsxText(bytes: Uint8Array, opts: OfficeExtractOptions): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  assertUnpackedSize(zip, opts);
  const sharedStrings = await loadSharedStrings(zip);
  const sheetNames = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => partIndex(a) - partIndex(b));
  const rows: string[] = [];
  for (const name of sheetNames) {
    const xml = await zip.file(name)?.async("text");
    if (xml === undefined) continue;
    const row = extractSheetText(xml, sharedStrings);
    if (row.length > 0) rows.push(row);
  }
  return rows.join("\n").trim();
}
