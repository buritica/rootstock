import type { Socket } from "bun";
import { testUrl } from "./fixtures.pg-support.ts";

/**
 * A byte-forwarding TCP proxy to the test server, the same black-hole proxy
 * `stall.pg.ts` uses: `freeze` stops bytes in both directions on every
 * connection open now, the way a silently dropped socket does, and nothing
 * errors. With `forwardClose: false` the server side is kept open when the
 * client side closes, so the server never hears of it. `stop` ends every
 * server side, which the server reads as the client going away.
 */
export interface StallProxy {
  url: string;
  freeze(opts: { forwardClose: boolean }): void;
  stop(): void;
}

interface Link {
  frozen: boolean;
  forwardClose: boolean;
  upstream?: Socket<undefined>;
  pending: Uint8Array[];
}

export function startStallProxy(): StallProxy {
  const target = new URL(testUrl());
  const links = new Set<Link>();
  const byClient = new WeakMap<Socket<undefined>, Link>();
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      async open(client) {
        const link: Link = { frozen: false, forwardClose: true, pending: [] };
        links.add(link);
        byClient.set(client, link);
        link.upstream = await Bun.connect<undefined>({
          hostname: target.hostname,
          port: Number(target.port || 5432),
          socket: {
            data(_, buf) {
              if (!link.frozen) client.write(buf);
            },
            close() {
              if (!link.frozen) client.end();
            },
            error() {},
          },
        });
        for (const buf of link.pending.splice(0)) link.upstream.write(buf);
      },
      data(client, buf) {
        const link = byClient.get(client);
        if (link === undefined || link.frozen) return;
        if (link.upstream === undefined) link.pending.push(new Uint8Array(buf));
        else link.upstream.write(buf);
      },
      close(client) {
        const link = byClient.get(client);
        if (link?.forwardClose) link.upstream?.end();
      },
      error() {},
    },
  });
  const url = new URL(testUrl());
  url.hostname = "127.0.0.1";
  url.port = String(server.port);
  return {
    url: url.toString(),
    freeze({ forwardClose }) {
      for (const link of links) {
        link.frozen = true;
        link.forwardClose = forwardClose;
      }
    },
    stop() {
      for (const link of links) link.upstream?.end();
      server.stop(true);
    },
  };
}
