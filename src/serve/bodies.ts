// Response bytes (contract §11). Each one that mimics the SDK is checked in
// service.test.ts against the SDK's own response to the same request.

import type { ServeProfile } from "./types.ts";

type Entry = ServeProfile["entry"]["kind"];
type Bodies = ServeProfile["bodies"];

const JSON_CT = { "content-type": "application/json" };
// Response.json's own header, which the handler entry's refusals carry.
const JSON_UTF8_CT = { "content-type": "application/json;charset=utf-8" };
const TEXT_CT = { "content-type": "text/plain; charset=utf-8" };
const NO_STORE = { "cache-control": "no-store" };

const jsonRpc = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

export const methodNotAllowed = (): Response =>
  new Response(null, { status: 405, headers: { allow: "POST", ...NO_STORE } });

export const tooManyRequests = (): Response =>
  new Response(null, { status: 429, headers: { "retry-after": "10", ...NO_STORE } });

export const ACCEPT_TEXT =
  "Not Acceptable: Client must accept both application/json and text/event-stream";
export const CONTENT_TYPE_TEXT = "Unsupported Media Type: Content-Type must be application/json";
export const tooLargeText = (limit: number) =>
  `Payload Too Large: Request body must not exceed ${limit} bytes`;

/** 406: the streamable transport answers it under both entries (the handler's legacy leg is that transport). */
export const notAcceptable = (): Response =>
  new Response(jsonRpc(-32000, ACCEPT_TEXT), { status: 406, headers: JSON_CT });

export const unsupportedMediaType = (entry: Entry): Response =>
  new Response(jsonRpc(-32000, CONTENT_TYPE_TEXT), {
    status: 415,
    headers: entry === "transport" ? JSON_CT : JSON_UTF8_CT,
  });

export const tooLarge = (entry: Entry, limit: number): Response =>
  new Response(jsonRpc(-32000, tooLargeText(limit)), {
    status: 413,
    headers: entry === "transport" ? JSON_CT : JSON_UTF8_CT,
  });

export function parseError(kind: Bodies["parseError"]): Response {
  return kind === "empty-400"
    ? new Response(null, { status: 400, headers: NO_STORE })
    : new Response(jsonRpc(-32700, "Parse error: Invalid JSON"), { status: 400, headers: JSON_CT });
}

export function unauthorizedNoSub(kind: Bodies["unauthorizedNoSub"]): Response {
  return kind === "empty-401"
    ? new Response(null, { status: 401, headers: NO_STORE })
    : new Response(jsonRpc(-32000, "token missing subject claim"), {
        status: 401,
        headers: JSON_CT,
      });
}

/** No static credential matched and OAuth is not offered here. */
export const bearerUnauthorized = (): Response =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { ...JSON_CT, "www-authenticate": "Bearer" },
  });

export function jwksFailure(kind: Bodies["jwksFailure"]): Response {
  switch (kind) {
    case "503-retry":
      return new Response("Service Unavailable", {
        status: 503,
        headers: { ...TEXT_CT, "retry-after": "5" },
      });
    case "500-empty":
      return new Response(null, { status: 500 });
    case "jsonrpc-500":
      return new Response(jsonRpc(-32603, "Internal server error"), {
        status: 500,
        headers: JSON_UTF8_CT,
      });
  }
}

export function internal(kind: Bodies["internal"]): Response {
  switch (kind) {
    case "empty-500":
      return new Response(null, { status: 500 });
    case "json-500":
      return new Response(JSON.stringify({ error: "internal server error" }), {
        status: 500,
        headers: JSON_CT,
      });
    case "text-500":
      return new Response("Internal Server Error", { status: 500, headers: TEXT_CT });
  }
}

export function notFound(kind: Bodies["notFound"]): Response {
  switch (kind) {
    case "empty-no-store":
      return new Response(null, { status: 404, headers: NO_STORE });
    case "text-not-found":
      return new Response("Not Found", { status: 404 });
    case "json-not-found":
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: JSON_CT,
      });
  }
}
