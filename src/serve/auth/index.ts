// `serve/auth`: Better Auth for an MCP service. Its shared types live in
// `../types.ts` (re-exported from `serve`).
export { checkAuthSecret } from "./config.ts";
export { defineAuth } from "./define-auth.ts";
export type {
  AuthLayer,
  AuthOptions,
  BetterAuthInstance,
  MagicLinkSignIn,
  NodeAuthResponse,
  RateLimitRule,
  SocialSignIn,
} from "./types.ts";
