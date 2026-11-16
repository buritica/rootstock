import { describe, expect, test } from "bun:test";
import type { MigrationStatus } from "../migrate/index.ts";
import { captureLog, fakeTime, flush } from "./fakes.test-support.ts";
import { cachedProbe, dbProbe, liveness, migrationsProbe, readiness } from "./probes.ts";

const timing = { timeoutMs: 100, cacheTtlMs: 1_000, pendingMaxMs: 5_000 };

test("liveness answers the fields with the given headers", async () => {
  const live = liveness({
    fields: { status: "ok", sha: null },
    headers: { "content-type": "application/json" },
  });
  const res = live();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.text()).toBe('{"status":"ok","sha":null}');
  expect(await live().text()).toBe('{"status":"ok","sha":null}');
});

describe("cachedProbe", () => {
  test("single flight, cached verdict, then recomputed after the ttl", async () => {
    const time = fakeTime();
    let calls = 0;
    const probe = cachedProbe(async () => ++calls, timing, "p", {
      clock: time,
      timers: time,
      log: captureLog(),
    });
    const [a, b] = await Promise.all([probe(), probe()]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await probe()).toBe(1);
    time.advance(1_000);
    expect(await probe()).toBe(2);
  });

  test("a timeout answers undefined, skips while pending, then recomputes past pendingMaxMs", async () => {
    const time = fakeTime();
    const log = captureLog();
    let calls = 0;
    const probe = cachedProbe(
      () => {
        calls++;
        return new Promise<number>(() => {});
      },
      { timeoutMs: 100, cacheTtlMs: 0, pendingMaxMs: 5_000 },
      "slow",
      { clock: time, timers: time, log },
    );
    const first = probe();
    await flush();
    time.advance(100);
    expect(await first).toBeUndefined();
    expect(await probe()).toBeUndefined();
    expect(calls).toBe(1);
    time.advance(5_000);
    const third = probe();
    await flush();
    time.advance(100);
    await third;
    expect(calls).toBe(2);
    expect(log.names()).toEqual([
      "serve.probe_timeout",
      "serve.probe_skipped",
      "serve.probe_timeout",
    ]);
    expect(log.lines[1]?.[1]).toEqual({ probe: "slow", pendingMs: 100 });
  });

  test("a throw answers undefined and logs probe_failed", async () => {
    const time = fakeTime();
    const log = captureLog();
    const probe = cachedProbe(
      async () => {
        throw new TypeError("boom");
      },
      timing,
      "x",
      { clock: time, timers: time, log },
    );
    expect(await probe()).toBeUndefined();
    expect(log.lines[0]?.[0]).toBe("serve.probe_failed");
    expect(log.lines[0]?.[1]).toMatchObject({ probe: "x", errorClass: "TypeError" });
  });

  test("refuses a negative timing", () => {
    const time = fakeTime();
    expect(() =>
      cachedProbe(async () => 1, { ...timing, timeoutMs: -1 }, "x", {
        clock: time,
        timers: time,
        log: captureLog(),
      }),
    ).toThrow(/timing.timeoutMs/);
  });
});

test("dbProbe sends select 1", async () => {
  const sent: string[] = [];
  const sql = Object.assign(
    async (s: TemplateStringsArray) => {
      sent.push(s.join("?"));
      return [];
    },
    { unsafe: async () => [] },
  );
  expect(await dbProbe(sql as never)()).toBe("ok");
  expect(sent).toEqual(["select 1"]);
});

function status(
  o: Omit<Partial<MigrationStatus>, "sources"> & { sources: unknown[] },
): MigrationStatus {
  return {
    behind: false,
    ahead: false,
    tampered: false,
    trackerRot: false,
    red: false,
    ...o,
  } as never;
}

test("migrationsProbe: ids per source; ahead stays ok; behind or tampered is not ok", async () => {
  const src = {
    source: "app",
    pending: [{ id: "20260101000000_b" }],
    ahead: ["20250101000000_x"],
    tampered: [{ id: "20250101000000_t" }],
  };
  const v = await migrationsProbe(async () =>
    status({ sources: [src], behind: true, tampered: true }),
  )();
  expect(v).toEqual({
    ok: false,
    behind: ["app/20260101000000_b"],
    ahead: ["app/20250101000000_x"],
    tampered: ["app/20250101000000_t"],
  });
  const ahead = await migrationsProbe(async () =>
    status({ sources: [{ ...src, pending: [], tampered: [] }], ahead: true }),
  )();
  expect(ahead.ok).toBe(true);
});

describe("readiness", () => {
  const base = (over: Partial<Parameters<typeof readiness>[0]> = {}) => {
    const time = fakeTime();
    const log = captureLog();
    return {
      log,
      ready: readiness({
        sha: "abc",
        db: async () => "ok",
        probes: {},
        headers: { "content-type": "application/json" },
        timing,
        clock: time,
        timers: time,
        log,
        ...over,
      }),
    };
  };

  test("ok: body in insertion order, undefined probes omitted", async () => {
    const { ready } = base({
      probes: {
        freshness: { read: async () => ({ stale: false }) as { ok?: boolean }, gates: false },
        gone: { read: async () => undefined, gates: true },
        migrations: { read: async () => ({ ok: true, behind: [] }), gates: true },
      },
    });
    const res = await ready();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(
      '{"status":"ok","sha":"abc","db":"ok","freshness":{"stale":false},"migrations":{"ok":true,"behind":[]}}',
    );
  });

  test("a gating probe with ok:false answers 503; a non-gating one does not", async () => {
    const gating = await base({
      probes: { m: { read: async () => ({ ok: false }), gates: true } },
    }).ready();
    expect(gating.status).toBe(503);
    expect(await gating.json()).toEqual({
      status: "not_ready",
      sha: "abc",
      db: "ok",
      m: { ok: false },
    });
    const info = await base({
      probes: { m: { read: async () => ({ ok: false }), gates: false } },
    }).ready();
    expect(info.status).toBe(200);
  });

  test("null db is unconfigured and not ready", async () => {
    const res = await base({ db: null, sha: null }).ready();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"not_ready","sha":null,"db":"unconfigured"}');
  });

  test("a failing db is unreachable; the next ok logs ready_recovered", async () => {
    let up = false;
    const time = fakeTime();
    const log = captureLog();
    const ready = readiness({
      sha: null,
      db: async () => {
        if (!up) throw new Error("down");
        return "ok";
      },
      probes: {},
      headers: {},
      timing: { ...timing, cacheTtlMs: 0 },
      clock: time,
      timers: time,
      log,
    });
    const down = await ready();
    expect(down.status).toBe(503);
    expect(((await down.json()) as { db: string }).db).toBe("unreachable");
    up = true;
    expect((await ready()).status).toBe(200);
    expect((await ready()).status).toBe(200);
    expect(log.names()).toEqual(["serve.probe_failed", "serve.ready_recovered"]);
  });
});
