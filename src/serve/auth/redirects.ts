const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True when `uri` may receive an authorization code: its hostname is listed
 * (exact, no subdomains) and it is https, or http to a loopback host that is
 * itself listed. A custom scheme is never accepted. `hosts` are lowercased.
 */
export function isAllowedRedirectUri(uri: string, hosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (!hosts.includes(host)) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(host));
}
