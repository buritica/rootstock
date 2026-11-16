import { describe, expect, test } from "bun:test";
import { address, harness, IP_HEADER, jsonPost, type Shape } from "./auth.test-support.ts";
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

// Lets the deferred send start.
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

  test("an unknown address gets no send and no log line", async () => {
    const h = harness("invited");
    await signIn(h.layer, address("stranger"));
    await tick();
    expect(h.sent).toEqual([]);
    expect(h.logs).toEqual([]);
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
    expect(h.logs).toEqual([{ event: "auth.magic_link_suppressed", fields: { userId: id } }]);
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
    await invite(h.layer, address("member"));
    await signIn(h.layer, address("member"));
    await tick();
    expect(h.logs).toEqual([
      { event: "auth.magic_link_send_failed", fields: { errorClass: "TypeError" } },
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
