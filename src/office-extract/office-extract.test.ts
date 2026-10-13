import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import jszipPkg from "jszip/package.json";
import { extractText, getDocumentProxy } from "unpdf";
import {
  DOCX_MIME,
  extractOfficeText,
  extractOfficeTextWithPages,
  isOfficeExtractMime,
  mergePdfPages,
  PDF_MIME,
  PPTX_MIME,
  XLSX_MIME,
} from "./index.ts";

// Every fixture below is built here, from invented text.

const CEILING = { maxUnpackedBytes: 200000000 };
const EPOCH = { date: new Date(0) };

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(entries)) zip.file(name, body, EPOCH);
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

/** Rewrites one entry's declared uncompressed size in the central directory. */
function declareSize(bytes: Uint8Array, entry: string, size: number): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  let patched = 0;
  for (let i = 0; i + 46 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(out.subarray(i + 46, i + 46 + nameLength));
    if (name === entry) {
      view.setUint32(i + 24, size, true);
      patched++;
    }
  }
  expect(patched).toBe(1);
  return out;
}

// --- PPTX ---------------------------------------------------------------

const run = (text: string) => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;
const para = (...runs: string[]) => `<a:p><a:pPr algn="l"/>${runs.map(run).join("")}</a:p>`;
const slideXml = (paragraphs: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="urn:a" xmlns:p="urn:p"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

/** Slides as lines: each slide is a list of paragraphs, each a single run. */
function pptxOf(slides: readonly (readonly string[])[], extra: Record<string, string> = {}) {
  const entries: Record<string, string> = {};
  slides.forEach((paragraphs, i) => {
    entries[`ppt/slides/slide${i + 1}.xml`] = slideXml(paragraphs.map((p) => para(p)).join(""));
  });
  return zipOf({ ...entries, ...extra });
}

// --- XLSX ---------------------------------------------------------------

const sheetXml = (rows: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="urn:s"><sheetData>${rows}</sheetData></worksheet>`;
const sharedXml = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="urn:s" count="1">${items}</sst>`;

function xlsxOf(sheets: Record<string, string>, shared?: string) {
  const entries: Record<string, string> = {};
  if (shared !== undefined) entries["xl/sharedStrings.xml"] = sharedXml(shared);
  for (const [name, rows] of Object.entries(sheets)) {
    entries[name.includes("/") ? name : `xl/worksheets/${name}.xml`] = sheetXml(rows);
  }
  return zipOf(entries);
}

// --- DOCX ---------------------------------------------------------------

function docxOf(body: string) {
  return zipOf({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

const wp = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// --- PDF ----------------------------------------------------------------

/** An uncompressed PDF, one Helvetica text line per string, with a computed xref. */
function pdfOf(pages: readonly (readonly string[])[]): Uint8Array {
  const pdfString = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    const ops = lines
      .map((line, j) => `BT /F1 12 Tf 72 ${720 - j * 20} Td (${pdfString(line)}) Tj ET`)
      .join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
    );
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// ------------------------------------------------------------------------

describe("surface", () => {
  test("the subpath exports exactly the frozen names", async () => {
    const mod = await import("@buritica/rootstock/office-extract");
    expect(Object.keys(mod).sort()).toEqual([
      "DOCX_MIME",
      "PDF_MIME",
      "PPTX_MIME",
      "XLSX_MIME",
      "extractOfficeText",
      "extractOfficeTextWithPages",
      "isOfficeExtractMime",
      "mergePdfPages",
    ]);
  });

  test("MIME constants", () => {
    expect([PDF_MIME, DOCX_MIME, XLSX_MIME, PPTX_MIME]).toEqual([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]);
  });
});

describe("isOfficeExtractMime", () => {
  const cases: [string, boolean][] = [
    ["application/pdf", true],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", true],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", true],
    ["application/vnd.openxmlformats-officedocument.presentationml.presentation", true],
    ["", false],
    ["APPLICATION/PDF", false],
    [" application/pdf", false],
    ["application/pdf ", false],
    ["application/pdf; charset=binary", false],
    ["application/msword", false],
    ["application/vnd.ms-excel", false],
    ["application/vnd.ms-powerpoint", false],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.template", false],
    ["application/vnd.google-apps.document", false],
    ["text/plain", false],
  ];
  for (const [mime, expected] of cases) {
    test(`${JSON.stringify(mime)} → ${expected}`, () => {
      expect(isOfficeExtractMime(mime)).toBe(expected);
    });
  }
});

describe("unsupported MIME type", () => {
  const cases: [string, string][] = [
    ["text/plain", "office-extract: unsupported mime type text/plain"],
    ["", "office-extract: unsupported mime type "],
    ["APPLICATION/PDF", "office-extract: unsupported mime type APPLICATION/PDF"],
  ];
  for (const [mime, message] of cases) {
    test(`${JSON.stringify(mime)} rejects with a plain Error`, async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      for (const extract of [extractOfficeText, extractOfficeTextWithPages]) {
        const error = await extract(mime, bytes, CEILING).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).constructor).toBe(Error);
        expect((error as Error).name).toBe("Error");
        expect((error as Error).message).toBe(message);
      }
    });
  }
});

describe("mergePdfPages", () => {
  const cases: [string, readonly string[], string][] = [
    ["no pages", [], ""],
    ["one page", ["a"], "a"],
    ["pages join with a newline", ["a", "b", "c"], "a\nb\nc"],
    ["space and tab runs collapse", ["a  b\t\tc \t d"], "a b c d"],
    ["NBSP collapses to a space", ["a  b"], "a b"],
    ["U+3000 collapses to a space", ["a　b　　c"], "a b c"],
    ["lone NBSP becomes a space", [" "], " "],
    ["U+2028 is whitespace, not a newline", ["a b"], "a b"],
    ["U+200B is not whitespace", ["a​b"], "a​b"],
    ["NUL is left alone", ["a\u0000b"], "a\u0000b"],
    ["spaces around a newline drop", ["a \n b"], "a\nb"],
    ["collapsed runs around a newline drop", ["a  \t\n  b"], "a\nb"],
    ["CRLF becomes LF", ["a\r\nb"], "a\nb"],
    ["lone CR becomes a space", ["a\rb"], "a b"],
    ["blank pages cut to one blank line", ["a", "", "", "b"], "a\n\nb"],
    ["two newlines kept", ["a\n\nb"], "a\n\nb"],
    ["five newlines cut to two", ["a\n\n\n\n\nb"], "a\n\nb"],
    ["space-separated newlines cut to two", ["a\n \n \nb"], "a\n\nb"],
    ["no trim at the ends", [" lead ", " trail "], " lead\ntrail "],
    ["leading newline kept", ["\na"], "\na"],
  ];
  for (const [name, pages, expected] of cases) {
    test(name, () => {
      expect(mergePdfPages(pages)).toBe(expected);
    });
  }

  test("accepts a frozen array and leaves it untouched", () => {
    const pages = Object.freeze(["x  y", "z"]);
    expect(mergePdfPages(pages)).toBe("x y\nz");
    expect(pages).toEqual(["x  y", "z"]);
  });
});

describe("PDF", () => {
  const pages = [
    ["Harbor ledger   page one", "second line (draft)"],
    [],
    ["  Quill notes  "],
    ["Harbor ledger page one"],
  ];

  test("text and page starts: blank page -1, repeated opening found after the first", async () => {
    const result = await extractOfficeTextWithPages(PDF_MIME, pdfOf(pages), CEILING);
    expect(result).toEqual({
      text: "Harbor ledger page one\nsecond line (draft)\n\nQuill notes\nHarbor ledger page one",
      starts: [0, -1, 44, 56],
    });
    expect(Object.keys(result)).toEqual(["text", "starts"]);
  });

  test("text equals unpdf's mergePages: true output", async () => {
    const merged = await extractText(await getDocumentProxy(pdfOf(pages)), { mergePages: true });
    const text = await extractOfficeText(PDF_MIME, pdfOf(pages), CEILING);
    expect(text).toBe(merged.text);
    expect(sha256(text)).toBe("5755071af476671f65f34feb2e94e168129e80bc913439f904daeccf004ab42f");
  });

  test("reading a PDF detaches the caller's buffer", async () => {
    const bytes = pdfOf([["kept?"]]);
    const copy = bytes.slice();
    expect(await extractOfficeText(PDF_MIME, copy, CEILING)).toBe("kept?");
    expect(copy.byteLength).toBe(0);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test("a PDF with no text layer extracts to empty", async () => {
    expect(await extractOfficeTextWithPages(PDF_MIME, pdfOf([[], []]), CEILING)).toEqual({
      text: "",
      starts: [-1, -1],
    });
  });

  test("the unpacked ceiling does not apply", async () => {
    expect(await extractOfficeText(PDF_MIME, pdfOf([["tiny"]]), { maxUnpackedBytes: 0 })).toBe(
      "tiny",
    );
  });
});

describe("DOCX", () => {
  const cases: [string, string, string][] = [
    ["paragraphs separate with a blank line", wp("first") + wp("second"), "first\n\nsecond"],
    ["a double-escaped entity decodes once", wp("a &amp;lt; b &amp;amp; c"), "a &lt; b &amp; c"],
    ["entities decode", wp("&lt;tag&gt; &quot;q&quot; &apos;s&apos; &amp;"), "<tag> \"q\" 's' &"],
    ["trim, then a leading NUL becomes a space", wp(" \u0000lead"), " lead"],
    ["trim, then a trailing NUL becomes a space", wp("tail\u0000 "), "tail "],
    ["an inner NUL becomes a space", wp("x\u0000y\u0000\u0000z"), "x y  z"],
    ["surrounding whitespace trims", wp("  padded  "), "padded"],
    ["whitespace only is empty", wp("   "), ""],
  ];
  for (const [name, body, expected] of cases) {
    test(name, async () => {
      const result = await extractOfficeTextWithPages(DOCX_MIME, await docxOf(body), CEILING);
      expect(result).toEqual({ text: expected, starts: [] });
      expect(Object.keys(result)).toEqual(["text", "starts"]);
    });
  }

  test("the unpacked ceiling does not apply", async () => {
    expect(
      await extractOfficeText(DOCX_MIME, await docxOf(wp("small")), { maxUnpackedBytes: 0 }),
    ).toBe("small");
  });
});

describe("XLSX", () => {
  const shared = [
    "<si><t>alpha</t></si>",
    '<si><r><rPr><b/></rPr><t>be</t></r><r><t xml:space="preserve">ta</t></r></si>',
    "<si><t>&amp;amp; &lt;x&gt;</t></si>",
    "<si><t></t></si>",
  ].join("");

  const cases: [string, Record<string, string>, string | undefined, string][] = [
    [
      "shared strings, rich text runs concatenate",
      { sheet1: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' },
      shared,
      "alpha beta",
    ],
    [
      "a shared string decodes once",
      { sheet1: '<row r="1"><c r="A1" t="s"><v>2</v></c></row>' },
      shared,
      "&amp; <x>",
    ],
    [
      "shared index out of range is skipped",
      { sheet1: '<row r="1"><c r="A1" t="s"><v>9</v></c><c r="B1"><v>5</v></c></row>' },
      shared,
      "5",
    ],
    [
      "shared index without a sharedStrings part is skipped",
      { sheet1: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>6</v></c></row>' },
      undefined,
      "6",
    ],
    [
      "inline string runs concatenate",
      {
        sheet1:
          '<row r="1"><c r="A1" t="inlineStr"><is><r><t>in</t></r><r><t>line &amp;amp;</t></r></is></c></row>',
      },
      undefined,
      "inline &amp;",
    ],
    [
      "an inline string with no runs, an empty run, or an empty shared string adds no cell",
      {
        sheet1:
          '<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is></is></c><c r="C1" t="inlineStr"><is><t></t></is></c><c r="D1" t="s"><v>3</v></c><c r="E1"><v>2</v></c></row>',
      },
      shared,
      "1 2",
    ],
    [
      "str reads the cached value, decoded once",
      { sheet1: '<row r="1"><c r="A1" t="str"><f>A2&amp;"x"</f><v>a &amp;amp; b</v></c></row>' },
      undefined,
      "a &amp; b",
    ],
    [
      "formula-only cells are skipped",
      {
        sheet1:
          '<row r="1"><c r="A1"><f>SUM(B1:B2)</f></c><c r="B1" t="str"><f>NOW()</f></c><c r="C1"><v>3</v></c></row>',
      },
      undefined,
      "3",
    ],
    [
      'numeric "0" is kept',
      { sheet1: '<row r="1"><c r="A1"><v>0</v></c><c r="B1"><v>0.5</v></c></row>' },
      undefined,
      "0 0.5",
    ],
    [
      "other types return the raw value, not decoded",
      {
        sheet1:
          '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="e"><v>#N/A</v></c><c r="C1" t="n"><v>&amp;</v></c></row>',
      },
      undefined,
      "1 #N/A &amp;",
    ],
    [
      "a self-closing cell with no full cell after it is skipped",
      {
        sheet1:
          '<row r="1"><c r="A1" s="1"/></row><row r="2"><c r="A2"><v>8</v></c><c r="B2" s="1"/></row>',
      },
      undefined,
      "8",
    ],
    [
      "a self-closing cell before a full cell adds nothing of its own",
      { sheet1: '<row r="1"><c r="A1" s="1"/><c r="B1"><v>7</v></c></row>' },
      undefined,
      "7",
    ],
    [
      "a self-closing cell's type attribute applies to the next cell's value",
      { sheet1: '<row r="1"><c r="A1" t="s"/><c r="B1"><v>0</v></c></row>' },
      shared,
      "alpha",
    ],
    [
      "rows join with a newline, cells with a space",
      {
        sheet1:
          '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"></row><row r="3"><c r="A3"><v>3</v></c></row>',
      },
      undefined,
      "1 2\n3",
    ],
    [
      "sheets read in numeric order 1, 2, 10",
      {
        sheet10: '<row r="1"><c r="A1"><v>10</v></c></row>',
        sheet2: '<row r="1"><c r="A1"><v>2</v></c></row>',
        sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>',
      },
      undefined,
      "1\n2\n10",
    ],
    [
      "an empty sheet adds no blank line",
      {
        sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>',
        sheet2: "",
        sheet3: '<row r="1"><c r="A1"><v>3</v></c></row>',
      },
      undefined,
      "1\n3",
    ],
    [
      "parts outside xl/worksheets/sheetN.xml are ignored",
      {
        sheet1: '<row r="1"><c r="A1"><v>1</v></c></row>',
        sheetA: '<row r="1"><c r="A1"><v>99</v></c></row>',
        "xl/chartsheets/sheet2.xml": '<row r="1"><c r="A1"><v>98</v></c></row>',
        "xl/worksheets/_rels/sheet1.xml.rels": '<row r="1"><c r="A1"><v>97</v></c></row>',
      },
      undefined,
      "1",
    ],
    [
      "trim, then a leading NUL becomes a space",
      { sheet1: '<row r="1"><c r="A1" t="inlineStr"><is><t>\u0000x</t></is></c></row>' },
      undefined,
      " x",
    ],
    [
      "cell whitespace survives inside, the whole text trims",
      {
        sheet1:
          '<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">  a  </t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">  b  </t></is></c></row>',
      },
      undefined,
      "a  \n  b",
    ],
  ];
  for (const [name, sheets, sharedItems, expected] of cases) {
    test(name, async () => {
      const result = await extractOfficeTextWithPages(
        XLSX_MIME,
        await xlsxOf(sheets, sharedItems),
        CEILING,
      );
      expect(result).toEqual({ text: expected, starts: [] });
      expect(Object.keys(result)).toEqual(["text", "starts"]);
    });
  }

  test("a 300-row sheet, pinned by digest", async () => {
    let rows = "";
    for (let r = 1; r <= 300; r++) {
      rows += `<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}" t="inlineStr"><is><t>item ${r * 7}</t></is></c></row>`;
    }
    const text = await extractOfficeText(XLSX_MIME, await xlsxOf({ sheet1: rows }), CEILING);
    expect(text.length).toBe(3934);
    expect(sha256(text)).toBe("2dcc5d6a0a8f4e29e9cb1c51d9a8168cc155c10f6aecb1e7c3fdb248caf4b018");
  });

  test("bytes that are not a zip reject", async () => {
    await expect(
      extractOfficeText(XLSX_MIME, new TextEncoder().encode("not a zip"), CEILING),
    ).rejects.toThrow("end of central directory");
  });
});

describe("PPTX", () => {
  const slidesCases: [string, readonly (readonly string[])[], string, number[]][] = [
    ["an empty deck", [], "", []],
    [
      "paragraphs join with a newline, slides with a blank line",
      [["Title one", "point a"], ["Title two"]],
      "Title one\npoint a\n\nTitle two",
      [0, 19],
    ],
    [
      "a blank slide is -1 and adds no blank lines",
      [["first"], [], ["   "], ["last"]],
      "first\n\nlast",
      [0, -1, -1, 7],
    ],
    [
      "repeated openings locate in order",
      [["Repeat"], ["Repeat"], ["Repeat"]],
      "Repeat\n\nRepeat\n\nRepeat",
      [0, 8, 16],
    ],
    [
      "the search resumes one past the previous hit, so an opening inside an earlier slide locates there",
      [["ab"], ["b"]],
      "ab\n\nb",
      [0, 1],
    ],
    [
      "an astral character at probe index 59 still locates",
      [["intro"], [`${"q".repeat(59)}\u{1F600} tail`]],
      `intro\n\n${"q".repeat(59)}\u{1F600} tail`,
      [0, 7],
    ],
    [
      "the probe stops at 60 code units, so a longer run in an earlier slide can match first",
      [[`${"r".repeat(61)}A`], [`${"r".repeat(60)}B`]],
      `${"r".repeat(61)}A\n\n${"r".repeat(60)}B`,
      [0, 1],
    ],
    [
      "slides sharing their first 60 code units locate in order",
      [[`${"r".repeat(60)}one`], [`${"r".repeat(60)}two`]],
      `${"r".repeat(60)}one\n\n${"r".repeat(60)}two`,
      [0, 65],
    ],
    [
      "trim, then a leading NUL becomes a space and the start skips it",
      [["\u0000Lead"], ["x\u0000y"]],
      " Lead\n\nx y",
      [1, 7],
    ],
    [
      "entities decode once, &amp; last",
      [["&lt;b&gt; &amp;amp; &quot;&apos;"]],
      "<b> &amp; \"'",
      [0],
    ],
    [
      "the deck text trims but inner run whitespace stays",
      [["  spaced  "], ["  next"]],
      "spaced  \n\n  next",
      [0, 12],
    ],
  ];
  for (const [name, slides, text, starts] of slidesCases) {
    test(name, async () => {
      const result = await extractOfficeTextWithPages(PPTX_MIME, await pptxOf(slides), CEILING);
      expect(result).toEqual({ text, starts });
      expect(Object.keys(result)).toEqual(["text", "starts"]);
    });
  }

  test("runs concatenate within a paragraph; preserve-attribute runs and pPr are read", async () => {
    const bytes = await zipOf({
      "ppt/slides/slide1.xml": slideXml(
        `<a:p><a:pPr lvl="1"/>${run("impor")}${run("tant")}</a:p>` +
          '<a:p><a:r><a:t xml:space="preserve">Lead </a:t></a:r><a:r><a:t>word</a:t></a:r></a:p>' +
          `<a:p>${run("   ")}</a:p>`,
      ),
    });
    expect(await extractOfficeTextWithPages(PPTX_MIME, bytes, CEILING)).toEqual({
      text: "important\nLead word",
      starts: [0],
    });
  });

  test("slides read in numeric order 1, 2, 10; other parts ignored", async () => {
    const bytes = await zipOf({
      "ppt/slides/slide10.xml": slideXml(para("ten")),
      "ppt/slides/slide2.xml": slideXml(para("two")),
      "ppt/slides/slide1.xml": slideXml(para("one")),
      "ppt/slideLayouts/slideLayout1.xml": slideXml(para("layout")),
      "ppt/notesSlides/notesSlide1.xml": slideXml(para("notes")),
      "ppt/slides/_rels/slide1.xml.rels": slideXml(para("rels")),
    });
    expect(await extractOfficeTextWithPages(PPTX_MIME, bytes, CEILING)).toEqual({
      text: "one\n\ntwo\n\nten",
      starts: [0, 5, 10],
    });
  });
});

describe("unpacked-size ceiling", () => {
  const ceilingMessage = (total: number, ceiling: number) =>
    `office-extract: this archive unpacks to ${total} bytes, over the ${ceiling} ceiling — refusing to materialise it. A file small enough to download can still unpack into gigabytes, and an ingest run walks thousands of files unattended.`;

  async function rejection(promise: Promise<unknown>): Promise<Error> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("Error");
    return error as Error;
  }

  test("jszip 3.10.2 entries carry _data.uncompressedSize; empty entries and folders count as 0", async () => {
    expect(jszipPkg.version).toBe("3.10.2");
    const entries = { "a.txt": "12345", "b/c.txt": "xyz", "empty.txt": "" };
    const stored = await zipOf(entries);
    const deflated = await (() => {
      const zip = new JSZip();
      for (const [name, body] of Object.entries(entries)) zip.file(name, body, EPOCH);
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    })();
    for (const bytes of [stored, deflated]) {
      const zip = await JSZip.loadAsync(bytes);
      const sizes = Object.entries(zip.files).map(([name, file]) => [
        name,
        file.dir,
        (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize,
      ]);
      expect(sizes).toEqual([
        ["a.txt", false, 5],
        ["b/", true, undefined],
        ["b/c.txt", false, 3],
        ["empty.txt", false, undefined],
      ]);
    }
  });

  test("tiny ceiling: equal passes, one under rejects (PPTX and XLSX)", async () => {
    const slide = slideXml(para("ok"));
    const pptx = await zipOf({ "ppt/slides/slide1.xml": slide });
    const sheet = sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>');
    const xlsx = await zipOf({ "xl/worksheets/sheet1.xml": sheet });
    expect(slide.length).toBe(241);
    expect(sheet.length).toBe(137);

    expect(await extractOfficeText(PPTX_MIME, pptx, { maxUnpackedBytes: 241 })).toBe("ok");
    expect(
      (await rejection(extractOfficeText(PPTX_MIME, pptx, { maxUnpackedBytes: 240 }))).message,
    ).toBe(ceilingMessage(241, 240));
    expect(await extractOfficeText(XLSX_MIME, xlsx, { maxUnpackedBytes: 137 })).toBe("1");
    expect(
      (await rejection(extractOfficeTextWithPages(XLSX_MIME, xlsx, { maxUnpackedBytes: 136 })))
        .message,
    ).toBe(ceilingMessage(137, 136));
  });

  test("the sum spans every entry, not just the parts that are read", async () => {
    const bytes = await zipOf({
      "ppt/slides/slide1.xml": slideXml(para("ok")),
      "pad.bin": "12345",
    });
    expect(await extractOfficeText(PPTX_MIME, bytes, { maxUnpackedBytes: 246 })).toBe("ok");
    expect(
      (await rejection(extractOfficeText(PPTX_MIME, bytes, { maxUnpackedBytes: 245 }))).message,
    ).toBe(ceilingMessage(246, 245));
  });

  test("200000000: a declared total at the ceiling passes, one byte over rejects before decompressing", async () => {
    const slide = slideXml(para("declared"));
    const sheet = sheetXml('<row r="1"><c r="A1"><v>2</v></c></row>');
    const pptx = await zipOf({ "ppt/slides/slide1.xml": slide, "pad.bin": "x" });
    const xlsx = await zipOf({ "xl/worksheets/sheet1.xml": sheet, "pad.bin": "x" });

    const atPptx = declareSize(pptx, "pad.bin", 200000000 - slide.length);
    const overPptx = declareSize(pptx, "pad.bin", 200000001 - slide.length);
    expect(await extractOfficeTextWithPages(PPTX_MIME, atPptx, CEILING)).toEqual({
      text: "declared",
      starts: [0],
    });
    expect((await rejection(extractOfficeText(PPTX_MIME, overPptx, CEILING))).message).toBe(
      "office-extract: this archive unpacks to 200000001 bytes, over the 200000000 ceiling — refusing to materialise it. A file small enough to download can still unpack into gigabytes, and an ingest run walks thousands of files unattended.",
    );

    const atXlsx = declareSize(xlsx, "pad.bin", 200000000 - sheet.length);
    const overXlsx = declareSize(xlsx, "pad.bin", 200000001 - sheet.length);
    expect(await extractOfficeText(XLSX_MIME, atXlsx, CEILING)).toBe("2");
    expect(
      (await rejection(extractOfficeTextWithPages(XLSX_MIME, overXlsx, CEILING))).message,
    ).toBe(ceilingMessage(200000001, 200000000));
  });

  test("a NaN ceiling never rejects", async () => {
    const bytes = await zipOf({ "ppt/slides/slide1.xml": slideXml(para("ok")) });
    expect(await extractOfficeText(PPTX_MIME, bytes, { maxUnpackedBytes: Number.NaN })).toBe("ok");
  });
});
