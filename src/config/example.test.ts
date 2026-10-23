import { describe, expect, test } from "bun:test";
import { concurrencySlice } from "../concurrency/index.ts";
import { clientSlice } from "../db/index.ts";
import { migrateSlice } from "../migrate/index.ts";
import { composeRootstockConfig, type Invariant, type RootstockConfigInput } from "./define.ts";
import { widthBelowPool } from "./invariants.ts";
import { printRootstockConfig } from "./print.ts";
import type {
  ClientInput,
  ClientSlice,
  ConcurrencyInput,
  ConcurrencySlice,
  MigrateInput,
  MigrateSlice,
  SliceParsers,
} from "./slices.ts";

const parsers: SliceParsers = { clientSlice, migrateSlice, concurrencySlice };

// The one test double: each parser copies its input and returns it unfrozen
// and unbranded, so the freezes nested-frozen observes are config's own and
// print can be handed a slice that holds more than its frozen fields. The
// casts are what let a plain object stand in for a branded slice.
const unfrozen = {
  clientSlice: (input: ClientInput) =>
    ({
      profiles: Object.fromEntries(Object.entries(input.profiles).map(([k, p]) => [k, { ...p }])),
    }) as unknown as ClientSlice,
  migrateSlice: (input: MigrateInput) =>
    ({ schema: input.schema ?? "rootstock", ahead: input.ahead }) as unknown as MigrateSlice,
  concurrencySlice: (input: ConcurrencyInput) =>
    ({
      widths: Object.fromEntries(Object.entries(input.widths).map(([k, w]) => [k, { ...w }])),
    }) as unknown as ConcurrencySlice,
} satisfies SliceParsers;

const define = (input: RootstockConfigInput) => composeRootstockConfig(parsers, input);

const exampleInput: RootstockConfigInput = {
  client: {
    profiles: {
      app: {
        max: 5,
        maxCeiling: 20,
        idleTimeoutSeconds: 20,
        maxLifetimeSeconds: 600,
        connectTimeoutSeconds: 30,
        prepare: "driver-default",
        keepAliveSeconds: "driver-default",
        statementTimeoutMs: 0,
        readOnly: false,
      },
      reader: {
        max: "driver-default",
        maxCeiling: 4,
        idleTimeoutSeconds: "driver-default",
        maxLifetimeSeconds: "never",
        connectTimeoutSeconds: "driver-default",
        prepare: false,
        keepAliveSeconds: 60,
        statementTimeoutMs: 30000,
        readOnly: true,
      },
    },
  },
  migrate: { ahead: "refuse" },
  concurrency: {
    widths: {
      fetch: { default: 4, max: 4 },
      write: { default: 2, max: 8 },
    },
  },
  // Not in sorted order, so the print is seen to keep input order.
  invariants: [widthBelowPool("fetch", "app"), { id: "app-pool-sane", check: () => null }],
};

const EXAMPLE_PRINT = `{
  "client": {
    "profiles": {
      "app": {
        "connectTimeoutSeconds": 30,
        "idleTimeoutSeconds": 20,
        "keepAliveSeconds": "driver-default",
        "max": 5,
        "maxCeiling": 20,
        "maxLifetimeSeconds": 600,
        "prepare": "driver-default",
        "readOnly": false,
        "statementTimeoutMs": 0
      },
      "reader": {
        "connectTimeoutSeconds": "driver-default",
        "idleTimeoutSeconds": "driver-default",
        "keepAliveSeconds": 60,
        "max": "driver-default",
        "maxCeiling": 4,
        "maxLifetimeSeconds": "never",
        "prepare": false,
        "readOnly": true,
        "statementTimeoutMs": 30000
      }
    }
  },
  "concurrency": {
    "widths": {
      "fetch": {
        "default": 4,
        "max": 4
      },
      "write": {
        "default": 2,
        "max": 8
      }
    }
  },
  "embed": "absent",
  "invariants": [
    "width-below-pool.fetch.app",
    "app-pool-sane"
  ],
  "lock": "absent",
  "migrate": {
    "ahead": "refuse",
    "schema": "rootstock"
  },
  "queue": "absent",
  "runner": "absent"
}
`;

/** The whole message of what `fn` throws, so a test can pin it with toBe. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a throw");
}

const UNBRANDED =
  "printRootstockConfig: expected a RootstockConfig built by defineRootstockConfig() — got an object that parser did not return";

const holds = (id: string): Invariant => ({ id, check: () => null });
const fails = (id: string, message: string): Invariant => ({ id, check: () => message });

describe("print", () => {
  test("example-print-pinned", () => {
    expect(printRootstockConfig(define(exampleInput))).toBe(EXAMPLE_PRINT);
  });

  test("absent-slices-printed", () => {
    const view = JSON.parse(printRootstockConfig(define(exampleInput)));
    for (const name of ["embed", "lock", "queue", "runner"]) expect(view[name]).toBe("absent");
  });

  test("print-carries-no-url-host-or-credential", () => {
    const view = JSON.parse(printRootstockConfig(define(exampleInput)));
    const text = JSON.stringify(view);
    expect(text).not.toContain("://");
    expect(text).not.toContain("@");
    const hostLike = /[a-z0-9-]+\.[a-z]{2,}(?![a-z0-9_])/i;
    const offenders: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") {
        if (hostLike.test(v)) offenders.push(v);
      } else if (v !== null && typeof v === "object") {
        for (const child of Object.values(v)) walk(child);
      }
    };
    // Invariant ids are dotted by design, so only their array is exempt.
    const { invariants: _ids, ...rest } = view;
    walk(rest);
    expect(offenders).toEqual([]);
  });

  test("swapped-schema-changes-only-migrate-schema", () => {
    const schema = "rs_t_0a1b2c3d";
    const before = printRootstockConfig(define(exampleInput)).split("\n");
    const after = printRootstockConfig(
      define({ ...exampleInput, migrate: { ...exampleInput.migrate, schema } }),
    ).split("\n");
    expect(after.length).toBe(before.length);
    const changed = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
    expect(changed).toEqual([['    "schema": "rootstock"', `    "schema": "${schema}"`]]);
  });

  test("unbranded-config-refused", () => {
    const real = define(exampleInput);
    const copy = { ...real };
    expect(messageOf(() => printRootstockConfig(copy))).toBe(UNBRANDED);
  });

  test("print keeps only the frozen fields a parser hands back", () => {
    const leaky = {
      ...unfrozen,
      clientSlice: (input: ClientInput) => {
        const slice = unfrozen.clientSlice(input);
        for (const p of Object.values(slice.profiles)) {
          Object.assign(p, { url: ["postgres://u:p", "db.example.com/x"].join("@") });
        }
        return slice;
      },
      concurrencySlice: (input: ConcurrencyInput) => {
        const slice = unfrozen.concurrencySlice(input);
        for (const w of Object.values(slice.widths)) Object.assign(w, { secret: "token" });
        return slice;
      },
    } satisfies SliceParsers;
    expect(printRootstockConfig(composeRootstockConfig(leaky, exampleInput))).toBe(EXAMPLE_PRINT);
  });

  test("print carries ahead as configured", () => {
    const view = JSON.parse(
      printRootstockConfig(
        define({ ...exampleInput, migrate: { ...exampleInput.migrate, ahead: "allow" } }),
      ),
    );
    expect(view.migrate.ahead).toBe("allow");
  });

  test("unbranded-slice-refused", () => {
    const slice = migrateSlice({ ahead: "refuse" });
    // biome-ignore lint/suspicious/noExplicitAny: an unbranded object on purpose
    expect(messageOf(() => printRootstockConfig(slice as any))).toBe(UNBRANDED);
  });
});

describe("define", () => {
  test("calls-parsers-in-order-and-propagates-their-errors", () => {
    const calls: string[] = [];
    const boom = new Error("migrateSlice: ahead is required");
    const spy: SliceParsers = {
      clientSlice: (i) => {
        calls.push("client");
        return clientSlice(i);
      },
      migrateSlice: () => {
        calls.push("migrate");
        throw boom;
      },
      concurrencySlice: (i) => {
        calls.push("concurrency");
        return concurrencySlice(i);
      },
    };
    let caught: unknown;
    try {
      composeRootstockConfig(spy, exampleInput);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(calls).toEqual(["client", "migrate"]);
  });

  test("invariant-ids-recorded-in-order", () => {
    const config = define({ ...exampleInput, invariants: [holds("b.two"), holds("a.one")] });
    expect(config.invariants).toEqual(["b.two", "a.one"]);
  });

  test("no-invariants-means-empty-list", () => {
    const { invariants: _, ...rest } = exampleInput;
    expect(define(rest).invariants).toEqual([]);
  });

  test("two-invariants-both-reported", () => {
    const input = {
      ...exampleInput,
      invariants: [fails("first.one", "x is wrong"), holds("ok"), fails("second", "y is wrong")],
    };
    expect(messageOf(() => define(input))).toBe(
      "defineRootstockConfig: 2 invariant(s) failed — first.one: x is wrong; second: y is wrong",
    );
  });

  test("throwing-invariant-is-a-failure", () => {
    const throwing: Invariant = {
      id: "throws",
      check: () => {
        throw new Error("cannot read max");
      },
    };
    expect(messageOf(() => define({ ...exampleInput, invariants: [throwing] }))).toBe(
      "defineRootstockConfig: 1 invariant(s) failed — throws: cannot read max",
    );
  });

  test("invariant-sees-the-assembled-config", () => {
    let seen: unknown;
    const spy: Invariant = {
      id: "spy",
      check: (config) => {
        seen = config.migrate.schema;
        return null;
      },
    };
    define({ ...exampleInput, invariants: [spy] });
    expect(seen).toBe("rootstock");
  });

  test("duplicate-invariant-id-refused", () => {
    let ran = false;
    const marker: Invariant = {
      id: "dup",
      check: () => {
        ran = true;
        return null;
      },
    };
    expect(messageOf(() => define({ ...exampleInput, invariants: [marker, holds("dup")] }))).toBe(
      'defineRootstockConfig: invariant id "dup" must match [a-z0-9][a-z0-9.-]* and be unique',
    );
    expect(ran).toBe(false);
  });

  test.each(["", "Upper", ".lead", "under_score", "sp ace"])(
    "bad-invariant-id %p refused",
    (id) => {
      expect(messageOf(() => define({ ...exampleInput, invariants: [holds(id)] }))).toBe(
        `defineRootstockConfig: invariant id ${JSON.stringify(id)} must match [a-z0-9][a-z0-9.-]* and be unique`,
      );
    },
  );

  test("nested-frozen", () => {
    // The double hands back unfrozen slices, so every freeze here is config's.
    const config = composeRootstockConfig(unfrozen, exampleInput);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.invariants)).toBe(true);
    const app = config.client.profiles.app as { max: unknown };
    expect(() => {
      app.max = 99;
    }).toThrow(TypeError);
    const fetch = config.concurrency.widths.fetch as { max: unknown };
    expect(() => {
      fetch.max = 99;
    }).toThrow(TypeError);
    expect(() => {
      (config.migrate as { schema: string }).schema = "other";
    }).toThrow(TypeError);
  });

  test("input-left-unfrozen", () => {
    define(exampleInput);
    expect(Object.isFrozen(exampleInput.client.profiles.app)).toBe(false);
    expect(Object.isFrozen(exampleInput.concurrency.widths.fetch)).toBe(false);
    expect(Object.isFrozen(exampleInput.migrate)).toBe(false);
  });
});

describe("brand and failure paths", () => {
  test("check-may-print-the-config-it-judges", () => {
    let printed = "";
    let frozen = false;
    const peek: Invariant = {
      id: "peek",
      check: (config) => {
        printed = printRootstockConfig(config);
        frozen = Object.isFrozen(config) && Object.isFrozen(config.client.profiles.app);
        return null;
      },
    };
    define({ ...exampleInput, invariants: [peek] });
    expect(JSON.parse(printed).invariants).toEqual(["peek"]);
    expect(frozen).toBe(true);
  });

  test("failed-build-takes-the-brand-back", () => {
    let kept: unknown;
    const stash: Invariant = {
      id: "stash",
      check: (config) => {
        kept = config;
        return "no";
      },
    };
    expect(messageOf(() => define({ ...exampleInput, invariants: [stash] }))).toBe(
      "defineRootstockConfig: 1 invariant(s) failed — stash: no",
    );
    // biome-ignore lint/suspicious/noExplicitAny: the config a failed build leaked
    expect(messageOf(() => printRootstockConfig(kept as any))).toBe(UNBRANDED);
  });

  test("unprintable-throw-still-reported-and-brand-taken-back", () => {
    let kept: unknown;
    const odd: Invariant = {
      id: "odd",
      check: (config) => {
        kept = config;
        throw Object.create(null);
      },
    };
    expect(
      messageOf(() => define({ ...exampleInput, invariants: [odd, fails("next", "x")] })),
    ).toBe(
      "defineRootstockConfig: 2 invariant(s) failed — odd: a value that cannot be printed; next: x",
    );
    // biome-ignore lint/suspicious/noExplicitAny: the config a failed build leaked
    expect(messageOf(() => printRootstockConfig(kept as any))).toBe(UNBRANDED);
  });

  test("slices-keep-the-parsers-identity", () => {
    // A slice's brand lives in its own subpath's registry, so a copy here
    // would be refused by every function that takes that slice.
    const made: Record<string, unknown> = {};
    const recording = {
      clientSlice: (i: ClientInput) => (made.client = clientSlice(i)),
      migrateSlice: (i: MigrateInput) => (made.migrate = migrateSlice(i)),
      concurrencySlice: (i: ConcurrencyInput) => (made.concurrency = concurrencySlice(i)),
    } satisfies SliceParsers;
    const config = composeRootstockConfig(recording, exampleInput);
    expect(config.client).toBe(made.client as typeof config.client);
    expect(config.migrate).toBe(made.migrate as typeof config.migrate);
    expect(config.concurrency).toBe(made.concurrency as typeof config.concurrency);
  });

  test("thrown-values-ride-as-cause", () => {
    const first = new TypeError("cannot read max");
    const thrower: Invariant = {
      id: "thrower",
      check: () => {
        throw first;
      },
    };
    let caught: unknown;
    try {
      define({ ...exampleInput, invariants: [thrower, fails("plain", "x")] });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).cause).toEqual([first]);
    expect(((caught as Error).cause as unknown[])[0]).toBe(first);
  });

  test("a-throwing-message-getter-does-not-hide-other-failures", () => {
    const hostile = {
      id: "hostile",
      check: () => {
        const err = new Error("x");
        Object.defineProperty(err, "message", {
          get() {
            throw new Error("getter boom");
          },
        });
        throw err;
      },
    };
    expect(
      messageOf(() => define({ ...exampleInput, invariants: [fails("first", "x bad"), hostile] })),
    ).toBe(
      "defineRootstockConfig: 2 invariant(s) failed — first: x bad; hostile: a value that cannot be printed",
    );
  });

  test("async-check-is-a-failure-and-its-rejection-is-handled", async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const asyncCheck = {
        id: "async",
        check: async () => {
          throw new Error("late");
        },
      } as unknown as Invariant;
      expect(messageOf(() => define({ ...exampleInput, invariants: [asyncCheck] }))).toBe(
        "defineRootstockConfig: 1 invariant(s) failed — async: check returned a Promise; checks must be synchronous",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("non-error-throw-and-empty-message-are-failures", () => {
    const throwsText: Invariant = {
      id: "text",
      check: () => {
        throw "plain text";
      },
    };
    expect(
      messageOf(() => define({ ...exampleInput, invariants: [throwsText, fails("empty", "")] })),
    ).toBe("defineRootstockConfig: 2 invariant(s) failed — text: plain text; empty: ");
  });

  test("a check that throws null or returns undefined did not hold", () => {
    const throwsNull: Invariant = {
      id: "null",
      check: () => {
        throw null;
      },
    };
    const noReturn = { id: "none", check: () => undefined } as unknown as Invariant;
    expect(messageOf(() => define({ ...exampleInput, invariants: [throwsNull, noReturn] }))).toBe(
      "defineRootstockConfig: 2 invariant(s) failed — null: null; none: undefined",
    );
  });

  test("an error whose message is not text is still reported", () => {
    const err = new Error("x");
    Object.defineProperty(err, "message", { value: Symbol("odd") });
    const odd: Invariant = {
      id: "odd",
      check: () => {
        throw err;
      },
    };
    expect(
      messageOf(() => define({ ...exampleInput, invariants: [odd, fails("other", "no")] })),
    ).toBe("defineRootstockConfig: 2 invariant(s) failed — odd: Symbol(odd); other: no");
  });

  test("a one-shot invariants iterable is refused, not half-consumed", () => {
    function* once(): Generator<Invariant> {
      yield fails("gen", "ran");
    }
    const invariants = once() as unknown as Invariant[];
    expect(messageOf(() => define({ ...exampleInput, invariants }))).toBe(
      "defineRootstockConfig: invariants must be an array — got [object Generator]",
    );
  });

  test("an unknown top-level key is refused without echoing its value", () => {
    const typo = { ...exampleInput, invariant: [fails("never", "ran")] } as RootstockConfigInput;
    expect(messageOf(() => define(typo))).toBe(
      "defineRootstockConfig: invariant is not a known key",
    );
  });

  test("invariants that are not an array are refused", () => {
    for (const [value, got] of [
      [null, "null"],
      ["ab", "ab"],
      [{}, "[object Object]"],
    ] as const) {
      const input = { ...exampleInput, invariants: value } as unknown as RootstockConfigInput;
      expect(messageOf(() => define(input))).toBe(
        `defineRootstockConfig: invariants must be an array — got ${got}`,
      );
    }
  });

  test("a null invariant is refused by its id", () => {
    const input = { ...exampleInput, invariants: [null] } as unknown as RootstockConfigInput;
    expect(messageOf(() => define(input))).toBe(
      "defineRootstockConfig: invariant id undefined must match [a-z0-9][a-z0-9.-]* and be unique",
    );
  });

  test("no cause when no check threw", () => {
    let caught: unknown;
    try {
      define({ ...exampleInput, invariants: [fails("plain", "no")] });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).cause).toBeUndefined();
  });

  test("invariant-without-a-string-id-refused", () => {
    const noId = { check: () => null } as unknown as Invariant;
    expect(messageOf(() => define({ ...exampleInput, invariants: [noId] }))).toBe(
      "defineRootstockConfig: invariant id undefined must match [a-z0-9][a-z0-9.-]* and be unique",
    );
    const numeric = { id: 7, check: () => null } as unknown as Invariant;
    expect(messageOf(() => define({ ...exampleInput, invariants: [numeric] }))).toBe(
      "defineRootstockConfig: invariant id 7 must match [a-z0-9][a-z0-9.-]* and be unique",
    );
  });

  test("parser-errors-come-before-invariant-ids", () => {
    const boom = new Error("concurrencySlice: widths is required");
    const failing = {
      ...parsers,
      concurrencySlice: () => {
        throw boom;
      },
    } as unknown as SliceParsers;
    let caught: unknown;
    try {
      composeRootstockConfig(failing, { ...exampleInput, invariants: [holds("Bad")] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });

  test("hand-built-config-fails-typecheck", () => {
    const real = define(exampleInput);
    const literal = {
      client: real.client,
      migrate: real.migrate,
      concurrency: real.concurrency,
      invariants: [],
    };
    // @ts-expect-error a literal lacks the config brand
    expect(messageOf(() => printRootstockConfig(literal))).toBe(UNBRANDED);
  });
});

describe("widthBelowPool", () => {
  const app = exampleInput.client.profiles.app;
  if (app === undefined) throw new Error("example has no app profile");
  const withWidthMax = (max: number, poolMax: number | "driver-default") => ({
    ...exampleInput,
    client: {
      profiles: {
        ...exampleInput.client.profiles,
        app: { ...app, max: poolMax },
      },
    },
    concurrency: { widths: { ...exampleInput.concurrency.widths, fetch: { default: 1, max } } },
    invariants: [widthBelowPool("fetch", "app")],
  });

  test("id-is-lowercased", () => {
    expect(widthBelowPool("fetchWrite", "App").id).toBe("width-below-pool.fetchwrite.app");
  });

  test("width-below-pool-holds", () => {
    expect(define(withWidthMax(4, 5)).invariants).toEqual(["width-below-pool.fetch.app"]);
  });

  test("width-equal-to-pool-fails", () => {
    expect(messageOf(() => define(withWidthMax(5, 5)))).toBe(
      'defineRootstockConfig: 1 invariant(s) failed — width-below-pool.fetch.app: width "fetch" max 5 must be below profile "app" max 5',
    );
  });

  test("width-above-pool-fails", () => {
    expect(messageOf(() => define(withWidthMax(8, 5)))).toBe(
      'defineRootstockConfig: 1 invariant(s) failed — width-below-pool.fetch.app: width "fetch" max 8 must be below profile "app" max 5',
    );
  });

  test("driver-default-pool-fails", () => {
    expect(messageOf(() => define(withWidthMax(1, "driver-default")))).toBe(
      'defineRootstockConfig: 1 invariant(s) failed — width-below-pool.fetch.app: width "fetch" cannot be checked against profile "app": its max is "driver-default"',
    );
  });

  test("missing-width-or-profile-named", () => {
    const input = {
      ...exampleInput,
      invariants: [widthBelowPool("nope", "app"), widthBelowPool("fetch", "gone")],
    };
    expect(messageOf(() => define(input))).toBe(
      'defineRootstockConfig: 2 invariant(s) failed — width-below-pool.nope.app: no width "nope" is declared; width-below-pool.fetch.gone: no profile "gone" is declared',
    );
  });

  test("inherited-profile-name-is-not-declared", () => {
    expect(
      messageOf(() =>
        define({ ...exampleInput, invariants: [widthBelowPool("fetch", "toString")] }),
      ),
    ).toBe(
      'defineRootstockConfig: 1 invariant(s) failed — width-below-pool.fetch.tostring: no profile "toString" is declared',
    );
  });

  test("inherited-name-is-not-declared", () => {
    expect(
      messageOf(() => define({ ...exampleInput, invariants: [widthBelowPool("toString", "app")] })),
    ).toBe(
      'defineRootstockConfig: 1 invariant(s) failed — width-below-pool.tostring.app: no width "toString" is declared',
    );
  });
});
