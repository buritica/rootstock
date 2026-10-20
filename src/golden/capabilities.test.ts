import { expect, test } from "bun:test";
import { CAPABILITIES, isCapabilityId } from "./capabilities.ts";
import { validateSuites } from "./suite.ts";

test("v0.2.1 appends db.migrate, concurrency.map and config to the 24-id v0.2.0 vocabulary, in order", () => {
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

test("every capability id is accepted by isCapabilityId and validateSuites", () => {
  for (const capability of CAPABILITIES) {
    expect(isCapabilityId(capability)).toBe(true);
    expect(() =>
      validateSuites([{ capability, profile: "p", cases: [{ id: "c", input: 1, run: () => 1 }] }]),
    ).not.toThrow();
  }
});
