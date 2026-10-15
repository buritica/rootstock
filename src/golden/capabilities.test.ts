import { expect, test } from "bun:test";
import { CAPABILITIES } from "./capabilities.ts";

test("v0.1.1 appends the two transport ids to the frozen v0.1.0 vocabulary", () => {
  expect([...CAPABILITIES]).toEqual([
    "hash.content",
    "normalize.name",
    "normalize.identifier",
    "slugify",
    "render.notion",
    "render.slack",
    "render.whatsapp",
    "render.html",
    "render.vault",
    "extract.office",
    "chunk.split",
    "chunk.version",
    "embed.text",
    "llm.request",
    "webhook.verify",
    "ingest.accounting",
    "search.lexical",
    "search.trigram",
    "search.vector",
    "search.envelope",
    "citation.display",
    "grounding.quote",
    "transport.retry",
    "transport.slack",
  ]);
});
