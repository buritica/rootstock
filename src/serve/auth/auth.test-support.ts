// Shared fixtures for the serve/auth suites: three synthetic profile shapes
// (one per sign-in and base URL rule), an in-memory Better Auth store with
// every table the configured plugins declare, and a recording log.

import { memoryAdapter } from "better-auth/adapters/memory";
import { getAuthTables } from "better-auth/db";
import { defineAuth } from "./define-auth.ts";
import type { AuthLayer, AuthOptions } from "./types.ts";

// Generated for these tests; it signs nothing outside them.
export const SECRET = "k3Jd9sLq0Zp7Vb2Nc8Xw4Rt6Ym1Ha5Ue";
export const BASE = "https://app.example.test";
export const IP_HEADER = "cf-connecting-ip";

/** An address on the reserved test domain, built so no source line spells one out. */
export const address = (local: string): string => [local, "example.test"].join("@");

export const ANTI_FRAMING = Object.freeze({
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
});

export interface LogLine {
  event: string;
  fields: Readonly<Record<string, unknown>>;
}

export class ManualClock {
  t = 1_800_000_000_000;
  now = (): number => this.t;
  monotonic = (): number => this.t;
}

export type Shape = "owner" | "social" | "invited";

export interface Harness {
  layer: AuthLayer;
  db: Record<string, Record<string, unknown>[]>;
  logs: LogLine[];
  clock: ManualClock;
  sent: { email: string; url: string }[];
}

/** The options for one shape; `send` records into `sent`. */
export function shapeOptions(
  shape: Shape,
  deps: {
    db: Record<string, Record<string, unknown>[]>;
    logs: LogLine[];
    clock: ManualClock;
    send: (email: string, url: string) => Promise<void>;
  },
): AuthOptions {
  const common = {
    secret: SECRET,
    database: memoryAdapter(deps.db),
    extraScopes: [] as string[],
    ipAddressHeaders: [IP_HEADER],
    pages: {
      login: () => "<p>sign in</p>",
      consent: (query: string) => `<p>consent ${query.length}</p>`,
    },
    assets: {},
    clock: deps.clock,
    timers: {
      set: (ms: number, fn: () => void) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      },
    },
    log: (event: string, fields: Readonly<Record<string, unknown>>) => {
      deps.logs.push({ event, fields });
    },
  };
  switch (shape) {
    case "owner":
      return {
        ...common,
        baseURL: BASE,
        baseUrlRule: "origin-only",
        signIn: {
          kind: "magicLink",
          allow: { kind: "owner", emails: [address("Owner")] },
          send: deps.send,
          sendLimit: { max: 3, windowMs: 600_000, releaseOnFailure: false },
        },
        registration: { dcr: false },
        clientPrivileges: "unset",
        redirects: { kind: "listed", hosts: ["client.example.test"], loopback: "if-listed" },
        rateLimit: {
          window: 60,
          max: 100,
          rules: {
            "/sign-in/magic-link": { window: 600, max: 5 },
            "/oauth2/register": { window: 3600, max: 10 },
          },
        },
        pageHeaders: ANTI_FRAMING,
        authHeaders: ANTI_FRAMING,
      };
    case "social":
      return {
        ...common,
        baseURL: `${BASE}/`,
        baseUrlRule: "strip-trailing-slash",
        extraScopes: ["mcp:extra"],
        signIn: {
          kind: "social",
          provider: "google",
          clientId: "client-id",
          clientSecret: "client-secret-value",
          hd: "example.test",
        },
        registration: { dcr: false },
        clientPrivileges: "deny",
        redirects: { kind: "any" },
        rateLimit: {
          window: 60,
          max: 100,
          rules: {
            "/sign-in/social": { window: 60, max: 10 },
            "/callback/*": { window: 60, max: 30 },
            "/oauth2/token": { window: 60, max: 300 },
          },
        },
        pageHeaders: { "cache-control": "no-store" },
        authHeaders: {},
      };
    case "invited":
      return {
        ...common,
        baseURL: BASE,
        baseUrlRule: "as-is",
        signIn: {
          kind: "magicLink",
          allow: { kind: "invited" },
          send: deps.send,
          sendLimit: { max: 1, windowMs: 60_000, releaseOnFailure: true },
        },
        registration: { dcr: true },
        clientPrivileges: "unset",
        redirects: {
          kind: "listed",
          hosts: ["client.example.test", "127.0.0.1"],
          loopback: "if-listed",
        },
        rateLimit: {
          window: 60,
          max: 100,
          rules: {
            "/sign-in/magic-link": { window: 300, max: 20 },
            "/magic-link/verify": { window: 60, max: 30 },
            "/oauth2/register": { window: 3600, max: 20 },
            "/oauth2/token": { window: 60, max: 300 },
          },
        },
        pageHeaders: {},
        authHeaders: {},
        assets: {
          "/assets/face.woff2": {
            body: () => new Blob([new Uint8Array([1, 2, 3])]),
            headers: { "content-type": "font/woff2", "cache-control": "public, max-age=60" },
          },
        },
      };
  }
}

/** A layer over a fresh in-memory store holding every table its plugins declare. */
export function harness(
  shape: Shape,
  over: (o: AuthOptions) => AuthOptions = (o) => o,
  send?: (email: string, url: string) => Promise<void>,
): Harness {
  const db: Record<string, Record<string, unknown>[]> = {};
  const logs: LogLine[] = [];
  const clock = new ManualClock();
  const sent: { email: string; url: string }[] = [];
  const record = async (email: string, url: string) => {
    sent.push({ email, url });
  };
  const options = over(shapeOptions(shape, { db, logs, clock, send: send ?? record }));
  const layer = defineAuth(options);
  for (const table of Object.values(getAuthTables(layer.instance.options))) {
    db[table.modelName] ??= [];
  }
  return { layer, db, logs, clock, sent };
}

export const authRequest = (path: string, init: RequestInit = {}): Request =>
  new Request(`${BASE}/api/auth${path}`, init);

export const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  authRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
