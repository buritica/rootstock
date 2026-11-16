import { describe, expect, test } from "bun:test";
import {
  address,
  harness,
  IP_HEADER,
  jsonPost,
  ManualClock,
  type Shape,
} from "./auth.test-support.ts";
import { createMagicLinkSender } from "./magic-link.ts";
import type { AuthLayer } from "./types.ts";

async function invite(layer: AuthLayer, email: string): Promise<string> {
  const ctx = await layer.instance.$context;
  const user = await ctx.internalAdapter.createUser(
    { email, name: "synthetic", emailVerified: true },
    { method: "admin" },
  );
  return user.id;
}

// Better Auth's memory limiter is one map per process, so every request comes
// from its own documentation address and no test trips another's bucket.
let source = 0;
const signIn = (layer: AuthLayer, email: string) =>
  layer.handle(
    jsonPost(
      "/sign-in/magic-link",
      { email },
      { [IP_HEADER]: `198.51.100.${(source++ % 254) + 1}` },
    ),
  );

async function answer(res: Response) {
  return { status: res.status, body: await res.text() };
}

// Lets the send the layer scheduled with timers.set(0, …) run.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("magic-link timing", () => {
  test.each<Shape>(["owner", "invited"])(
    "%s: a known address answers before its send settles, exactly as an unknown one",
    async (shape) => {
      let release: () => void = () => undefined;
      const started: string[] = [];
      const h = harness(shape, undefined, (email) => {
        started.push(email);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const known = shape === "owner" ? address("owner") : address("member");
      await invite(h.layer, known);

      const knownAnswer = await answer(await signIn(h.layer, known));
      const unknownAnswer = await answer(await signIn(h.layer, address("stranger")));
      expect(knownAnswer).toEqual({ status: 200, body: '{"status":true}' });
      expect(unknownAnswer).toEqual(knownAnswer);
      await tick();
      // The send began and is still pending: the response never waited on it.
      expect(started).toEqual([known]);
      release();
    },
  );

  test("owner: a known address that is not an owner gets the same answer and no send", async () => {
    const h = harness("owner");
    await invite(h.layer, address("member"));
    const res = await answer(await signIn(h.layer, address("member")));
    expect(res).toEqual({ status: 200, body: '{"status":true}' });
    await tick();
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([{ event: "auth.magic_link_refused", fields: { reason: "not-owner" } }]);
  });

  test("owner: an empty owner list sends nothing, ever", async () => {
    const h = harness("owner", (o) => ({
      ...o,
      signIn: { ...o.signIn, allow: { kind: "owner", emails: [] } } as typeof o.signIn,
    }));
    await invite(h.layer, address("owner"));
    await signIn(h.layer, address("owner"));
    await tick();
    expect(h.sent).toEqual([]);
    expect(h.logs.map((l) => l.fields.reason)).toEqual(["no-owner"]);
  });

  test("an unknown address gets no send and a reason-only refusal", async () => {
    const h = harness("invited");
    await signIn(h.layer, address("stranger"));
    await tick();
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([{ event: "auth.magic_link_refused", fields: { reason: "unknown" } }]);
  });
});

describe("the per-address send limit", () => {
  test("a sliding window per lowercased address; a suppressed send logs the user id, never the address", async () => {
    const h = harness("owner");
    const id = await invite(h.layer, address("owner"));
    for (const email of [address("owner"), address("OWNER"), address(" Owner")]) {
      await signIn(h.layer, email.trim());
      h.clock.t += 1_000;
    }
    await signIn(h.layer, address("owner"));
    await tick();
    expect(h.sent).toHaveLength(3);
    // Sends settle on their timers, so only the counts per event are fixed.
    const of = (event: string) => h.logs.filter((l) => l.event === event);
    expect(of("auth.magic_link_sent")).toEqual(
      Array(3).fill({ event: "auth.magic_link_sent", fields: { userId: id } }),
    );
    expect(of("auth.magic_link_suppressed")).toEqual([
      { event: "auth.magic_link_suppressed", fields: { userId: id } },
    ]);
    expect(h.logs).toHaveLength(4);
    expect(JSON.stringify(h.logs)).not.toContain("example.test");
    // The first send leaves the 600 s window.
    h.clock.t += 600_000 - 3_000;
    await signIn(h.layer, address("owner"));
    await tick();
    expect(h.sent).toHaveLength(4);
  });

  test("releaseOnFailure: a failed send frees its slot at once", async () => {
    let fail = true;
    const sent: string[] = [];
    const h = harness("invited", undefined, async (email) => {
      if (fail) throw new TypeError("mail provider down");
      sent.push(email);
    });
    const id = await invite(h.layer, address("member"));
    await signIn(h.layer, address("member"));
    await tick();
    expect(h.logs).toEqual([
      {
        event: "auth.magic_link_send_failed",
        fields: { errorClass: "TypeError", userId: id, released: true },
      },
    ]);
    fail = false;
    await signIn(h.layer, address("member"));
    await tick();
    expect(sent).toEqual([address("member")]);
  });

  test("without releaseOnFailure a failed send still holds its slot", async () => {
    const h = harness(
      "invited",
      (o) => ({
        ...o,
        signIn: {
          ...o.signIn,
          sendLimit: { max: 1, windowMs: 60_000, releaseOnFailure: false },
        } as typeof o.signIn,
      }),
      () => {
        throw new Error("thrown before any promise");
      },
    );
    await invite(h.layer, address("member"));
    expect((await signIn(h.layer, address("member"))).status).toBe(200);
    await tick();
    await signIn(h.layer, address("member"));
    await tick();
    expect(h.logs.map((l) => l.event)).toEqual([
      "auth.magic_link_send_failed",
      "auth.magic_link_suppressed",
    ]);
  });

  test("a throwing log never changes the answer", async () => {
    const h = harness("owner", (o) => ({
      ...o,
      log: () => {
        throw new Error("log sink down");
      },
    }));
    await invite(h.layer, address("member"));
    expect(await answer(await signIn(h.layer, address("member")))).toEqual({
      status: 200,
      body: '{"status":true}',
    });
  });
});

describe("review fixes", () => {
  test("the send runs on the injected timer, after the response, even when the sender blocks", async () => {
    const queued: (() => void)[] = [];
    let ran = false;
    const h = harness(
      "invited",
      (o) => ({
        ...o,
        timers: {
          set: (_ms, fn) => {
            queued.push(fn);
            return () => undefined;
          },
        },
      }),
      () => {
        ran = true; // synchronous work a sender might do before its first await
        return Promise.resolve();
      },
    );
    await invite(h.layer, address("member"));
    expect((await signIn(h.layer, address("member"))).status).toBe(200);
    expect(ran).toBe(false);
    expect(queued).toHaveLength(1);
    queued[0]?.();
    await h.layer.idle();
    expect(ran).toBe(true);
  });

  const runNow = {
    set: (_ms: number, fn: () => void) => {
      fn();
      return () => undefined;
    },
  };
  const limit = { max: 1, windowMs: 60_000, releaseOnFailure: true };
  const known = {
    context: { internalAdapter: { findUserByEmail: async () => ({ user: { id: "u1" } }) } },
  };

  test("a throwing logger after a failed send raises nothing", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const sender = createMagicLinkSender(
        {
          kind: "magicLink",
          allow: { kind: "invited" },
          send: async () => Promise.reject(new Error("down")),
          sendLimit: limit,
        },
        null,
        {
          clock: new ManualClock(),
          timers: runNow,
          log: () => {
            throw new Error("log down");
          },
        },
      );
      await sender.send({ email: address("member"), url: "https://app.example.test/x" }, known);
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test("a missing endpoint context sends nothing and says so", async () => {
    const logs: string[] = [];
    let sent = false;
    const sender = createMagicLinkSender(
      {
        kind: "magicLink",
        allow: { kind: "invited" },
        send: async () => {
          sent = true;
        },
        sendLimit: limit,
      },
      null,
      { clock: new ManualClock(), timers: runNow, log: (_e, f) => logs.push(String(f.reason)) },
    );
    await sender.send({ email: address("member"), url: "https://app.example.test/x" }, null);
    expect(sent).toBe(false);
    expect(logs).toEqual(["no-context"]);
  });

  // Pinned as it stands, not endorsed: during a store outage the user lookup
  // throws, so an owner's address gets Better Auth's 500 while any other
  // address is refused before the lookup and still gets the generic 200.
  test("a failing user lookup: 500 for an owner, 200 for a non-owner", async () => {
    const h = harness("owner");
    delete h.db.user;
    expect((await signIn(h.layer, address("owner"))).status).toBe(500);
    expect((await signIn(h.layer, address("member"))).status).toBe(200);
  });
});

describe("imagine fixes", () => {
  test("a sender that returns no promise is a sent link, not a failure", async () => {
    const h = harness("invited", undefined, (() => undefined) as unknown as () => Promise<void>);
    const id = await invite(h.layer, address("member"));
    await signIn(h.layer, address("member"));
    await h.layer.idle();
    expect(h.logs).toEqual([{ event: "auth.magic_link_sent", fields: { userId: id } }]);
  });

  test("a timer that refuses to schedule: same 200, slot released, failure logged", async () => {
    let refuse = true;
    const h = harness("owner", (o) => ({
      ...o,
      timers: {
        set: (ms, fn) => {
          if (refuse) throw new RangeError("no timers left");
          const handle = setTimeout(fn, ms);
          return () => clearTimeout(handle);
        },
      },
    }));
    const id = await invite(h.layer, address("owner"));
    const first = await signIn(h.layer, address("owner"));
    expect({ status: first.status, body: await first.text() }).toEqual({
      status: 200,
      body: '{"status":true}',
    });
    expect(h.logs).toEqual([
      {
        event: "auth.magic_link_send_failed",
        fields: { errorClass: "RangeError", userId: id, released: true },
      },
    ]);
    // releaseOnFailure is false for this shape, yet the unscheduled slot came back.
    refuse = false;
    for (let i = 0; i < 3; i++) await signIn(h.layer, address("owner"));
    await h.layer.idle();
    expect(h.sent).toHaveLength(3);
  });

  test("idle() waits for a scheduled and in-flight send, then resolves", async () => {
    let finish: () => void = () => undefined;
    const h = harness(
      "invited",
      undefined,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await h.layer.idle();
    await invite(h.layer, address("member"));
    await signIn(h.layer, address("member"));
    let idle = false;
    const waiting = h.layer.idle().then(() => {
      idle = true;
    });
    await tick();
    expect(idle).toBe(false);
    finish();
    await waiting;
    expect(idle).toBe(true);
    expect(h.logs.map((l) => l.event)).toEqual(["auth.magic_link_sent"]);
  });

  test("idle() resolves at once without a magic link", async () => {
    await harness("social").layer.idle();
  });

  test("the send window runs on the monotonic clock, so a wall-clock step back changes nothing", async () => {
    let wall = 1_800_000_000_000;
    let mono = 0;
    const h = harness("invited", (o) => ({
      ...o,
      clock: { now: () => wall, monotonic: () => mono },
    }));
    await invite(h.layer, address("member"));
    await signIn(h.layer, address("member"));
    wall -= 3_600_000; // NTP steps the wall clock back an hour
    mono += 60_000; // while a full window really passes
    await signIn(h.layer, address("member"));
    await h.layer.idle();
    expect(h.sent).toHaveLength(2);
  });
});
