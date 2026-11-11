import { describe, expect, test } from "bun:test";
import { type LockSlice, type LockSliceInput, lockSlice, withNames } from "./slice.ts";

const BASE: LockSliceInput = {
  profile: "lock",
  names: ["alpha-sync", "beta-sync", "gamma-*"],
  heartbeatSeconds: 30,
  probeStallSeconds: 60,
  maxRecoveries: 5,
  endTimeoutSeconds: 5,
  wait: { maxMs: 1000, pollIntervalMs: 50 },
};

function input(over: Record<string, unknown>): LockSliceInput {
  return { ...BASE, ...over } as LockSliceInput;
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

const parse = (over: Record<string, unknown>): string => refusal(() => lockSlice(input(over)));
const E_ID = "an identifier matching [a-z_][a-z0-9_]* of at most 63 bytes";
const E_NAMES = "a non-empty array of lock names";
const E_ENTRY =
  "a lock name matching [a-z0-9][a-z0-9:._-]* (optionally ending in one *) of at most 200 bytes";
const E_UNIQUE = "a name no other entry already admits";
const E_GROUP = "an exact lock name the names admit, once";

describe("S1: every bound refuses with its path and expected text", () => {
  const rows: [string, Record<string, unknown>, string, unknown][] = [
    ["table.schema", { table: { schema: "Bad" } }, E_ID, "Bad"],
    ["table.schema", { table: { schema: "a".repeat(64) } }, E_ID, "a".repeat(64)],
    ["table.name", { table: { name: "bad-name" } }, E_ID, "bad-name"],
    ["profile", { profile: "Lock" }, "a profile name matching [a-z][a-z0-9-]*", "Lock"],
    ["names", { names: [] }, E_NAMES, []],
    ["names", { names: "alpha-sync" }, E_NAMES, "alpha-sync"],
    ["names[0]", { names: ["Alpha"] }, E_ENTRY, "Alpha"],
    ["names[0]", { names: ["*"] }, E_ENTRY, "*"],
    ["names[0]", { names: ["a**"] }, E_ENTRY, "a**"],
    ["names[1]", { names: ["alpha-sync", "alpha-sync"] }, E_UNIQUE, "alpha-sync"],
    ["groups", { groups: ["alpha-sync"] }, "an object", ["alpha-sync"]],
    [
      "groups.Writers",
      { groups: { Writers: ["alpha-sync"] } },
      "a group name matching [a-z][a-z0-9-]*",
      "Writers",
    ],
    ["groups.writers", { groups: { writers: [] } }, E_NAMES, []],
    ["groups.writers[0]", { groups: { writers: ["delta-sync"] } }, E_GROUP, "delta-sync"],
    ["heartbeatSeconds", { heartbeatSeconds: 4 }, "an integer from 5 to 300", 4],
    ["heartbeatSeconds", { heartbeatSeconds: 301 }, "an integer from 5 to 300", 301],
    ["heartbeatSeconds", { heartbeatSeconds: 30.5 }, "an integer from 5 to 300", 30.5],
    [
      "probeStallSeconds",
      { probeStallSeconds: 30 },
      "an integer above heartbeatSeconds and at most 600",
      30,
    ],
    [
      "probeStallSeconds",
      { probeStallSeconds: 601 },
      "an integer above heartbeatSeconds and at most 600",
      601,
    ],
    ["maxRecoveries", { maxRecoveries: -1 }, "an integer from 0 to 20", -1],
    ["maxRecoveries", { maxRecoveries: 21 }, "an integer from 0 to 20", 21],
    ["endTimeoutSeconds", { endTimeoutSeconds: 0 }, "an integer from 1 to 60", 0],
    ["endTimeoutSeconds", { endTimeoutSeconds: 61 }, "an integer from 1 to 60", 61],
    ["wait.maxMs", { wait: { maxMs: -1, pollIntervalMs: 50 } }, "an integer from 0 to 3600000", -1],
    [
      "wait.maxMs",
      { wait: { maxMs: 3_600_001, pollIntervalMs: 50 } },
      "an integer from 0 to 3600000",
      3_600_001,
    ],
    [
      "wait.pollIntervalMs",
      { wait: { maxMs: 0, pollIntervalMs: 9 } },
      "an integer from 10 to 60000",
      9,
    ],
    [
      "wait.pollIntervalMs",
      { wait: { maxMs: 0, pollIntervalMs: 60_001 } },
      "an integer from 10 to 60000",
      60_001,
    ],
  ];
  for (const [path, over, expected, got] of rows) {
    test(`${path}: ${JSON.stringify(over)}`, () => {
      expect(parse(over)).toBe(
        `lockSlice: ${path} must be ${expected} — got ${JSON.stringify(got)}`,
      );
    });
  }

  test("the edges of each range pass", () => {
    for (const over of [
      { heartbeatSeconds: 5, probeStallSeconds: 6 },
      { heartbeatSeconds: 300, probeStallSeconds: 600 },
      { maxRecoveries: 0 },
      { maxRecoveries: 20 },
      { endTimeoutSeconds: 1 },
      { endTimeoutSeconds: 60 },
      { wait: { maxMs: 0, pollIntervalMs: 10 } },
      { wait: { maxMs: 3_600_000, pollIntervalMs: 60_000 } },
      { table: { schema: "a".repeat(63), name: "_x" } },
    ]) {
      expect(() => lockSlice(input(over))).not.toThrow();
    }
  });
});

describe("S2: unknown key, then required, then value, at every level", () => {
  test("top level", () => {
    expect(parse({ extra: 1, profile: undefined, heartbeatSeconds: 1 })).toBe(
      "lockSlice: extra is not a known key",
    );
    expect(parse({ profile: undefined, heartbeatSeconds: 1 })).toBe(
      "lockSlice: profile is required",
    );
    expect(refusal(() => lockSlice({} as LockSliceInput))).toBe("lockSlice: profile is required");
    expect(parse({ wait: undefined, heartbeatSeconds: 1 })).toBe("lockSlice: wait is required");
  });

  test("inside table", () => {
    expect(parse({ table: { other: 1, schema: "Bad" } })).toBe(
      "lockSlice: table.other is not a known key",
    );
    expect(parse({ table: "rootstock.run_locks" })).toBe(
      'lockSlice: table must be an object — got "rootstock.run_locks"',
    );
  });

  test("inside groups", () => {
    expect(parse({ groups: { Bad: [], writers: ["nope"] } })).toBe(
      'lockSlice: groups.Bad must be a group name matching [a-z][a-z0-9-]* — got "Bad"',
    );
  });

  test("inside wait", () => {
    expect(parse({ wait: { other: 1, maxMs: -1 } })).toBe(
      "lockSlice: wait.other is not a known key",
    );
    expect(parse({ wait: { maxMs: -1 } })).toBe("lockSlice: wait.pollIntervalMs is required");
    expect(parse({ wait: { pollIntervalMs: 50 } })).toBe("lockSlice: wait.maxMs is required");
  });
});

describe("wait.block (w4d §8.1, LB5's slice half)", () => {
  const block = (b: unknown) => ({ wait: { maxMs: 1000, pollIntervalMs: 50, block: b } });

  test("absent, the key is missing from the parsed wait", () => {
    const s = lockSlice(BASE);
    expect(Object.keys(s.wait)).toEqual(["maxMs", "pollIntervalMs"]);
    expect(s.wait.block).toBeUndefined();
  });

  test("given, it parses frozen, with its edges", () => {
    for (const checkIntervalMs of [100, 1000, 10_000]) {
      const s = lockSlice(input(block({ checkIntervalMs })));
      expect(s.wait.block).toEqual({ checkIntervalMs });
      expect(Object.isFrozen(s.wait.block)).toBe(true);
    }
  });

  test("out of range or not an integer refuses with its path", () => {
    for (const bad of [99, 10_001, 150.5, "1000", null]) {
      expect(parse(block({ checkIntervalMs: bad }))).toBe(
        `lockSlice: wait.block.checkIntervalMs must be an integer from 100 to 10000 — got ${JSON.stringify(bad)}`,
      );
    }
  });

  test("unknown key, then required, then value; not an object refuses", () => {
    expect(parse(block({ other: 1, checkIntervalMs: 1 }))).toBe(
      "lockSlice: wait.block.other is not a known key",
    );
    expect(parse(block({}))).toBe("lockSlice: wait.block.checkIntervalMs is required");
    expect(parse(block(1000))).toBe("lockSlice: wait.block must be an object — got 1000");
  });

  test("withNames keeps it, and keeps it absent", () => {
    const s = lockSlice(input(block({ checkIntervalMs: 500 })));
    expect(withNames(s, ["delta-sync"]).wait.block).toEqual({ checkIntervalMs: 500 });
    expect(Object.keys(withNames(lockSlice(BASE), ["delta-sync"]).wait)).toEqual([
      "maxMs",
      "pollIntervalMs",
    ]);
  });
});

describe("S3-S6: what the names admit", () => {
  test('S3: "gamma-*" admits a longer name of the class, nothing else', () => {
    const s = lockSlice(input({ groups: { g: ["gamma-x", "gamma-a.b:c"] } }));
    expect(s.groups.g).toEqual(["gamma-x", "gamma-a.b:c"]);
    for (const name of ["gamma-", "gammax", "GAMMA-x"]) {
      expect(parse({ groups: { g: [name] } })).toBe(
        `lockSlice: groups.g[0] must be ${E_GROUP} — got ${JSON.stringify(name)}`,
      );
    }
  });

  test("S4: 200 bytes pass, 201 refuse, a 120-byte family member passes", () => {
    const n200 = "a".repeat(200);
    expect(lockSlice(input({ names: [n200] })).names).toEqual([n200]);
    expect(parse({ names: [`${n200}b`] })).toBe(
      `lockSlice: names[0] must be ${E_ENTRY} — got ${JSON.stringify(`${n200}b`)}`,
    );
    const member = `gamma-${"m".repeat(114)}`;
    expect(member).toHaveLength(120);
    expect(lockSlice(input({ groups: { g: [member] } })).groups.g).toEqual([member]);
    // A prefix entry counts its star: 200 bytes in all.
    expect(lockSlice(input({ names: [`${"p".repeat(199)}*`] })).names).toHaveLength(1);
  });

  test("S5: an exact name its own family does not admit passes; overlap refuses", () => {
    expect(lockSlice(input({ names: ["alpha", "alpha-*"] })).names).toEqual(["alpha", "alpha-*"]);
    expect(parse({ names: ["alpha-*", "alpha-b"] })).toBe(
      `lockSlice: names[1] must be ${E_UNIQUE} — got "alpha-b"`,
    );
    expect(parse({ names: ["alpha-b", "alpha-*"] })).toBe(
      `lockSlice: names[1] must be ${E_UNIQUE} — got "alpha-*"`,
    );
    expect(parse({ names: ["al-*", "al-b-*"] })).toBe(
      `lockSlice: names[1] must be ${E_UNIQUE} — got "al-b-*"`,
    );
    expect(parse({ names: ["al-b-*", "al-*"] })).toBe(
      `lockSlice: names[1] must be ${E_UNIQUE} — got "al-*"`,
    );
  });

  test("S6: a group refuses a family, an unadmitted name, and a repeat", () => {
    for (const [list, i, bad] of [
      [["gamma-*"], 0, "gamma-*"],
      [["delta-sync"], 0, "delta-sync"],
      [["alpha-sync", "alpha-sync"], 1, "alpha-sync"],
    ] as const) {
      expect(parse({ groups: { writers: list } })).toBe(
        `lockSlice: groups.writers[${i}] must be ${E_GROUP} — got ${JSON.stringify(bad)}`,
      );
    }
    const s = lockSlice(
      input({ groups: { writers: ["beta-sync", "alpha-sync"], all: ["gamma-q"] } }),
    );
    expect(s.groups).toEqual({ writers: ["beta-sync", "alpha-sync"], all: ["gamma-q"] });
  });
});

describe("S7: withNames", () => {
  const slice = lockSlice(input({ groups: { writers: ["alpha-sync"] } }));

  test("appends through the same parser and leaves every other field equal", () => {
    const wide = withNames(slice, ["delta-sync", "t-*"]);
    expect(wide.names).toEqual(["alpha-sync", "beta-sync", "gamma-*", "delta-sync", "t-*"]);
    const { names: _a, ...rest } = wide;
    const { names: _b, ...before } = slice;
    expect(rest).toEqual(before);
    expect(slice.names).toHaveLength(3);
  });

  test("refuses an extra name an existing entry already admits", () => {
    expect(refusal(() => withNames(slice, ["gamma-x"]))).toBe(
      `lockSlice: names[3] must be ${E_UNIQUE} — got "gamma-x"`,
    );
    expect(refusal(() => withNames(slice, ["alpha-sync"]))).toBe(
      `lockSlice: names[3] must be ${E_UNIQUE} — got "alpha-sync"`,
    );
  });

  test("refuses a slice lockSlice did not build", () => {
    const fake = { ...slice } as LockSlice;
    expect(refusal(() => withNames(fake, ["delta-sync"]))).toBe(
      "withNames: expected a LockSlice built by lockSlice() — got an object that parser did not return",
    );
  });

  test("a slice withNames built is a slice withNames accepts", () => {
    expect(withNames(withNames(slice, ["delta-sync"]), ["epsilon"]).names).toHaveLength(5);
  });
});

describe("S8: the table default", () => {
  test("rootstock.run_locks, or the given default schema; a partial table fills the rest", () => {
    expect(lockSlice(BASE).table).toEqual({ schema: "rootstock", name: "run_locks" });
    expect(lockSlice(BASE, { schema: "rs_a" }).table).toEqual({
      schema: "rs_a",
      name: "run_locks",
    });
    expect(lockSlice(input({ table: { name: "locks_o" } }), { schema: "rs_a" }).table).toEqual({
      schema: "rs_a",
      name: "locks_o",
    });
    expect(lockSlice(input({ table: { schema: "public" } })).table).toEqual({
      schema: "public",
      name: "run_locks",
    });
  });

  test("groups default to {}", () => {
    expect(lockSlice(BASE).groups).toEqual({});
  });
});

describe("S9: deep-frozen", () => {
  test("every level is frozen, and mutating names throws in strict mode", () => {
    const s = lockSlice(input({ groups: { writers: ["alpha-sync"] } }));
    for (const v of [s, s.table, s.names, s.groups, s.groups.writers, s.wait]) {
      expect(Object.isFrozen(v)).toBe(true);
    }
    expect(() => {
      (s.names as string[]).push("delta-sync");
    }).toThrow(TypeError);
  });

  test("names and groups keep input order", () => {
    const s = lockSlice(
      input({ names: ["z-sync", "a-sync"], groups: { b: ["z-sync"], a: ["a-sync"] } }),
    );
    expect(s.names).toEqual(["z-sync", "a-sync"]);
    expect(Object.keys(s.groups)).toEqual(["b", "a"]);
  });
});
