// Run by node.test.ts under Node (type stripping): the service behind
// node:http through the SDK's node adapter, the way a node consumer mounts it.

import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  CALL_HEADERS,
  call,
  fakeAuth,
  HANDLER_JSON,
  makeService,
  rpcOf,
} from "./service.test-support.ts";

const { service, records } = makeService({
  profile: { ...HANDLER_JSON, hostCheck: false },
  auth: fakeAuth(),
});
const node = toNodeHandler({
  fetch: async (req: Request) =>
    (await service.handle(req, {})) ?? new Response(null, { status: 404 }),
});
const server = createServer((req, res) => {
  void node(req, res);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;
const post = (body: string, token: string) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { ...CALL_HEADERS, authorization: `Bearer ${token}` },
    body,
  });
const ok = await post(JSON.stringify(call("echo", { text: "from node" })), "good:u1");
const tooBig = await post(JSON.stringify(call("echo", { text: "a".repeat(3_000) })), "good:u1");
const noToken = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
const out = {
  runtime: typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun",
  ok: { status: ok.status, rpc: await rpcOf(ok) },
  tooBig: { status: tooBig.status, body: await tooBig.text() },
  noToken: noToken.status,
  records: records.map((r) => [r.caller, r.tool, r.stage, r.ok]),
};
server.close();
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
