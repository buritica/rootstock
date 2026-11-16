// Host and Origin checks (contract §3.4). "hostname" matching is the SDK's
// Web-standard validators (port-agnostic hostnames, their 403 bytes);
// "exact" compares the raw header values.

import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { notFound } from "./bodies.ts";
import { configError } from "./errors.ts";
import type { ServeProfile } from "./types.ts";

type HostCheck = Exclude<ServeProfile["hostCheck"], false>;

/** A request → its refusal, or undefined to proceed. */
export type HostGuard = (req: Request) => Response | undefined;

export function hostGuard(hc: HostCheck): HostGuard {
  if (hc.hosts.match === "exact" && hc.refusal === "sdk-403") {
    throw configError(
      "createMcpService",
      'hostCheck.refusal "sdk-403" carries the SDK\'s hostname texts, so it needs hosts.match "hostname"',
    );
  }
  const loopback = localhostAllowedHostnames();
  // null: no host check at all. Built once; the SDK validators take a mutable array.
  const hosts: string[] | null =
    hc.hosts.list.length === 0
      ? hc.hosts.whenEmpty === "allow-all"
        ? null
        : [...loopback]
      : hc.hosts.loopback === "union"
        ? [...new Set([...loopback, ...hc.hosts.list])]
        : [...hc.hosts.list];
  const origins: string[] | null =
    hc.origins.list.length > 0
      ? [...hc.origins.list]
      : hc.origins.whenEmpty === "allow-all"
        ? null
        : hosts;

  if (hc.hosts.match === "hostname") {
    const refuse = (sdk: Response): Response =>
      hc.refusal === "sdk-403" ? sdk : notFound("text-not-found");
    return (req) => {
      const h = hosts === null ? undefined : hostHeaderValidationResponse(req, hosts);
      if (h) return refuse(h);
      const o = origins === null ? undefined : originValidationResponse(req, origins);
      return o ? refuse(o) : undefined;
    };
  }
  // Exact matching always refuses with "404-text" (sdk-403 is refused above).
  return (req) => {
    const host = req.headers.get("host");
    if (hosts !== null && (host === null || !hosts.includes(host)))
      return notFound("text-not-found");
    const origin = req.headers.get("origin");
    if (origin !== null && origins !== null && !origins.includes(origin)) {
      return notFound("text-not-found");
    }
    return undefined;
  };
}
