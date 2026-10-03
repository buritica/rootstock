/**
 * The shared capability vocabulary. Every golden suite names one of these, so
 * the same capability is recorded under the same id in every consumer repo —
 * that is what lets a Phase 1 extraction say "compass's and mycel's
 * `chunk.split` goldens are unchanged" without a translation table.
 *
 * Adding an id is a minor release; renaming or removing one is breaking.
 */
export const CAPABILITIES = [
  // Text identity and normalization
  "hash.content", // content hashes that gate skip / staleness decisions
  "normalize.name", // name folding used for matching (accents, case, spaces)
  "normalize.identifier", // domain identifiers (e.g. article numbers)
  "slugify", // slug generation
  // Source rendering (source payload -> stored text)
  "render.notion",
  "render.slack",
  "render.whatsapp",
  "render.html",
  "render.vault",
  "extract.office", // PDF / DOCX / XLSX / PPTX -> text
  // Chunking and embedding inputs
  "chunk.split", // body -> chunks/parts/windows (text + locators)
  "chunk.version", // chunking-version stamp
  "embed.text", // the exact text sent to the embedder, and its hash
  // Model requests (deterministic request construction, not model output)
  "llm.request",
  // Ingest and webhooks
  "webhook.verify",
  "ingest.accounting",
  // Retrieval and answer shaping
  "search.lexical",
  "search.trigram",
  "search.vector",
  "search.envelope",
  "citation.display",
  "grounding.quote",
] as const;

export type CapabilityId = (typeof CAPABILITIES)[number];

export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITIES as readonly string[]).includes(value);
}
