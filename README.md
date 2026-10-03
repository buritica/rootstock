# rootstock

Shared capabilities for Bun + Postgres knowledge systems: source adapters,
ingestion, chunking, embeddings, retrieval and versioned judgments. Several
systems graft onto one tested root.

Plain TypeScript with no build step. Bun runs the source directly.

## Install

Pin a tag:

```sh
bun add github:buritica/rootstock#v0.0.1
```

Each capability is a subpath export:

```ts
import { runGoldenCli, type GoldenSuite } from "@buritica/rootstock/golden";
```

## Capabilities

| Subpath | Status | What it does |
|---|---|---|
| `golden` | v0.0.1 | Golden snapshots that prove a refactor or extraction changed nothing: canonical JSON, capture/check, a recording `fetch`, seeded vectors and throwaway Postgres |
| `golden/bun-test` | v0.0.1 | Registers golden suites as `bun test` cases |

More arrive in phases. Phase 1 extractions must be byte-identical: each
consumer adopts a module only where its goldens stay unchanged. Changes that
can alter answers come later, one measured change at a time.

## Goldens in a consumer repo

```ts
// goldens/suites.ts
import type { GoldenSuite } from "@buritica/rootstock/golden";
import { chunkText } from "../src/chunk.ts";
import fixture from "./fixtures/chunk/basic.json";

export const suites: GoldenSuite[] = [
  {
    capability: "chunk.split",
    profile: "myrepo-v1",
    cases: [{ id: "basic", input: fixture, run: () => chunkText(fixture.text) }],
  },
];
```

```ts
// goldens/capture.ts — `bun goldens/capture.ts capture|check`
import { runGoldenCli } from "@buritica/rootstock/golden";
import { suites } from "./suites.ts";

process.exit(await runGoldenCli(suites, { dir: "goldens/data", repo: "myrepo" }));
```

```ts
// goldens/goldens.test.ts
import { registerGoldenTests } from "@buritica/rootstock/golden/bun-test";
import { suites } from "./suites.ts";

registerGoldenTests(suites, { dir: "goldens/data" });
```

`capture` refuses to run when `src/` differs from the merge-base with
`origin/main`, so goldens always record the unmodified behavior.

## Rules

- Inject dependencies (SQL client, `fetch`, clock, logger). Modules never read
  `process.env` and never open their own connections.
- Test fixtures are synthetic. Consumer data never goes into this repo.
- The capability vocabulary in `src/golden/capabilities.ts` is shared by
  every consumer. Adding an id is a minor release; renaming or removing one
  is breaking.

## License

MIT
