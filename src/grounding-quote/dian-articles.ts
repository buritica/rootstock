// grounding.quote/dian-articles: decides whether a quote a model attributes to
// a source text actually appears in it, tolerating case, accent, whitespace and
// punctuation noise but never a changed, added or removed word.

// Folds case, combining marks and whitespace runs, then trims. Hyphens are left
// alone, so labels such as "12-3" survive.
function normalizeForQuoteMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Eleven quotation code points are dropped and seven dash code points become
// "-". U+201B and U+2033 are deliberately not in the first set.
const QUOTE_CHARS = /["'‘’‚“”„′«»]/g;
const DASHES = /[‐‑‒–—−­]/g;

// normalizeForQuoteMatch plus quotation-mark removal and dash folding. No
// letter or digit is ever dropped, so a quote with a different word still
// cannot match.
function normalizeQuoteForMatch(text: string): string {
  return normalizeForQuoteMatch(text)
    .replace(QUOTE_CHARS, "")
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// A quote fragment that touches a table row (contains "|") must sit inside a
// single line of the source text. Quotes with no pipe are unconstrained.
function quoteRowsAreIntact(bodyText: string, supportingQuote: string): boolean {
  const fragments = splitOnElision(normalizeQuoteForMatch(supportingQuote)) ?? [
    normalizeQuoteForMatch(supportingQuote),
  ];
  const tableFragments = fragments.filter((f) => f.includes("|"));
  if (tableFragments.length === 0) return true;
  const lines = bodyText.split("\n").map(normalizeQuoteForMatch);
  return tableFragments.every((fragment) => lines.some((line) => line.includes(fragment)));
}

// The source sentence sharing the largest share of the quote's distinct
// content words (4+ ASCII letters or digits after accent folding). Returns
// undefined when the quote has too few such words or no sentence reaches the
// minimum score. Ties keep the earliest sentence.
function nearestSupportingSpan(bodyText: string, quote: string): string | undefined {
  const words = (t: string) =>
    new Set(
      t
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .match(/[a-z0-9]{4,}/g) ?? [],
    );
  const wanted = words(quote);
  if (wanted.size < dianArticles.nearestSpanMinWords) return undefined;
  let best: { text: string; score: number } | undefined;
  for (const sentence of bodyText.split(/(?<=[.;:])\s+|\n+/)) {
    const text = sentence.trim();
    if (text.length === 0) continue;
    const have = words(text);
    let shared = 0;
    for (const w of wanted) if (have.has(w)) shared++;
    const score = shared / wanted.size;
    if (!best || score > best.score) best = { text, score };
  }
  return best && best.score >= dianArticles.nearestSpanMinScore ? best.text : undefined;
}

// True when the normalized quote is a substring of the normalized source, or,
// for an elided quote, when every fragment appears in order without overlap.
// A blank quote is supported; a table fragment straddling rows is not.
function quoteIsSupported(bodyText: string, supportingQuote: string): boolean {
  if (!quoteRowsAreIntact(bodyText, supportingQuote)) return false;
  if (supportingQuote.trim().length === 0) return true;
  const body = normalizeQuoteForMatch(bodyText);
  const quote = normalizeQuoteForMatch(supportingQuote);
  const segments = splitOnElision(quote);
  if (segments === null) return body.includes(quote);
  let from = 0;
  for (const segment of segments) {
    const at = body.indexOf(segment, from);
    if (at === -1) return false;
    from = at + segment.length;
  }
  return true;
}

// Elision markers: "[...]" or "[…]" (inner spaces allowed), a bare "…", or "...".
const ELISION = /\[\s*(?:\.\.\.|…)\s*\]|…|\.\.\./g;

// Splits an elided quote into its trimmed fragments. Returns null (match the
// quote whole) when there is no marker, fewer than two fragments, or any
// fragment shorter than minElidedSegmentChars. The shared stateful pattern is
// reset first, so repeated calls agree.
function splitOnElision(quote: string): string[] | null {
  ELISION.lastIndex = 0;
  if (!ELISION.test(quote)) return null;
  const segments = quote
    .split(ELISION)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  if (segments.some((s) => s.length < dianArticles.minElidedSegmentChars)) return null;
  return segments;
}

/** grounding.quote/dian-articles */
export const dianArticles: {
  readonly id: "dian-articles";
  readonly minElidedSegmentChars: 24;
  readonly nearestSpanMinWords: 4;
  readonly nearestSpanMinScore: 0.6;
  readonly normalizeForQuoteMatch: (text: string) => string;
  readonly normalizeQuoteForMatch: (text: string) => string;
  readonly splitOnElision: (quote: string) => string[] | null;
  readonly quoteRowsAreIntact: (bodyText: string, supportingQuote: string) => boolean;
  readonly quoteIsSupported: (bodyText: string, supportingQuote: string) => boolean;
  readonly nearestSupportingSpan: (bodyText: string, quote: string) => string | undefined;
} = Object.freeze({
  id: "dian-articles",
  minElidedSegmentChars: 24,
  nearestSpanMinWords: 4,
  nearestSpanMinScore: 0.6,
  normalizeForQuoteMatch,
  normalizeQuoteForMatch,
  splitOnElision,
  quoteRowsAreIntact,
  quoteIsSupported,
  nearestSupportingSpan,
});
