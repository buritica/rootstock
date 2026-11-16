import { expect, test } from "bun:test";

// The service under Node, not Bun: nothing in serve may lean on a Bun global.
test("the service runs under node behind node:http", async () => {
  const proc = Bun.spawn(
    [
      "node",
      "--experimental-strip-types",
      "--no-warnings",
      `${import.meta.dir}/node-run.test-support.ts`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({
    runtime: "node",
    ok: {
      status: 200,
      rpc: { result: { content: [{ type: "text", text: "from node" }] }, jsonrpc: "2.0", id: 1 },
    },
    tooBig: {
      status: 413,
      body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Payload Too Large: Request body must not exceed 2048 bytes"},"id":null}',
    },
    noToken: 401,
    records: [["u1", "echo", "handler", true]],
  });
}, 20_000);
