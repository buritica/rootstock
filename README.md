# rootstock

Shared capabilities for Bun + Postgres knowledge systems: source adapters,
ingestion, chunking, embeddings, retrieval and versioned judgments. Several
systems graft onto one tested root.

Plain TypeScript with no build step. Bun runs the source directly.

## Install

Pin an exact version from npm:

```sh
bun add --exact @buritica/rootstock
```

The office-document extractor needs its optional peers (`jszip`, `mammoth`,
`unpdf`); nothing else pulls them in.

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

## Operating the run lock, work queue and cursors

The `lock` and `queue` subpaths (0.6.0) add three tables in the `rootstock`
schema: `run_locks`, `work_queue` and `cursors`. The notes below are what an
operator needs before turning them on.

### Grants

The migrations create the tables as the role that runs them. When the
application connects as a different role, grant it:

- `USAGE` on schema `rootstock`;
- `SELECT`, `INSERT`, `UPDATE` on `rootstock.run_locks`;
- `SELECT`, `INSERT`, `UPDATE`, `DELETE` on `rootstock.work_queue`;
- `SELECT`, `INSERT`, `UPDATE` on `rootstock.cursors`.

Without them the lock refuses `UNFENCED` (the fence cannot write its row) and
the queue and cursor calls fail with the driver's permission error.

### Rolling back

Rolling a consumer back to 0.5.x after 0.6.0 migrated its database leaves
applied migrations that release has no files for: `migrate status` reads the
database as ahead (so a drift monitor pages) and `apply --manual` refuses
until the consumer is on 0.6.0 again. A deploy's `apply --deploy` still goes
through. Fix forward with a release, not by reverting the migrations.

### Run lock

- **Use a direct endpoint.** The lock client must be a dedicated connection
  to a direct (non-pooled) Postgres endpoint. Through a transaction pooler,
  the advisory lock and its fencing row can land on backends other runs
  share, so a lock can be shared or stranded and the lock cannot tell.
- **Bounded waits.** Every statement the gate sends (the ownership probe and
  each recovery claim) is bounded by `probeStallSeconds`; one that does not
  answer in time makes the gate throw `UNVERIFIABLE`, and every later gate
  rethrows it. A waited acquire bounds its try-lock and fence by what is left
  of the wait (never less than `probeStallSeconds`) and by its signal.
  `release()` bounds its unlock by `endTimeoutSeconds` and frees the
  in-process turn before closing, so a close that hangs never holds the next
  waiter (the database lock does, until that session ends).
- **Events carry the raw driver error.** The `error` field of a lock event is
  the error the driver threw, unchanged. Some drivers put the server's
  `host:port` in its message, so scrub it before shipping events somewhere
  that should not see it.

### Work queue

- **Events mean the statement succeeded, not that it committed.** Called
  inside a caller's transaction, a queue call runs in a savepoint and emits
  its event when the statement returns. If the caller's transaction later
  rolls back, the event still fired for a change that never landed.
- **`"contended"` means retry.** `enqueue` returns `"contended"` when another
  writer held the row past `enqueueLockTimeoutMs`. Nothing was written, so
  the caller retries (or drops the event knowingly).
- **An enqueue on a dead key is parked.** When the key is dead-lettered, the
  enqueue coalesces into the dead row and reports `queue.enqueued` with
  `result: "on_dead"`. Nothing claims it until someone calls `retryDead`, so
  alert on that event.
- **Alert on a missing `queue.drained`.** Every `claim` call emits
  `queue.drained`, even when it claimed nothing. That event is the worker's
  liveness signal: its absence over a few drain intervals means the worker
  stopped.
- **Write cursors under the run lock.** `setCursor` has no compare-and-set:
  two writers race and the last one wins. Hold the run lock for the source
  whose cursor you advance.

## Rules

- Inject dependencies (SQL client, `fetch`, clock, logger). Modules never read
  `process.env` and never open their own connections.
- Test fixtures are synthetic. Consumer data never goes into this repo.
- The capability vocabulary in `src/golden/capabilities.ts` is shared by
  every consumer. Adding an id is additive (a patch release while on 0.x);
  renaming or removing one is breaking.

## License

MIT
