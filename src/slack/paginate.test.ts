import { describe, expect, test } from "bun:test";
import { paginateSlackCursor, type SlackCursorWalk } from "./index.ts";

type Page = Record<string, unknown>;

class TestError extends Error {}

interface Harness {
  walk: SlackCursorWalk;
  cursors: Array<string | undefined>;
  made: string[];
}

/** Serves `pages` in order; asking past the script is a test bug. */
function harness(pages: readonly Page[], overrides: Partial<SlackCursorWalk> = {}): Harness {
  const cursors: Array<string | undefined> = [];
  const made: string[] = [];
  const walk: SlackCursorWalk = {
    label: "svc: conversations.history",
    key: "messages",
    maxPages: 1_000,
    fetchPage: async (cursor) => {
      cursors.push(cursor);
      const page = pages[cursors.length - 1];
      if (page === undefined) throw new Error("test script exhausted");
      return page;
    },
    makeError: (message) => {
      made.push(message);
      return new TestError(message);
    },
    ...overrides,
  };
  return { walk, cursors, made };
}

describe("paginateSlackCursor: walking", () => {
  test("a single page without response_metadata ends the walk", async () => {
    const h = harness([{ messages: [1, 2] }]);
    expect(await paginateSlackCursor(h.walk)).toEqual([1, 2]);
    expect(h.cursors).toEqual([undefined]);
  });

  test("two pages are concatenated and the empty cursor ends the walk", async () => {
    const h = harness([
      { messages: ["a", "b"], response_metadata: { next_cursor: "c2" } },
      { messages: ["c"], response_metadata: { next_cursor: "" } },
    ]);
    expect(await paginateSlackCursor(h.walk)).toEqual(["a", "b", "c"]);
    expect(h.cursors).toEqual([undefined, "c2"]);
  });

  test("response_metadata present without next_cursor ends the walk", async () => {
    const h = harness([{ messages: [1], response_metadata: {} }]);
    expect(await paginateSlackCursor(h.walk)).toEqual([1]);
  });

  test("an empty array on the last page still returns what came before", async () => {
    const h = harness([
      { messages: [1], response_metadata: { next_cursor: "x" } },
      { messages: [] },
    ]);
    expect(await paginateSlackCursor(h.walk)).toEqual([1]);
    expect(h.cursors).toEqual([undefined, "x"]);
  });

  test("a walk of three pages passes each cursor to the next fetch", async () => {
    const h = harness([
      { messages: [1], response_metadata: { next_cursor: "p2" } },
      { messages: [2], response_metadata: { next_cursor: "p3" } },
      { messages: [3] },
    ]);
    expect(await paginateSlackCursor(h.walk)).toEqual([1, 2, 3]);
    expect(h.cursors).toEqual([undefined, "p2", "p3"]);
  });

  test("items are appended as returned, not copied or filtered", async () => {
    const item = { ts: "1" };
    const h = harness([{ messages: [item, null, undefined, 0, ""] }]);
    const out = await paginateSlackCursor(h.walk);
    expect(out).toEqual([item, null, undefined, 0, ""]);
    expect(out[0]).toBe(item);
  });

  test("the result is a fresh array, never a page's own", async () => {
    const own = [1, 2];
    const h = harness([{ messages: own }]);
    const out = await paginateSlackCursor(h.walk);
    expect(out).toEqual([1, 2]);
    expect(out).not.toBe(own);
  });

  test("a different key selects a different field", async () => {
    const h = harness([{ messages: ["no"], channels: ["yes"] }], { key: "channels" });
    expect(await paginateSlackCursor(h.walk)).toEqual(["yes"]);
  });

  test("a null cursor passes through unchanged", async () => {
    const h = harness([
      { messages: [1], response_metadata: { next_cursor: null } },
      { messages: [2] },
    ]);
    expect(await paginateSlackCursor(h.walk)).toEqual([1, 2]);
    expect(h.cursors).toEqual([undefined, null as unknown as string]);
  });

  test("a repeated null cursor is refused as a repeat", async () => {
    const h = harness([
      { messages: [1], response_metadata: { next_cursor: null } },
      { messages: [2], response_metadata: { next_cursor: null } },
    ]);
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "svc: conversations.history repeated pagination cursor — refusing to loop",
    );
  });

  test("a null response_metadata throws no refusal, it ends the walk", async () => {
    const h = harness([{ messages: [1], response_metadata: null }]);
    expect(await paginateSlackCursor(h.walk)).toEqual([1]);
  });
});

describe("paginateSlackCursor: refusals", () => {
  test("maxPages 0 throws before the first fetch", async () => {
    const h = harness([{ messages: [1] }], { maxPages: 0 });
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "svc: conversations.history exceeded 0 pages — refusing to loop",
    );
    expect(h.cursors).toEqual([]);
  });

  test("maxPages 1 with a cursor throws at page 2, before fetching it", async () => {
    const h = harness(
      [{ messages: [1], response_metadata: { next_cursor: "more" } }, { messages: [2] }],
      { maxPages: 1 },
    );
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "svc: conversations.history exceeded 1 pages — refusing to loop",
    );
    expect(h.cursors).toEqual([undefined]);
  });

  test("maxPages 1 with no cursor returns normally", async () => {
    const h = harness([{ messages: [1] }], { maxPages: 1 });
    expect(await paginateSlackCursor(h.walk)).toEqual([1]);
  });

  test("a negative maxPages throws before the first fetch", async () => {
    const h = harness([{ messages: [1] }], { maxPages: -1 });
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "svc: conversations.history exceeded -1 pages — refusing to loop",
    );
    expect(h.cursors).toEqual([]);
  });

  test("a NaN maxPages never trips, the walk runs to its natural end", async () => {
    const h = harness([{ messages: [1] }], { maxPages: Number.NaN });
    expect(await paginateSlackCursor(h.walk)).toEqual([1]);
  });

  test("a repeated cursor on consecutive pages is refused", async () => {
    const h = harness([
      { messages: [1], response_metadata: { next_cursor: "a" } },
      { messages: [2], response_metadata: { next_cursor: "a" } },
    ]);
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "svc: conversations.history repeated pagination cursor — refusing to loop",
    );
    expect(h.cursors).toEqual([undefined, "a"]);
  });

  test("a cursor repeated after an intervening one is refused", async () => {
    const h = harness([
      { messages: [1], response_metadata: { next_cursor: "a" } },
      { messages: [2], response_metadata: { next_cursor: "b" } },
      { messages: [3], response_metadata: { next_cursor: "a" } },
    ]);
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "svc: conversations.history repeated pagination cursor — refusing to loop",
    );
    expect(h.cursors).toEqual([undefined, "a", "b"]);
  });

  test("the missing key is refused", async () => {
    const h = harness([{ ok: true }]);
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      'svc: conversations.history returned ok but no "messages" array',
    );
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["a string", "abc"],
    ["an object", { length: 1 }],
    ["a number", 3],
    ["undefined", undefined],
  ])("a key holding %s is refused", async (_label, value) => {
    const h = harness([{ messages: value }]);
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      'svc: conversations.history returned ok but no "messages" array',
    );
  });

  test("the key is refused on a later page, after the first was collected", async () => {
    const h = harness([{ messages: [1], response_metadata: { next_cursor: "a" } }, { ok: true }]);
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      'svc: conversations.history returned ok but no "messages" array',
    );
    expect(h.cursors).toEqual([undefined, "a"]);
  });

  test("a key containing a double quote is JSON-quoted in the message", async () => {
    const h = harness([{}], { key: 'we"ird\\key' });
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      'svc: conversations.history returned ok but no "we\\"ird\\\\key" array',
    );
  });

  test("refusal text keeps the em dash (U+2014) and the label verbatim", async () => {
    const h = harness([{ messages: [] }], { label: "L", maxPages: 0 });
    await expect(paginateSlackCursor(h.walk)).rejects.toThrow(
      "L exceeded 0 pages — refusing to loop",
    );
  });

  test("makeError gets exactly the message, once per refusal", async () => {
    const h = harness([{ ok: true }]);
    await expect(paginateSlackCursor(h.walk)).rejects.toBeInstanceOf(TestError);
    expect(h.made).toEqual(['svc: conversations.history returned ok but no "messages" array']);
  });
});

describe("paginateSlackCursor: identity and call parity", () => {
  test("the makeError result is thrown by identity", async () => {
    const made = new TestError("sentinel");
    const h = harness([{ ok: true }], { makeError: () => made });
    let caught: unknown;
    try {
      await paginateSlackCursor(h.walk);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(made);
  });

  test("a non-Error value returned by makeError is thrown as returned", async () => {
    const made = { not: "an error" } as unknown as Error;
    const h = harness([{ ok: true }], { makeError: () => made });
    let caught: unknown;
    try {
      await paginateSlackCursor(h.walk);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(made);
  });

  test("a fetchPage rejection propagates by identity and makeError is not called", async () => {
    const boom = new Error("network down");
    const h = harness([], {
      fetchPage: async () => {
        throw boom;
      },
    });
    let caught: unknown;
    try {
      await paginateSlackCursor(h.walk);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(h.made).toEqual([]);
  });

  test("a fetchPage rejection on page 2 discards what was collected", async () => {
    const boom = new Error("page 2 failed");
    let calls = 0;
    const h = harness([], {
      fetchPage: async () => {
        calls++;
        if (calls === 2) throw boom;
        return { messages: [1], response_metadata: { next_cursor: "n" } };
      },
    });
    await expect(paginateSlackCursor(h.walk)).rejects.toBe(boom);
    expect(calls).toBe(2);
  });

  test("a fetchPage that throws synchronously propagates as a rejection", async () => {
    const boom = new Error("sync");
    const h = harness([], {
      fetchPage: () => {
        throw boom;
      },
    });
    await expect(paginateSlackCursor(h.walk)).rejects.toBe(boom);
  });

  test("fetchPage and makeError are called detached (this is undefined)", async () => {
    const seen: unknown[] = [];
    const walk: SlackCursorWalk = {
      label: "L",
      key: "k",
      maxPages: 5,
      fetchPage: async function (this: unknown) {
        seen.push(this);
        return {};
      },
      makeError: function (this: unknown, message) {
        seen.push(this);
        return new Error(message);
      },
    };
    await expect(paginateSlackCursor(walk)).rejects.toThrow('L returned ok but no "k" array');
    expect(seen).toEqual([undefined, undefined]);
  });

  test("the walk's members are read once, so later mutation of the walk is ignored", async () => {
    const calls: string[] = [];
    const walk = {
      label: "L",
      key: "k",
      maxPages: 2,
      fetchPage: async (cursor: string | undefined) => {
        calls.push(`first:${cursor}`);
        walk.fetchPage = async () => {
          calls.push("replaced");
          return { k: [] };
        };
        return cursor === undefined
          ? { k: [1], response_metadata: { next_cursor: "n" } }
          : { k: [2] };
      },
      makeError: (message: string) => new Error(message),
    };
    expect(await paginateSlackCursor(walk)).toEqual([1, 2]);
    expect(calls).toEqual(["first:undefined", "first:n"]);
  });

  test("fetchPage is awaited one page at a time", async () => {
    const events: string[] = [];
    const h = harness([], {
      fetchPage: async (cursor) => {
        events.push(`start:${cursor}`);
        await Promise.resolve();
        events.push(`end:${cursor}`);
        return cursor === undefined
          ? { messages: [1], response_metadata: { next_cursor: "n" } }
          : { messages: [2] };
      },
    });
    expect(await paginateSlackCursor(h.walk)).toEqual([1, 2]);
    expect(events).toEqual(["start:undefined", "end:undefined", "start:n", "end:n"]);
  });

  test("a failed walk leaves no state behind for the next walk", async () => {
    const pages: Page[] = [
      { messages: [1], response_metadata: { next_cursor: "a" } },
      { messages: [2], response_metadata: { next_cursor: "a" } },
    ];
    const first = harness(pages);
    await expect(paginateSlackCursor(first.walk)).rejects.toBeInstanceOf(TestError);
    const second = harness([
      { messages: [9], response_metadata: { next_cursor: "a" } },
      { messages: [8] },
    ]);
    expect(await paginateSlackCursor(second.walk)).toEqual([9, 8]);
  });
});

describe("@buritica/rootstock/slack surface", () => {
  test("runtime keys are exactly the frozen list", async () => {
    const mod = await import("./index.ts");
    expect(Object.keys(mod).sort()).toEqual(["paginateSlackCursor"]);
  });
});
