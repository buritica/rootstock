import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * A request captured by `createRecordingFetch`, with credentials redacted.
 * `requestSha256` covers method, redacted URL and body — the parts that
 * decide what a model or API is asked — so two clients that build the same
 * request produce the same hash regardless of header order or user agent.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  requestSha256: string;
}

const SECRET_PARAMS = new Set(["key", "api_key", "apikey", "access_token", "token"]);
const SECRET_HEADERS = new Set([
  "authorization",
  "x-goog-api-key",
  "x-api-key",
  "cookie",
  "proxy-authorization",
]);
const REDACTED = "<redacted>";

export function redactUrl(raw: string): string {
  const url = new URL(raw);
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) {
      url.searchParams.set(name, REDACTED);
    }
  }
  return url.toString();
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A `fetch` stand-in that records every request and answers with `respond`.
 * Use it to pin the exact requests a client builds (`llm.request` goldens)
 * without a network or an API key.
 */
export function createRecordingFetch(
  respond: (request: RecordedRequest, index: number) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const recording = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = SECRET_HEADERS.has(name) ? REDACTED : value;
    });
    const body = parseBody(await request.text());
    const method = request.method.toUpperCase();
    const url = redactUrl(request.url);
    const recorded: RecordedRequest = {
      method,
      url,
      headers,
      body,
      requestSha256: sha256Hex(canonicalJson({ method, url, body })),
    };
    requests.push(recorded);
    return respond(recorded, requests.length - 1);
  };
  return { fetch: recording as typeof fetch, requests };
}
