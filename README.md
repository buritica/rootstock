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
`unpdf`); nothing else pulls them in. `serve` needs the MCP SDK server
(`@modelcontextprotocol/server >=2.4.0 <3`) and `zod ^4.5.4`; `serve/auth`
also needs `better-auth`, `@better-auth/mcp` and `@better-auth/cimd`, each
`>=1.7.17 <1.8`. All are optional peers, so the app's own copies are the ones
that load; `serve` itself never loads Better Auth. An optional peer that is
installed must still satisfy its range, even in an app that never imports
`serve`: a `better-auth` below 1.7.17 makes the package manager warn. `@better-auth/mcp` depends
on `@better-auth/oauth-provider ^1.7.17`, so that package and
`@better-auth/core` float with each lockfile: pin them in yours and name the
resolved versions when you bump.

Each capability is a subpath export:

```ts
import { runGoldenCli, type GoldenSuite } from "@buritica/rootstock/golden";
```

## Capabilities

| Subpath | Status | What it does |
|---|---|---|
| `golden` | v0.0.1 | Golden snapshots that prove a refactor or extraction changed nothing: canonical JSON, capture/check, a recording `fetch`, seeded vectors and throwaway Postgres |
| `golden/bun-test` | v0.0.1 | Registers golden suites as `bun test` cases |
| `retrieval` | v0.9.0 | Hybrid search pieces: `bm25Query` builds a top-K BM25 statement for a `lakebase_bm25` index (the `lakebase_text` Postgres extension), with an optional candidate `budget` (a `set local` run first, since the index caps candidates before SQL `limit`), and `reciprocalRankFusion` merges ranked lists whose scores are not comparable. The database needs the extension and a `lakebase_bm25` index built after the table is populated |
| `runner` | v0.15.0 | The pull runner (`runPull`: fetch outside the transaction, a batch transaction per batch with its cursor, quarantine, a quota breaker, a run record, a `beforeSettle` hook for work that needs the whole listing), plan mode (`planPull`) and the queue drain (`drainQueue`) |
| `serve` | v0.13.1 | An MCP server behind one `handle(req)`: `createMcpService` runs auth, Host/Origin checks, body limits, the refusal and serving buckets and a deadline in front of the SDK's entry, with every response byte that differs between servers named in a profile; one `registerTool` seam checks scopes, charges the per-tool buckets, concurrency groups and turn budget, and records every call; `installSeams` does the same for a stdio server; liveness, cached readiness probes and a draining shutdown; `serveSlice` for config |
| `serve/auth` | v0.12.0 | `defineAuth`: one Better Auth instance as an MCP OAuth resource server (JWT, the MCP and CIMD plugins, magic link or Google sign-in, listed redirects, its rate limiter always on), the routes `serve` mounts, `verify` for the MCP path and `assertStoreReady` for startup |
| `usage` | v0.14.0 | What a tool call cost and who made it: `postgresCallLog` batches call records into a table you name (rootstock's migration creates `rootstock.mcp_calls`) without ever delaying a call and prunes it to the slice's `callLog.retention` (0.14.0), `prometheusToolMetrics` counts handler calls, `createSpendCeiling` keeps a daily per-caller total (tokens or dollars) and refuses past it, `usageWiring` binds pricing (the `runs` price table) and error classes into `serve`; `usageSlice` for config |

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
- **Block mode (0.8.0).** `wait: { mode: "block" }` waits in
  `pg_advisory_lock` with `lock_timeout` set to what is left of the wait, and
  `client_connection_check_interval` set to `wait.block.checkIntervalMs`, then
  restores both before fencing. An abort ends the waiting session with
  `destroy()` (or `close()` when the session has none), so the server drops
  the waiter instead of granting it later; a grant that races the abort is
  unlocked at once and refused `ABANDONED`. The connection check works only
  on a Linux server: elsewhere the server refuses it, the lock waits without
  it and emits `lock.connection_check_unavailable` once per wait, and a
  waiter whose client vanished stays queued until `lock_timeout`. A
  role-level `statement_timeout` shorter than the wait ends the wait as an
  error, not `HELD`. A session wrapper that spreads a shipped session and
  overrides only `close` is skipped on abort: wrap `destroy` too. Block
  mode needs PostgreSQL 14 or later. On a server that refuses the connection
  check, `lock.connection_check_unavailable` fires on every block wait; that
  is expected there. An abort that lands while the session is still opening
  or setting up is honoured once that step returns (bounded by
  `probeStallSeconds`), not at once. Over Bun.SQL the abort is prompt only on
  Bun 1.4.4 or later: before that, `close({ timeout: 0 })` waits for the
  waiting statement, so an aborted wait refuses `ABANDONED` only when
  `lock_timeout` fires or the lock is granted (and then freed as the session
  closes). postgres.js is prompt on every supported Bun.
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
- **A contended ack leaves the row claimed.** `ack`, `fail` and
  `extendClaim` (0.8.0) wait at most `ackLockTimeoutMs` for the row; past
  that they emit `queue.ack_contended` and rethrow the 55P03. The row stays
  claimed and is reclaimed when the claim expires, with an attempt charged.
- **Present the claim.** `ack`, `fail` and `extendClaim` take the `claim`
  the row came back with from `claim`; a stale holder whose row was
  reclaimed matches nothing and gets `missing`. `extendClaim` answering
  `"changed"` means new work arrived since the claim: the claim is still
  extended (0.11.0), so keep going, and the ack releases the row for its
  next run instead of deleting it. `queue.claim_extended` carries
  `changed: boolean` (0.11.0). Every writer of the table must run rootstock
  0.8.0 or later, or new work never bumps the version and is not seen.
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

### Run record

- **`finish` never throws for the database.** It returns `{ written: true }`
  when its row settled, `why: "settled-elsewhere"` when a later run under the
  same lock already settled it as interrupted, and `why: "error"` (with the
  driver's `error`, and `runs.record_failed`) when the write failed. The work
  itself may have succeeded; only the record is lost, and the next run under
  the lock settles the row as interrupted. Alert on `runs.record_failed`.
- **Retries on a lost connection.** When the settle fails with a
  connection error (SQLSTATE class 08, 57P01–57P03, or a driver connection
  error with no SQLSTATE), `finish` retries it up to twice, each after
  `deps.sleep(1000)` (at once when no `sleep` is given). When a retry finds
  no running row, it reads the run's own row back: if the first attempt had
  committed before the connection dropped, the finish counts as written.
  Any other failure, or a third one, is the result: later calls return it
  and send nothing.
- **Events and results carry the raw driver error.** `runs.record_failed`
  and `finish`'s `error` are the driver's error, unchanged. Some drivers put
  the statement's parameters in it (the scope, the reason), and a check
  violation's detail can hold the whole row, so scrub it before shipping it
  somewhere that should not see run data.
- **Start the lock's keepalive for every run.** `startRun` does not start
  it. A running row whose fencing row has not beaten for
  `staleHeartbeatSeconds` reads `interrupted` in `verdictFor`, so a run
  without `lock.startKeepalive()` turns red once it outlives that bound. The
  config holds `staleHeartbeatSeconds` at no less than 6 × the lock's
  `probeStallSeconds` + `endTimeoutSeconds` + 1 + 2 × `heartbeatSeconds` (426
  for 30 s beats, a 60 s stall and a 5 s end timeout), so a run that survives
  a stalled-probe recovery never reads red; the age is read on the database's
  clock. `runs.lockTable` defaults to the lock slice's table.
- **Gate at least once every `staleHeartbeatSeconds` in a long phase.** The
  keepalive never recovers: after a stalled probe or a lost session it beats
  nothing until the next `ensureExclusive()` recovers the lock, so a
  phase that never calls it reads `interrupted` once it outlives the bound.
  Calling it per batch is enough.
- **Two kinds of `interrupted`.** `verdictFor` reads `interrupted` both for a
  settled `interrupted` row and for a row still `running` whose heartbeat
  went stale (its `at` is the last beat). Looking for the second with
  `status = 'interrupted'` finds nothing: look at the job's `running` rows.
  A running row whose fencing row was taken by something that never calls
  `startRun` has no heartbeat to judge and is not counted; only the next
  `startRun` under that lock settles it.
- **A refused run records no buckets.** `finish("refused")` writes NULL
  buckets and `reconciled` even after `account()`; counters, tokens and cost
  are still recorded.

### Pull runner and drain

`@buritica/rootstock/runner` (0.11.0) runs a pull source and drains a queue.

- **`runPull` fetches outside any transaction.** Per batch it reads what is
  stored (`existing`), fetches what changed at most `fetchConcurrency` at a
  time, then opens one transaction for the batch's loads, quarantine rows,
  resolves and cursor. A fetch can take minutes without holding a backend
  idle in a transaction.
- **A killed run converges.** The cursor moves with the batch that covers
  it, so a run killed mid-batch leaves that batch uncommitted and the next
  run lists it again. That needs `list(cursorOf(r))` to return every ref
  after `r`: when refs can share a cursor across a batch boundary, `list`
  must be inclusive (equal cursors come back, already-stored ones are
  skipped as unchanged).
- **The lock is the caller's.** Acquire it, start its keepalive, and release
  it after `runPull` returns. The runner gates it before each batch, before
  each fetch, after the fetch pass, before each doc's writes and as the
  batch transaction's last step. A refusal settles `failed` (`lost-lock`)
  with the totals committed so far; inside the transaction it also rolls
  the batch back.
- **A quota trip stops after the ref that tripped it.** With `quota`, a doc
  counts one hit when its load throws what `isQuota` recognises, or when its
  `tryRepoint` or `load` called `ctx.quotaHit()` (even if the load then threw
  something else, or the doc turned out unchanged). A load that resolves
  without calling it clears the count; other throws leave it. At the
  breaker's limit the batch commits through that ref, the cursor lands on
  it, and the run settles `failed` (`quota`), even when that ref was the
  listing's last. Nothing already paid for is rolled back.
- **Work that needs the listing to be over goes in `beforeSettle`.**
  Retracting what a source no longer lists can only run once the listing is
  done. `beforeSettle(ctx)` runs once, after every batch committed and the
  buckets balance, with the lock gated just before and the row still
  `running`. `await ctx.override(flag)` (a brake the operator lifted) writes
  the flag to the running row at once (`Run.recordOverride`), so a run killed
  mid-hook still shows it once settled `interrupted`: call it before the act
  the flag allows, and do not act if it rejects (the row is no longer
  running). `ctx.count(name, n)` and `ctx.meter(...)` land on the row when it
  settles (`counts`, `tokens`); unlike a load's context, a bad call throws,
  and so does a count of the runner's own `fetched` or `repointed`.
- **The hook is not called on a failed run.** It is called on an empty
  listing, and on an incremental run whose listing started from a cursor:
  `ctx.backfill` flags a window, but only the source knows whether any other
  listing covered everything, so a hook that removes what was not listed
  checks that itself.
- **The hook fences its own writes.** The gate before it does not cover
  them: call `ctx.ensureExclusive()` inside the hook's transaction, just
  before it commits. A refusal settles the run `lost-lock`, even when the
  hook caught it or never awaited it; any other throw settles it
  `before-settle` and is not rethrown. Either way the row's `phase` is
  `before-settle`, and `runner.before_settle_started`/`_finished` (outcome,
  ms, the hook's error) bracket the hook. The hook bounds its own time (one
  that never resolves keeps the row running and the lock held), and the
  context refuses calls after the hook returns.
- **Meter from the load.** `ctx.meter` and `ctx.count` forward to the run
  at once. A refusal from `runs` emits `runner.settle_refused` and never
  fails the load. They are not undone when the batch rolls back.
- **`quarantined` counts duplicates too.** A repeat of an id already
  processed in the run counts as quarantined without a quarantine row, so
  the report's `quarantined` can exceed the rows written to the table.
- **A commit that may have landed reads as a rollback.** If the connection
  drops after COMMIT is sent, the runner reports `runner.batch_rolled_back`
  and leaves the batch out of the totals; the next run lists from the stored
  cursor and skips what did land as unchanged.
- **Fold long exclusion lists.** Each `excluded` reason becomes a key of the
  run's `excludedReasons`, so a source with many reasons folds them before
  returning the listing. An empty reason, or one with a NUL, fails the run
  as a `list` failure.
- **Events inside a batch can describe a rollback.** `runs.quarantined`,
  `runs.resolved` and `queue.cursor_written` fire inside the batch
  transaction; when the batch rolls back, `runner.batch_rolled_back` follows.
- **Keep slow calls out of `load`.** `load` runs inside the batch
  transaction, one doc at a time, so a model call there holds the backend
  idle in the transaction for as long as the batch's loads take. Do slow
  work in `fetch` where you can, and size `batchSize` to what the loads
  cost. Fetch errors never count toward the quota breaker: a source's
  `fetch` handles its own API's limits.
- **A killed run's row has no totals.** The buckets, counters and tokens
  reach the row only when the run settles. A run killed after some batches
  committed reads `interrupted` with no buckets and no cost, though its
  rows, quarantine entries (tagged with its `runId`) and paid calls landed.
- **Check `recorded` before trusting the row.** `runner.pull_finished`
  carries `recorded: false` (and the report `finish.written: false`) when
  the settle could not write the run row.
- **`planPull` writes nothing.** It lists, fetches and classifies each ref
  as the run would, batch by batch, and stops before load. A source with
  `planLoad` gets the docs that would load inside a READ ONLY transaction,
  opened after the batch's fetches, that always rolls back. `maxRefs` plans
  only the first refs (`truncated: true`); `cursor.wouldStore` is then the
  cursor after the planned refs, not what a full run would store.
- **`drainQueue` holds one lock per source.** It takes each source's lock
  without waiting (a refusal `isHeld` recognises skips the source; any other
  propagates), claims a batch, and acks or fails each row, with one archival
  cap across the whole drain, a contention brake, an interrupt and a fatal
  stop. Rows left after a cap, an interrupt or a fatal error are failed with
  your `heldClass` text and an attempt charged. Rows left after a jam, and a
  row whose ack or fail was contended, stay claimed until the claim expires
  (`leftClaimed` counts them). A throw from `record.start` ends the source
  as a `queue` failure, its claimed rows likewise left claimed. A lock
  whose teardown throws emits `drain.release_failed` and pages.
  Failing a held row charges it an attempt and its backoff, as a reclaim
  would, so a stop near `maxAttempts` can dead-letter rows no handler saw.
- **A killed drain's record is settled by the next drain that claims rows.**
  `record.start` runs only after a claim returned rows, so an empty drain
  leaves an earlier `running` row as it was.

## Serving an MCP server

`@buritica/rootstock/serve`, `serve/auth` and `usage` (0.12.0) build an MCP
server over HTTP from parts an app wires together. Every tool, host and
address below is made up.

```ts
import { SQL } from "bun";
import {
  createMcpService,
  dbProbe,
  defineToolScopes,
  liveness,
  readiness,
  SERVE_HARDENING,
  type ServeProfile,
  type Limits,
  type ServeSlice,
} from "@buritica/rootstock/serve";
import { checkAuthSecret, defineAuth } from "@buritica/rootstock/serve/auth";
import { postgresCallLog, type UsageSlice, usageWiring } from "@buritica/rootstock/usage";
import * as z from "zod/v4";

declare const sql: SQL; // the app's own client
declare const authPool: unknown; // the pg Pool (or drizzleAdapter) Better Auth reads
declare const PROFILE: ServeProfile; // every request-handling choice, spelled out
declare const s: ServeSlice; // config.serve: the numbers the config golden prints
declare const usage: UsageSlice & { callLog: NonNullable<UsageSlice["callLog"]> }; // config.usage
declare const withBusyText: (g: ServeSlice["limits"]["concurrency"]) => Limits["concurrency"];
declare const withExhaustedText: (t: ServeSlice["limits"]["turnBudget"]) => Limits["turnBudget"];
declare const sendMail: (to: string, url: string) => Promise<void>;
declare const loginPage: () => string;
declare const consentPage: (query: string) => string;

const clock = { now: () => Date.now(), monotonic: () => performance.now() };
const timers = {
  set: (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};
const log = (event: string, fields: Readonly<Record<string, unknown>>) =>
  console.log(JSON.stringify({ event, ...fields }));

const toolScopes = defineToolScopes({
  id: "notes",
  tools: { echo: "mcp:tools" },
  implies: { "mcp:tools": ["mcp:tools"] },
});

const auth = defineAuth({
  baseURL: "https://notes.example.test",
  baseUrlRule: "as-is",
  secret: checkAuthSecret(process.env.AUTH_SECRET),
  database: authPool,
  signIn: {
    kind: "magicLink",
    allow: { kind: "invited" },
    send: sendMail,
    sendLimit: { max: 1, windowMs: 60_000, releaseOnFailure: true },
  },
  registration: { dcr: false },
  clientPrivileges: "unset",
  redirects: { kind: "listed", hosts: ["client.example.test"], loopback: "if-listed" },
  extraScopes: [],
  rateLimit: { window: 60, max: 100, rules: {} },
  ipAddressHeaders: ["cf-connecting-ip"],
  pages: { login: loginPage, consent: consentPage },
  pageHeaders: {},
  authHeaders: {},
  assets: {},
  clock,
  timers,
  log,
});
await auth.assertStoreReady();

// The numbers come from the slice (see "Config prints the numbers" below);
// the wording (`busy`, `exhausted`) stays here. Build `limits` once per
// process: limiter state is keyed on this object.
const profile: ServeProfile = {
  ...PROFILE,
  id: s.id,
  bodyLimit: s.bodyLimit,
  deadlineMs: s.deadlineMs,
  shutdown: s.shutdown,
};
const limits = {
  ...s.limits,
  concurrency: withBusyText(s.limits.concurrency),
  turnBudget: withExhaustedText(s.limits.turnBudget),
};

const callLog = postgresCallLog({
  sql,
  table: usage.callLog.table,
  maxBuffered: usage.callLog.maxBuffered,
  maxBatch: usage.callLog.maxBatch,
  retention: usage.callLog.retention, // null keeps every row
  clock,
  log,
});

const service = createMcpService({
  profile,
  serverInfo: { name: "notes", version: "1.0.0" },
  registerTools(server) {
    server.registerTool(
      "echo",
      { description: "Echo the text back", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
  },
  auth,
  toolScopes,
  limits,
  usage: usageWiring({
    sinks: [callLog],
    keepArgs: true,
    keepOutput: false,
    prices: null,
    spend: null,
    serverSha: process.env.GIT_SHA ?? null,
  }),
  hooks: {},
  clock,
  timers,
  randomId: () => crypto.randomUUID(),
  log,
});

const health = liveness({ fields: { status: "ok" }, headers: {} });
const ready = readiness({
  sha: process.env.GIT_SHA ?? null,
  db: dbProbe(sql),
  probes: {},
  headers: { "content-type": "application/json" },
  timing: s.probes,
  clock,
  timers,
  log,
});

const server = Bun.serve({
  ...SERVE_HARDENING,
  idleTimeout: s.idleTimeout ?? SERVE_HARDENING.idleTimeout,
  async fetch(req, srv) {
    // HTTP/1.0 with no (or a bad) Host leaves a bare path in req.url: URL.parse
    // answers null and handle refuses it, so such a probe gets no /health either.
    const pathname = URL.parse(req.url)?.pathname;
    if (pathname === "/health") return health();
    if (pathname === "/ready") return ready();
    const res = await service.handle(req, { remoteAddress: srv.requestIP(req)?.address });
    return res ?? new Response("Not Found", { status: 404 });
  },
});

process.on("SIGTERM", async () => {
  await service.shutdown({
    signal: "SIGTERM",
    server: { stop: (force) => server.stop(force), pending: () => server.pendingRequests },
    endPool: (s) => sql.close({ timeout: s }),
  });
  process.exit(0);
});
```

- **The profile is the behavior.** `ServeProfile` spells out every choice
  that differs between servers: the SDK entry (JSON transport or the
  stateless handler), which non-POST methods authenticate first, body
  limits per caller kind, the deadline, Host/Origin rules and each refusal's
  exact bytes. Every field is required; nothing defaults.
- **A tool's throw can stay on the server.** `toolThrow: "generic"` answers
  a handler's throw with `{"error":"<tool> failed"}` (`isError: true`), so a
  database driver's message (SQL, parameters) never reaches the client;
  `"message"` sends the error's message, as the SDK does. Either way the
  call record keeps the thrown error's message (and its class, as
  classified) for your sinks; with none, `serve.tool_threw` {tool,
  errorClass, message} logs it. Never rewritten: a result the handler
  returns, rootstock's own refusals (the spend ceiling's included), the
  SDK's output-validation error, and a `ProtocolError` the handler throws,
  whose message reaches the client as written (including one a proxy tool
  rethrows from an upstream MCP server). An `aroundCall` hook
  sees the result the client gets. Added in 0.13.0 (required).
- **A request with no usable URL is refused, not a 500.** Bun hands `fetch`
  a bare path when it cannot build an absolute URL: HTTP/1.0 with no Host,
  or a Host that does not parse (HTTP/1.1 without Host gets Bun's own 400).
  With a `hostCheck` it gets that check's refusal on every path and face,
  before any method answer (the 404 text, or the SDK's 403 for that Host,
  "Missing Host header" when there is none), and
  a throttled `serve.host_refused` (reason `unroutable`); without one, the profile's 404 with the
  refusal bucket charged, even under `passUnknown`. Parse `req.url` in your
  own `fetch` with `URL.parse`, never `new URL`, for the same reason.
- **Limits are per process.** Buckets, concurrency groups and turn budgets
  live in memory: N instances allow N times the rate. Build the `Limits`
  object once; a fresh object per request starts every bucket full.
- **Body limits sit under the listener's.** A `bodyLimit` above the
  listener's `maxRequestBodySize` is never reached (Bun refuses first), and
  null means the listener's cap is the only one.
- **A deadline needs the JSON transport.** `deadlineMs` with
  `entry.kind: "handler"` is refused at `createMcpService`; set it to null
  there.
- **No `serve.started` line, no request id.** The service logs no start
  line and `serve.request` carries no request id, because either would move
  a consumer's existing log goldens. `hooks.requestFields` adds fields of
  your own.
- **`handle` answers `null` for a path it does not own** when the profile
  sets `passUnknown`; otherwise it answers the profile's 404. Mount
  `liveness` and `readiness` on your own routes, before `handle`.
- **Every tool goes through one seam.** `registerTools` gets an `McpServer`
  whose `registerTool` checks the caller's scopes against `toolScopes`,
  charges the per-tool bucket, concurrency group and turn budget, and hands
  each call a `currentCall()` handle (`setResultIds`, `meter`,
  `assertWithinSpend`) whose record reaches every sink once the call ends.
  A stdio server builds its own `McpServer` and calls `installSeams`.
- **Auth routes are served for you.** With `auth`, the profile's
  `authPrefixes` (the well-known metadata and Better Auth's API, `/jwks`
  unmetered), `/login`, `/consent` and the assets go to the auth layer, and
  `profile.mcpPath` runs `auth.verify`. `credentials` admits static bearer
  tokens ahead of OAuth. A `node:http` server that serves Better Auth itself
  (`toNodeHandler(auth.instance)`) wraps each response with
  `auth.wrapNodeAuthResponse` to get the same headers and 429 log. Better
  Auth's tables are the app's to migrate; `assertStoreReady` refuses to
  start on a store without them.
- **The call log never slows a call.** `postgresCallLog` writes in batches
  from one background writer; a full buffer drops and counts
  (`usage.call_log_dropped`).
- **The call log prunes itself.** Pass the usage slice's
  `callLog.retention` and a `clock` to `postgresCallLog`: with
  `{ keepDays }` the same writer deletes rows older than that, a pass an
  hour, 1,000 rows a step and at most 20 steps a pass. Between two steps it
  writes every row buffered during the first, so a pass costs inserts one
  delete's wait and traffic cannot starve the pass; a burst larger than
  `maxBuffered` during one delete still drops. A pass that stops at the cap
  with rows left makes the next one due a minute later, so turning retention
  on over a large table works the backlog off a pass a minute, never back
  to back (watch autovacuum that first day: freed space is reused, not
  returned to the OS). Processes pruning one table skip each other's locked
  rows. `idle()` drops a pending pass after its step in flight, so shutdown
  waits for one delete at most. `usage.call_log_pruned` {deleted, keepDays,
  steps, ms, more, stopped} logs each pass that deleted rows and the sink's
  first pass always, so a deploy shows retention is wired;
  `usage.call_log_prune_failed` {keepDays, deleted, steps, errorClass,
  failedPasses} logs a refused step, and the next pass waits the hour.
  Put `pruned()` and `pruneFailures()` on your metrics beside `dropped()`
  and `failedBatches()`. A table you name needs a unique `id` and an index
  on `created_at`, or every step scans it. Added in 0.14.0 (required,
  breaking): set `callLog.retention` in the usage slice (`null` keeps
  0.13's behavior, every row) and pass `retention` (plus `clock` when it is
  not null) to `postgresCallLog`; a printed config gains
  `usage.callLog.retention`.
- **Alert on the table, not the process.** `callLogRetentionStatus({ sql,
  table, retention })` reads both ends of `created_at` by the database clock
  and says `overdue` once the oldest row was more than `keepDays` plus
  `RETENTION_SLACK_DAYS` (2, or `slackDays`) old when the newest row over an
  hour old was written. That lag sees every way pruning stops while rows
  still land (refused
  deletes, retention not wired, a sink that never prunes), where a process's
  counters see only their own failures, and a quiet week (no calls, so no
  pass) does not trip it, nor does the first call after one (its row
  waits an hour before it counts, and its pass runs first). A first backlog
  bigger than one pass reads overdue until it clears. When inserts fail
  too the lag freezes; alert on `_failed_batches_total` for that. `renderCallLogMetrics({ prefix, table, counts:
  sink, status })` renders the sink's four counters
  (`<prefix>_call_log_dropped_total`, `_failed_batches_total`,
  `_prune_failures_total`, `_pruned_rows_total`) and, with a status,
  `<prefix>_call_log_retention_overdue` (0 or 1),
  `_retention_lag_seconds`, `_oldest_row_age_seconds` and `_keep_seconds`.
  Alert on `retention_overdue == 1`, so the slack lives in one place. Read
  the status on every scrape beside the counters, not in a cached body; on a
  database error render with `status: null`, so the counters stay, and
  pair the rule with `absent(..._retention_overdue)`. A consumer without
  Prometheus runs the status from a scheduled check instead. Added in
  0.16.0. Both
  rootstock migrations (`mcp_calls`,
  `spend`) are additive and run with rootstock's own (`applyRootstockMigrations`
  or `migrateCli`).
- **The spend ceiling is checked only where you ask.** `createSpendCeiling`
  charges what each call meters; a tool calls `assertWithinSpend()` before
  it spends, and nothing else is ever refused. Two concurrent calls of one
  caller can both pass the check.
- **Shutdown drains, forces, then flushes.** `shutdown` stops the listener
  and waits up to `drainMs` for requests, then force-closes what is left
  (`server.stop(true)` and the SDK entry, each within `forceMs`), then waits
  up to `flushMs` for every sink's `idle()`, the spend charger's `idle()`
  (its writes in flight) and the auth layer's pending sends, then closes the pool within `poolEndTimeoutS`.
- **Config prints the numbers.** `defineRootstockConfig` takes `serve`
  (`serveSlice`: body limits, deadline, idle timeout, shutdown, limits and
  probe timing) and `usage` (`usageSlice`). They print in the config golden
  only when given, and bring built-in invariants: `serve-deadline-idle`
  (when both a deadline and an idle timeout are set), `serve-probe-timeout`,
  and `usage-spend-prices` (for a ceiling in dollars). The slices hold numbers
  only. `createMcpService` never reads a config: the app hands the slice's
  values to it, and nothing checks that the profile and limits it passes
  match the slice it printed. Pass them from the slice, not beside it:

  ```ts
  const s = config.serve!; // the slice your config golden prints
  const profile = { ...PROFILE, id: s.id, bodyLimit: s.bodyLimit, deadlineMs: s.deadlineMs, shutdown: s.shutdown };
  const limits = { ...s.limits, concurrency: withBusyText(s.limits.concurrency), turnBudget: withExhaustedText(s.limits.turnBudget) };
  Bun.serve({ ...SERVE_HARDENING, idleTimeout: s.idleTimeout ?? SERVE_HARDENING.idleTimeout, fetch });
  readiness({ ...rest, timing: s.probes });
  ```
  `withBusyText` and `withExhaustedText` stand for your own wording (`busy`,
  `exhausted`), which the slice does not hold. The slice refuses
  some values the runtime would take but that never work (a fractional
  bucket capacity, a probe timeout under 1 ms).

## Rules

- Inject dependencies (SQL client, `fetch`, clock, logger). Modules never read
  `process.env` and never open their own connections.
- Test fixtures are synthetic. Consumer data never goes into this repo.
- The capability vocabulary in `src/golden/capabilities.ts` is shared by
  every consumer. Adding an id is additive (a patch release while on 0.x);
  renaming or removing one is breaking.

## License

MIT
