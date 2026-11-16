// The `sendMagicLink` callback. Better Auth's `disableSignUp` stops only the
// verify step from creating a user: it still asks for a link for any address,
// so this callback decides who is mailed. The caller gets the same 200 either
// way, and the send is never awaited, so neither the body nor the response
// time says whether an address has an account.

import type { Clock, LogEvent } from "../types.ts";
import type { MagicLinkSignIn } from "./types.ts";

/** The part of Better Auth's endpoint context the callback reads. */
export interface MagicLinkContext {
  context: { internalAdapter: { findUserByEmail(email: string): Promise<unknown> } };
}

function errorClassOf(err: unknown): string {
  if (!(err instanceof Error)) return "non-Error throw";
  return err.constructor?.name || err.name || "Error";
}

function userIdOf(found: unknown): string | null {
  const id = (found as { user?: { id?: unknown } } | null)?.user?.id;
  return typeof id === "string" ? id : null;
}

/**
 * Order: owner allowlist (in memory, before any lookup), then the user lookup,
 * then the per-address send limit, then the send. Logs never carry the address.
 */
export function createMagicLinkSender(
  signIn: MagicLinkSignIn,
  owners: ReadonlySet<string> | null,
  deps: { clock: Clock; log: LogEvent },
): (data: { email: string; url: string }, ctx?: MagicLinkContext | null) => Promise<void> {
  const { max, windowMs, releaseOnFailure } = signIn.sendLimit;
  const sends = new Map<string, number[]>();
  // defineAuth hands in a log that swallows its own throws.
  const emit = deps.log;

  // Drops expired send times, so the map holds only addresses sent to within one window.
  const prune = (t: number) => {
    for (const [key, times] of sends) {
      const live = times.filter((at) => t - at < windowMs);
      if (live.length === 0) sends.delete(key);
      else if (live.length !== times.length) sends.set(key, live);
    }
  };

  return async ({ email, url }, ctx) => {
    const key = email.trim().toLowerCase();
    if (owners !== null && !owners.has(key)) {
      emit("auth.magic_link_refused", { reason: owners.size === 0 ? "no-owner" : "not-owner" });
      return;
    }
    const found = await ctx?.context.internalAdapter.findUserByEmail(email);
    if (!found) return;
    const t = deps.clock.now();
    prune(t);
    const times = sends.get(key) ?? [];
    if (times.length >= max) {
      emit("auth.magic_link_suppressed", { userId: userIdOf(found) });
      return;
    }
    times.push(t);
    sends.set(key, times);
    // Deferred to a microtask so a send that throws synchronously still takes the catch below.
    Promise.resolve()
      .then(() => signIn.send(email, url))
      .catch((err: unknown) => {
        if (releaseOnFailure) {
          const current = sends.get(key);
          const at = current?.indexOf(t) ?? -1;
          if (current !== undefined && at >= 0) {
            current.splice(at, 1);
            if (current.length === 0) sends.delete(key);
          }
        }
        emit("auth.magic_link_send_failed", { errorClass: errorClassOf(err) });
      });
  };
}
