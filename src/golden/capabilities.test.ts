import { expect, test } from "bun:test";
import { CAPABILITIES } from "./capabilities.ts";

test("appends the three data-layer ids to the frozen 24-id vocabulary, in order", () => {
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
    "db.migrate",
    "concurrency.map",
    "config",
  ]);
});
