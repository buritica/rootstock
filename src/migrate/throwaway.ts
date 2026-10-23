import { isRecord, q } from "../internal/slice.ts";
import { fail } from "./errors.ts";

const CODE = "ERR_ROOTSTOCK_MIG_NOT_THROWAWAY";

const SOCKET_STANDIN = "rootstock-socket.invalid";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export interface ThrowawayOptions {
  /** Database names that are never a throwaway (compared case-insensitively). `[]` is allowed but explicit. */
  denyNames: readonly string[];
  /** Hosts a test may reach. Default: localhost, 127.0.0.1, ::1. A Unix socket always counts as local. */
  allowHosts?: readonly string[];
  /** Skips the refusal, and says so through `log` on every call. */
  unsafeAllow?: { reason: string; log: (msg: string) => void };
}

function refuse(host: string, db: string, why: string): never {
  fail(
    `refusing to touch ${q(host)}/${q(db)} — ${why}; tests run only against a throwaway local database`,
    CODE,
  );
}

function badOption(message: string): never {
  fail(`assertThrowawayDb: ${message}`, CODE);
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** A libpq host is a Unix socket when it is empty or an absolute path. */
const isSocket = (host: string): boolean => host === "" || host.startsWith("/");

/**
 * Refuses (E-MIG-NOT-THROWAWAY) unless `url` names a throwaway database: every
 * host it would connect to is in `allowHosts` or a Unix socket, and its
 * database name is not in `denyNames`. Reads the URL the way libpq does: a
 * `host`, `hostaddr` or `dbname` query parameter overrides the URL's own, an
 * empty database name defaults to the user's, and a comma-separated `host`
 * parameter is checked host by host. A URL that does not parse is refused,
 * which includes a host list in the authority (`h1:5432,h2:5432`): pass it as
 * `?host=h1,h2` instead. Pure: no I/O,
 * and no message ever carries the URL's password.
 */
export function assertThrowawayDb(url: string, opts: ThrowawayOptions): void {
  if (!isRecord(opts)) badOption(`options must be an object — got ${q(opts)}`);
  const { denyNames, allowHosts = LOCAL_HOSTS, unsafeAllow } = opts;
  for (const [field, list] of [
    ["denyNames", denyNames],
    ["allowHosts", allowHosts],
  ] as const) {
    if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) {
      badOption(`${field} must be an array of strings — got ${q(list)}`);
    }
  }
  if (unsafeAllow !== undefined) {
    if (
      !isRecord(unsafeAllow) ||
      typeof unsafeAllow.reason !== "string" ||
      unsafeAllow.reason.trim() === "" ||
      typeof unsafeAllow.log !== "function"
    ) {
      badOption("unsafeAllow needs a non-empty reason and a log function");
    }
  }

  const target = parse(url);
  if (unsafeAllow !== undefined) {
    unsafeAllow.log(
      `rootstock migrate: assertThrowawayDb skipped for ${q(target?.hosts.join(",") ?? "?")}/${q(target?.db ?? "?")} — ${unsafeAllow.reason}`,
    );
    return;
  }
  if (target === undefined)
    refuse("?", "?", "the URL is not a postgres:// or postgresql:// URL that parses");
  const { hosts, db } = target;
  const shown = hosts.join(",");
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()));
  const stray = hosts.find((h) => !isSocket(h) && !allowed.has(h.toLowerCase()));
  if (stray !== undefined) {
    refuse(shown, db, `host ${q(stray)} is not in allowHosts (${[...allowed].join(", ")})`);
  }
  const deny = new Set(denyNames.map((n) => n.toLowerCase()));
  if (deny.has(db.toLowerCase())) refuse(shown, db, `the database name ${q(db)} is in denyNames`);
}

function parse(url: string): { hosts: string[]; db: string } | undefined {
  if (typeof url !== "string") return undefined;
  // libpq accepts credentials before an empty host (`postgres://u@/db`, a
  // socket); WHATWG URL does not, so parse that shape with a reserved stand-in.
  const socketShape = /^(postgres(?:ql)?:\/\/[^/?#]*@)(?=[/?#]|$)/;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(socketShape, `$1${SOCKET_STANDIN}`));
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
  const params = parsed.searchParams;
  // libpq: hostaddr is where it connects, host names it; check both when given.
  const fromParams = [params.get("host"), params.get("hostaddr")].filter(
    (v): v is string => v !== null,
  );
  const urlHost = parsed.hostname === SOCKET_STANDIN ? "" : decode(parsed.hostname);
  const rawHosts = fromParams.length > 0 ? fromParams : [urlHost];
  if (rawHosts.some((h) => h === undefined)) return undefined;
  const hosts = (rawHosts as string[])
    .flatMap((h) => h.split(","))
    .map((h) => h.trim().replace(/^\[(.*)\]$/, "$1"));
  const path = decode(parsed.pathname.replace(/^\//, ""));
  const user = decode(parsed.username) ?? "";
  if (path === undefined) return undefined;
  const db = params.get("dbname") ?? (path === "" ? (params.get("user") ?? user) : path);
  return { hosts, db };
}
