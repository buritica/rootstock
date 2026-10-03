# rootstock

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

## Commands

```
bun install
bun run lint
bun run typecheck
bun test
```

## Agents

Build agents run review/simplify passes inline, never spawn agents, never
wait on other agents, never merge, never push to main. If blocked, return the
blocker.
