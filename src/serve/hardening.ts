// Listener settings and the client source key (contract §3.5). The consumer
// reads its own env and passes the raw strings in; nothing here reads one.

import { configError } from "./errors.ts";

/**
 * Safe `Bun.serve` defaults a consumer may spread: loopback only, a 2 MB body
 * cap, never the development error page, and an idle timeout that outlasts
 * a slow tool call.
 */
export const SERVE_HARDENING: {
  readonly maxRequestBodySize: 2_000_000;
  readonly development: false;
  readonly idleTimeout: 45;
  readonly hostname: "127.0.0.1";
} = Object.freeze({
  maxRequestBodySize: 2_000_000,
  development: false,
  idleTimeout: 45,
  hostname: "127.0.0.1",
});

export type Bind = "127.0.0.1" | "0.0.0.0";

/** The client-IP header assumed when none is configured on a loopback bind. */
const DEFAULT_CLIENT_IP_HEADER = "cf-connecting-ip";

/** Proxy-chain headers: refused as the client-IP header on a routable bind. */
export const CHAIN_SHAPED_HEADERS: ReadonlySet<string> = Object.freeze(
  new Set(["x-forwarded-for", "forwarded"]),
);

/**
 * The listener's bind: unset or empty is loopback; `0.0.0.0` binds every
 * interface (behind a platform edge); anything else is refused, so a typo
 * never binds somewhere nobody chose.
 */
export function resolveBind(raw: string | undefined): Bind {
  if (raw === undefined || raw === "" || raw === "127.0.0.1") return "127.0.0.1";
  if (raw === "0.0.0.0") return "0.0.0.0";
  throw configError(
    "resolveBind",
    "the bind must be unset or 127.0.0.1 (loopback), or 0.0.0.0 behind a platform edge",
    raw,
  );
}

/**
 * The header the edge in front of this process overwrites with the client's
 * address. Unset on loopback → `cf-connecting-ip`; unset on `0.0.0.0` is
 * refused (the choice depends on the edge, so it must be made explicitly); a
 * chain-shaped header on `0.0.0.0` is refused (its rightmost entry is the
 * platform's own proxy, one bucket for every caller); a name that is not an
 * RFC 7230 token is refused (`Headers.get` would throw on every request).
 */
export function resolveClientIpHeader(raw: string | undefined, bind: Bind): string {
  if (raw === undefined) {
    if (bind === "0.0.0.0") {
      throw configError(
        "resolveClientIpHeader",
        "a 0.0.0.0 bind needs the client-IP header set explicitly: a single-value header the edge overwrites on every request (cf-connecting-ip behind Cloudflare, true-client-ip or x-real-ip elsewhere)",
      );
    }
    return DEFAULT_CLIENT_IP_HEADER;
  }
  if (bind === "0.0.0.0" && CHAIN_SHAPED_HEADERS.has(raw.toLowerCase())) {
    throw configError(
      "resolveClientIpHeader",
      "a forwarding chain is not a client-IP header on a 0.0.0.0 bind: its rightmost entry is the platform's own proxy, so every caller would share one bucket; set a single-value header the edge overwrites",
      raw,
    );
  }
  if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(raw)) return raw;
  throw configError(
    "resolveClientIpHeader",
    "the client-IP header must be an RFC 7230 token (letters, digits and !#$%&'*+-.^_`|~)",
    raw,
  );
}

/**
 * The limiter key for one request: the rightmost entry of `header` (the one
 * a single trusted edge appended), else the socket address, else "unknown";
 * at most 64 characters. `header` null reads the socket address only.
 */
export function sourceKeyFor(
  req: Request,
  info: { remoteAddress?: string },
  header: string | null,
): string {
  const chain = header === null ? undefined : req.headers.get(header)?.split(",");
  const forwarded = chain?.[chain.length - 1]?.trim();
  return (forwarded || info.remoteAddress || "unknown").slice(0, 64);
}
