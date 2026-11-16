// A bare JSON-RPC peer over the SDK's InMemoryTransport: what a stdio client
// would send, with no client package needed.

import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";

export interface RpcPeer {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  callTool(name: string, args?: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function connectPeer(server: McpServer): Promise<RpcPeer> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  client.onmessage = (m) => {
    const msg = m as Record<string, unknown>;
    const resolve = waiting.get(msg.id as number);
    if (resolve) {
      waiting.delete(msg.id as number);
      resolve(msg);
    }
  };
  await server.connect(serverSide);
  await client.start();
  let id = 0;
  const request = (method: string, params?: unknown) => {
    const n = ++id;
    return new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(n, resolve);
      void client.send({
        jsonrpc: "2.0",
        id: n,
        method,
        ...(params === undefined ? {} : { params }),
      } as never);
    });
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
  return {
    request,
    callTool: (name, args) =>
      request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
