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
  // A bad argument is a config error, not a verdict on the database.
  fail(`assertThrowawayDb: ${message}`);
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/** A Unix socket is named by an absolute path. An empty host is not one: a driver fills it from PGHOST. */
const isSocket = (host: string): boolean => host.startsWith("/");

/**
 * Refuses (E-MIG-NOT-THROWAWAY) unless `url` names a throwaway database: every
 * host it could reach is in `allowHosts` or a Unix socket path, and every
 * database name it could open is outside `denyNames`.
 *
 * The URL is read for every driver at once, so nothing it could mean slips
 * past: the authority's host AND each `host` / `hostaddr` query value (libpq
 * reads the parameters, postgres.js and Bun.SQL the authority), each item of a
 * comma-separated list, and the path's database AND each `dbname` value.
 * Refused outright, because a driver would fill the gap from the environment:
 * a URL that names no host (PGHOST) or no database (PGDATABASE, or the user),
 * and a `service` parameter (a service file). A URL that does not parse is
 * refused too. Pure: no I/O, and no message carries the URL's password.
 * `unsafeAllow` skips every check, an unparseable URL included, and logs it.
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
  const shownHosts = target === undefined ? "?" : target.hosts.join(",");
  const shownDbs = target === undefined ? "?" : target.dbs.join(",");
  if (unsafeAllow !== undefined) {
    unsafeAllow.log(
      `rootstock migrate: assertThrowawayDb skipped for ${q(shownHosts)}/${q(shownDbs)} — ${unsafeAllow.reason}`,
    );
    return;
  }
  if (target === undefined) {
    refuse("?", "?", "the URL is not a postgres:// or postgresql:// URL that parses");
  }
  const { hosts, dbs, service } = target;
  if (service) refuse(shownHosts, shownDbs, "a service parameter names its host in a file");
  if (hosts.length === 0)
    refuse(shownHosts, shownDbs, "the URL names no host, so a driver would use PGHOST");
  if (dbs.length === 0) {
    refuse(
      shownHosts,
      shownDbs,
      "the URL names no database, so a driver would use PGDATABASE or the user",
    );
  }
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()));
  const stray = hosts.find((h) => !isSocket(h) && !allowed.has(h.toLowerCase()));
  if (stray !== undefined) {
    refuse(
      shownHosts,
      shownDbs,
      `host ${q(stray)} is not in allowHosts (${[...allowed].join(", ")})`,
    );
  }
  const deny = new Set(denyNames.map((n) => n.toLowerCase()));
  const denied = dbs.find((db) => deny.has(db.toLowerCase()));
  if (denied !== undefined)
    refuse(shownHosts, shownDbs, `the database name ${q(denied)} is in denyNames`);
}

function parse(url: string): { hosts: string[]; dbs: string[]; service: boolean } | undefined {
  if (typeof url !== "string") return undefined;
  // libpq accepts credentials before an empty host (`postgres://u@/db?host=/sock`);
  // WHATWG URL does not, so parse that shape with a reserved stand-in.
  const socketShape = /^(postgres(?:ql)?:\/\/[^/?#]*@)(?=[/?#]|$)/;
  let parsed: URL;
  try {
    parsed = new URL(url.replace(socketShape, `$1${SOCKET_STANDIN}`));
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
  const params = parsed.searchParams;
  const authority = parsed.hostname === SOCKET_STANDIN ? "" : decode(parsed.hostname);
  const path = decode(parsed.pathname.replace(/^\//, ""));
  if (authority === undefined || path === undefined) return undefined;
  // Every value of a repeated key counts: libpq keeps the last, the URL API the first.
  const hosts = [authority, ...params.getAll("host"), ...params.getAll("hostaddr")]
    .flatMap((h) => h.split(","))
    .map((h) => h.trim().replace(/^\[(.*)\]$/, "$1"))
    .filter((h) => h !== "");
  const dbs = [path, ...params.getAll("dbname")].filter((d) => d !== "");
  return { hosts, dbs, service: params.has("service") };
}
