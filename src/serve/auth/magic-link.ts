// The `sendMagicLink` callback. Better Auth's `disableSignUp` stops only the
// verify step from creating a user: it still asks for a link for any address,
// so this callback decides who is mailed. The caller gets the same 200 either
// way, and the send runs on a timer after the response, so the sender's own
// work (synchronous or not) never shows in the response time.
//
// Known timing leak, accepted: under an owner allowlist a non-owner is
// answered before the user lookup (the contract's order, as served today), so
// an owner's address costs one store round trip more than any other address.
// That says which addresses are owners; it does not say which have accounts.

import type { Clock, LogEvent, Timers } from "../types.ts";
import type { MagicLinkSignIn } from "./types.ts";

/** The part of Better Auth's endpoint context the callback reads. */
export interface MagicLinkContext {
  context: { internalAdapter: { findUserByEmail(email: string): Promise<unknown> } };
}

const SWEEP_AT = 1_000;

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
  deps: { clock: Clock; timers: Timers; log: LogEvent },
): (data: { email: string; url: string }, ctx?: MagicLinkContext | null) => Promise<void> {
  // The detached send path has no caller to throw to, so its log is guarded here.
  const logDetached = (event: string, fields: Readonly<Record<string, unknown>>) => {
    try {
      deps.log(event, fields);
    } catch {
      // Dropped: nothing may escape a timer callback.
    }
  };
  const { max, windowMs, releaseOnFailure } = signIn.sendLimit;
  // Send times per address, oldest first. Only known addresses enter, so the
  // map is bounded by the account count; a sweep still runs past SWEEP_AT.
  const sends = new Map<string, number[]>();

  // The address's live send times, expired ones dropped from the front.
  const live = (key: string, t: number): number[] => {
    const times = sends.get(key) ?? [];
    let expired = 0;
    while (expired < times.length && t - (times[expired] ?? t) >= windowMs) expired++;
    if (expired > 0) times.splice(0, expired);
    return times;
  };
  const sweep = (t: number) => {
    for (const key of [...sends.keys()]) if (live(key, t).length === 0) sends.delete(key);
  };
  const release = (key: string, t: number) => {
    const times = sends.get(key);
    const at = times?.indexOf(t) ?? -1;
    if (times === undefined || at < 0) return;
    times.splice(at, 1);
    if (times.length === 0) sends.delete(key);
  };

  return async ({ email, url }, ctx) => {
    const key = email.trim().toLowerCase();
    if (owners !== null && !owners.has(key)) {
      deps.log("auth.magic_link_refused", { reason: owners.size === 0 ? "no-owner" : "not-owner" });
      return;
    }
    if (!ctx) {
      // Better Auth always passes its endpoint context; without it no address can be checked.
      deps.log("auth.magic_link_refused", { reason: "no-context" });
      return;
    }
    const found = await ctx.context.internalAdapter.findUserByEmail(email);
    if (!found) return;
    const t = deps.clock.now();
    if (sends.size > SWEEP_AT) sweep(t);
    const times = live(key, t);
    if (times.length >= max) {
      deps.log("auth.magic_link_suppressed", { userId: userIdOf(found) });
      return;
    }
    times.push(t);
    sends.set(key, times);
    const failed = (err: unknown) => {
      if (releaseOnFailure) release(key, t);
      logDetached("auth.magic_link_send_failed", { errorClass: errorClassOf(err) });
    };
    deps.timers.set(0, () => {
      try {
        signIn.send(email, url).then(undefined, failed);
      } catch (err) {
        failed(err);
      }
    });
  };
}
