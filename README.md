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

**Run record.** The `runs` subpath (0.8.0) adds two more tables, `runs` and
`quarantine`, owned by the migrating role like the others. When the writers
connect as another role, grant it `SELECT`, `INSERT`, `UPDATE`, `DELETE` on
`rootstock.runs` and `rootstock.quarantine` (or on your own quarantine table,
when you pass one). 0.8.0 also adds two columns to `work_queue`,
`version bigint NOT NULL DEFAULT 0` and `claim_token uuid`; a consumer that
passes its own queue table adds the same two columns, with the same types and
default, in its own additive migration applied before the 0.8.0 code serves.
Start that migration with `SET lock_timeout = '5s';`: the `ALTER TABLE` needs
an exclusive lock for a moment, and without a timeout it queues behind any
open reader of a busy queue table and stalls every queue statement behind it.
Existing table grants on `work_queue` cover the new columns. Altering
`work_queue` needs the migrating role to **own** it (creating tables needed
only `CREATE` on the schema): check `SELECT tableowner FROM pg_tables WHERE
schemaname = 'rootstock'` before the first 0.8.0 deploy. A role that only
reads run history (dashboards, freshness checks) needs `SELECT` on
`rootstock.runs`.

### Rolling back

Rolling a consumer back to 0.5.x after 0.6.0 migrated its database leaves
applied migrations that release has no files for: `migrate status` reads the
database as ahead (so a drift monitor pages) and `apply --manual` refuses
until the consumer is on 0.6.0 again. A deploy's `apply --deploy` still goes
through. Fix forward with a release, not by reverting the migrations.

The same holds for any pre-0.8 release after 0.8.0 migrated a database: three
files read as ahead, `apply --deploy` goes through, `status` and `apply
--manual` stay red until the consumer is on 0.8.x again. A pre-0.8 image
ignores the new tables and columns (a claim token it leaves on a released row
is overwritten by the next 0.8 claim). Once 0.8.0 migrated a database, fix
forward on 0.8.x only: an older line can never ship a migration there.

### Run lock

- **Use a direct endpoint.** The lock client must be a dedicated connection
  to a direct (non-pooled) Postgres endpoint. Through a transaction pooler,
  the advisory lock and its fencing row can land on backends other runs
  share, so a lock can be shared or stranded and the lock cannot tell.
- **Bounded waits.** Every statement the gate sends (the ownership probe and
  each recovery claim) is bounded by `probeStallSeconds`. A probe that does
  not answer in time (a silently dropped socket, a stalled server) spends one
  of `maxRecoveries`:
  1. The lock closes the stalled session (bounded by `endTimeoutSeconds` plus
     one second), opens a fresh one, emits `lock.session_replaced`, and
     claims there. The keepalive stands down until the recovery ends.
  2. If the claim reads the lock held and the fencing row still names this
     run, the holder is most likely the run's own stalled backend: a
     black-holed connection's backend lives as long as the server's TCP
     keepalive allows. The lock ends it with `pg_terminate_backend`, only
     while `pg_locks` shows that backend (the pid the run last held the lock
     on) holding this name while the fencing row still names this run, and
     emits `lock.stalled_backend_terminated`. The
     lock role needs the privilege to end its own backends, which a role has
     by default; without it the lock emits `lock.terminate_failed` and only
     waits. If `pg_locks` shows another backend holding it, the recovery
     refuses at once and that backend is left alone.
  3. The claim is retried every `wait.pollIntervalMs` (at least 100 ms, and
     even without `opts.wait`) for up to `probeStallSeconds` more.

  A recovery that fails or stalls makes the gate throw `UNVERIFIABLE`, and
  every later gate rethrows it; when the run's own backend outlived the poll,
  `lock.recovery_refused` carries its pid as `stalledPid`. A gate call can
  now block for up to about six `probeStallSeconds` plus `endTimeoutSeconds`
  (probe, close, a claim and its retry, the terminate, the poll window and
  its last claim); 0.6.0 refused after one. A waited acquire bounds its
  try-lock and fence by what is left of the wait (never less than
  `probeStallSeconds`) and by its signal. `release()` bounds its unlock by
  `endTimeoutSeconds` and frees the in-process turn before closing, so a
  close that hangs never holds the next waiter (the database lock does,
  until that session ends).
- **`open` must make a new client each call.** It runs once for the acquire
  and once more for each stalled-probe recovery, which closes the session it
  replaces. An `open` that wraps one shared client makes that recovery claim
  on a closed client, and the gate refuses `UNVERIFIABLE`.
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
