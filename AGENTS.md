# rootstock

This file is canonical for every agent host. `CLAUDE.md` is a one-line
`@AGENTS.md` import.

Shared TypeScript capabilities that mycel, compass and dian-tax-rag adopt.
The plan, phases and frozen contracts live in the brain vault at
`projects/rootstock/` (RFC + execution plan). Read the execution plan
before starting a wave.

## This repo is PUBLIC

- Never commit consumer data: no corpus text, no DB rows, no real queries,
  no people's names or emails, no internal hostnames or IPs, no prompts
  copied verbatim from a consumer. Fixtures are synthetic and written
  for the test at hand.
- Never commit secrets, tokens, or `.env` files.

## Code rules

- Bun-native TypeScript, no build step, exported through `package.json`
  `exports` subpaths. `import type` for type-only imports
  (`verbatimModuleSyntax`).
- Every dependency is injected: SQL client (the tagged-template subset that
  postgres.js and `Bun.SQL` share), `fetch`, clock, logger, randomness.
  No `process.env`, no `console` (biome enforces `noConsole`).
- Behavior that differs between consumers is a named **profile**, never a
  flag soup. Phase 1 profiles reproduce each consumer's current behavior
  byte-for-byte. The neutrality proof is the consumer repo's own goldens,
  so a profile is not done until a consumer PR shows its goldens unchanged.
- Peer dependencies for anything a consumer also loads (better-auth, ai,
  zod, MCP SDK) so there is exactly one copy at runtime.

## Releases

Tag `vX.Y.Z` on main; consumers pin tags. While on 0.x, a breaking change
bumps the minor version and says so in the tag message.

## Agents

Build agents run review/simplify passes inline, never spawn agents, never
wait on other agents, never merge, never push to main. If blocked, return the
blocker.

<!-- sdlc:begin -->
<!-- rendered by sdlc 4.13.0 from templates/agents-sdlc.md; `agents_md.py --check` reports drift -->
## SDLC

Managed by `/sdlc:init` between the `sdlc:begin`/`sdlc:end` markers — re-running init updates this block and nothing else. Repo rules go outside the markers, in this file. `CLAUDE.md` includes this file via `@AGENTS.md`; hosts that read `AGENTS.md` directly (Codex, Gemini, Cursor, Copilot) get the same contract.

### Lifecycle
- `/sdlc:plan` before any code. It opens a worktree off `origin/main` — never work on `main` — on a `<prefix>/short-name` branch (`feature/`, `fix/`, `chore/`, `docs/`) and writes `.claude/sdlc/<branch>/plan.md`.
- `/sdlc:spec` only when there are open product decisions. Skip for a bug fix.
- `/sdlc:gate` before every PR. Gates run in order; fix failures before advancing; a code change after the chain completes resets it.
- `/sdlc:ship` pushes, opens the PR, and squash-merges once CI is green.

### Gates
- Tiers: **tiny** (≤3 lines, no behavior change), **small-medium** (any code change — the default), **significant** (new behavior, new integration, >3 files or >200 lines). A docs-only diff (no executable files) uses the `tiny` cycle; its tests/lint/typecheck gates are vacuously satisfied — say that you classified it docs-only.
- The `sdlc` hook arms a small-medium cycle on the first commit to a branch and blocks `gh pr create` until every gate is recorded. For docs-only or trivial changes run `/sdlc:gate --init tiny` **before** the first commit.
- Gates 2–6 are `/grumpy:simplify`, then `/grumpy:review` → `/grumpy:fix` → `/grumpy:imagine` → `/grumpy:fix`. Run the skills; reviewing the diff in your head records nothing.
- Never record a gate you did not run. Gates 2–6 can only be stamped by their skills.

### Commands
- test: `bun test`
- lint: `bun run lint`
- format: `bun run format`
- typecheck: `bun run typecheck`
- CI runs the same commands; `ci-pass` is the single required check on `main`.

### Pull requests
- Title: conventional-commit prefix (`feat`, `fix`, `chore`, `docs`, `refactor`) with a scope, under 70 characters.
- Body: `## Summary` and `## Verification`; `Closes #N` when an issue exists. (Consumer repos that run a post-merge confirmation window own that in their own `.claude/skills/sdlc/SKILL.md` overlay — generic sdlc does not mandate one.)
- Squash merge only. Never force-push `main`. Never bypass hooks (`--no-verify` and friends are forbidden; fix the failure or ask).

### Artifacts (gitignored)
- `.claude/sdlc/<branch>/` — plan and spec. `.claude/grumpy/<branch>/` — review, imagine, simplify reports.
- `.sharpen/data/` — gate state, shared across worktrees. `.sharpen/simplify.json` is the one committed file under `.sharpen/` (the simplify policy config), when present.
<!-- sdlc:end -->
