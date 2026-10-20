import { describe, expect, test } from "bun:test";
import {
  bunSqlOptions,
  type ClientSlice,
  type ConnectionProfileInput,
  clientSlice,
  postgresJsOptions,
} from "./client-slice.ts";

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "(did not throw)";
}

// Every field set to a number or boolean.
const APP: ConnectionProfileInput = {
  max: 5,
  maxCeiling: 8,
  idleTimeoutSeconds: 20,
  maxLifetimeSeconds: 1800,
  connectTimeoutSeconds: 10,
  prepare: false,
  keepAliveSeconds: 60,
  statementTimeoutMs: 0,
  readOnly: false,
};

// Every field that can be "driver-default" is.
const READER: ConnectionProfileInput = {
  max: "driver-default",
  maxCeiling: 10,
  idleTimeoutSeconds: "driver-default",
  maxLifetimeSeconds: "driver-default",
  connectTimeoutSeconds: "driver-default",
  prepare: "driver-default",
  keepAliveSeconds: "driver-default",
  statementTimeoutMs: 0,
  readOnly: false,
};

const slice = (profiles: Record<string, ConnectionProfileInput>) => clientSlice({ profiles });
const one = (overrides: Partial<Record<keyof ConnectionProfileInput, unknown>>) =>
  slice({ app: { ...APP, ...overrides } as ConnectionProfileInput });

describe("clientSlice", () => {
  test("returns the profiles deep-frozen", () => {
    const s = slice({ app: APP, reader: READER });
    expect(s.profiles).toEqual({ app: APP, reader: READER });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.profiles)).toBe(true);
    expect(Object.isFrozen(s.profiles.app)).toBe(true);
  });

  test("copies its input, so a later edit to the input changes nothing", () => {
    const input = { ...APP };
    const s = slice({ app: input });
    input.max = 1;
    expect(s.profiles.app?.max).toBe(5);
  });

  for (const field of Object.keys(APP) as (keyof ConnectionProfileInput)[]) {
    test(`profile-field-required.${field}`, () => {
      const { [field]: _dropped, ...rest } = APP;
      expect(messageOf(() => slice({ app: rest as ConnectionProfileInput }))).toBe(
        `clientSlice: profiles.app.${field} is required`,
      );
      expect(messageOf(() => one({ [field]: undefined }))).toBe(
        `clientSlice: profiles.app.${field} is required`,
      );
    });
  }

  test("a missing profiles is required", () => {
    expect(messageOf(() => clientSlice({} as never))).toBe("clientSlice: profiles is required");
  });

  test("profiles must hold at least one profile", () => {
    for (const profiles of [{}, [], "app", null]) {
      expect(messageOf(() => clientSlice({ profiles } as never))).toBe(
        `clientSlice: profiles must be an object with at least one profile — got ${JSON.stringify(profiles)}`,
      );
    }
  });

  test("profile names match [a-z][a-z0-9-]*", () => {
    for (const name of ["App", "1app", "_app", "app_read", ""]) {
      expect(messageOf(() => slice({ [name]: APP }))).toBe(
        `clientSlice: profiles.${name} must be a name matching [a-z][a-z0-9-]* — got ${JSON.stringify(name)}`,
      );
    }
    expect(slice({ "read-1": APP }).profiles["read-1"]).toEqual(APP);
  });

  const INVALID: [keyof ConnectionProfileInput, unknown, string][] = [
    ["max", 0, 'an integer >= 1 or "driver-default"'],
    ["max", 1.5, 'an integer >= 1 or "driver-default"'],
    ["max", "never", 'an integer >= 1 or "driver-default"'],
    ["maxCeiling", 0, "an integer >= 1 and >= max"],
    ["maxCeiling", "driver-default", "an integer >= 1 and >= max"],
    ["maxCeiling", 4, "an integer >= 1 and >= max"],
    ["idleTimeoutSeconds", -1, 'an integer >= 0 or "driver-default"'],
    ["idleTimeoutSeconds", "never", 'an integer >= 0 or "driver-default"'],
    ["maxLifetimeSeconds", 0.5, 'an integer >= 0, "never" or "driver-default"'],
    ["maxLifetimeSeconds", null, 'an integer >= 0, "never" or "driver-default"'],
    ["connectTimeoutSeconds", Number.NaN, 'an integer >= 0 or "driver-default"'],
    ["keepAliveSeconds", "60", 'an integer >= 0 or "driver-default"'],
    ["statementTimeoutMs", -5, "an integer >= 0"],
    ["statementTimeoutMs", "driver-default", "an integer >= 0"],
    ["prepare", "false", 'a boolean or "driver-default"'],
    ["readOnly", "driver-default", "a boolean"],
    ["readOnly", 0, "a boolean"],
  ];
  for (const [field, value, expected] of INVALID) {
    test(`${field} = ${JSON.stringify(value)} is refused with E-SLICE-VAL`, () => {
      expect(messageOf(() => one({ [field]: value }))).toBe(
        `clientSlice: profiles.app.${field} must be ${expected} — got ${JSON.stringify(value)}`,
      );
    });
  }

  test("maxCeiling equal to max, or any ceiling over a driver-default max, is accepted", () => {
    expect(one({ maxCeiling: 5 }).profiles.app?.maxCeiling).toBe(5);
    expect(one({ max: "driver-default", maxCeiling: 1 }).profiles.app?.maxCeiling).toBe(1);
  });

  test("unknown keys are refused, in a profile and at the top", () => {
    expect(messageOf(() => one({ ssl: true } as never))).toBe(
      "clientSlice: profiles.app.ssl must be a known key — got true",
    );
    expect(messageOf(() => clientSlice({ profiles: { app: APP }, url: "x" } as never))).toBe(
      'clientSlice: url must be a known key — got "x"',
    );
  });

  test("unbranded-slice-refused", () => {
    const real = slice({ app: APP });
    const lookalikes = [{ profiles: { app: APP } }, { ...real }, Object.freeze({ ...real })];
    for (const fake of lookalikes) {
      for (const [fn, render] of [
        ["postgresJsOptions", postgresJsOptions],
        ["bunSqlOptions", bunSqlOptions],
      ] as const) {
        expect(messageOf(() => render(fake as unknown as ClientSlice, "app"))).toBe(
          `${fn}: expected a ClientSlice built by clientSlice() — got an object that parser did not return`,
        );
      }
    }
  });
});

describe("renderers", () => {
  const S = slice({ app: APP, reader: READER });

  test("an unknown profile is refused with E-PROFILE", () => {
    expect(messageOf(() => postgresJsOptions(S, "writer"))).toBe(
      'postgresJsOptions: no connection profile "writer" — declared: app, reader',
    );
    expect(messageOf(() => bunSqlOptions(S, "toString"))).toBe(
      'bunSqlOptions: no connection profile "toString" — declared: app, reader',
    );
  });

  test("postgres.js: every field set", () => {
    expect(postgresJsOptions(S, "app")).toEqual({
      max: 5,
      idle_timeout: 20,
      max_lifetime: 1800,
      connect_timeout: 10,
      prepare: false,
      keep_alive: 60,
    });
  });

  test("postgres-js-no-connection-key: an all-default profile renders {}", () => {
    const out = postgresJsOptions(S, "reader");
    expect(out).toEqual({});
    expect(Object.keys(out)).toEqual([]);
  });

  test("postgres-js-never-lifetime: never renders max_lifetime null", () => {
    expect(postgresJsOptions(one({ maxLifetimeSeconds: "never" }), "app").max_lifetime).toBeNull();
    expect(
      Object.hasOwn(postgresJsOptions(one({ maxLifetimeSeconds: "never" }), "app"), "max_lifetime"),
    ).toBe(true);
  });

  test("Bun.SQL: every field set except keep-alive", () => {
    const s = one({ keepAliveSeconds: "driver-default" });
    expect(bunSqlOptions(s, "app")).toEqual({
      max: 5,
      idleTimeout: 20,
      maxLifetime: 1800,
      connectionTimeout: 10,
      prepare: false,
    });
    expect(bunSqlOptions(S, "reader")).toEqual({});
    expect(
      bunSqlOptions(one({ keepAliveSeconds: "driver-default", maxLifetimeSeconds: "never" }), "app")
        .maxLifetime,
    ).toBe(0);
  });

  test("Bun.SQL refuses a profile that sets keepAliveSeconds", () => {
    for (const keepAliveSeconds of [60, 0]) {
      expect(messageOf(() => bunSqlOptions(one({ keepAliveSeconds }), "app"))).toBe(
        'bunSqlOptions: profile "app" sets keepAliveSeconds, which Bun.SQL has no option for — use "driver-default"',
      );
    }
  });

  // One field at a time switched from READER's driver-default to a value.
  const FIELD_CASES: [
    keyof ConnectionProfileInput,
    unknown,
    Record<string, unknown>,
    Record<string, unknown>,
  ][] = [
    ["max", 3, { max: 3 }, { max: 3 }],
    ["idleTimeoutSeconds", 0, { idle_timeout: 0 }, { idleTimeout: 0 }],
    ["idleTimeoutSeconds", 30, { idle_timeout: 30 }, { idleTimeout: 30 }],
    ["maxLifetimeSeconds", 0, { max_lifetime: 0 }, { maxLifetime: 0 }],
    ["maxLifetimeSeconds", 600, { max_lifetime: 600 }, { maxLifetime: 600 }],
    ["maxLifetimeSeconds", "never", { max_lifetime: null }, { maxLifetime: 0 }],
    ["connectTimeoutSeconds", 5, { connect_timeout: 5 }, { connectionTimeout: 5 }],
    ["prepare", true, { prepare: true }, { prepare: true }],
    ["prepare", false, { prepare: false }, { prepare: false }],
    ["statementTimeoutMs", 0, {}, {}],
    [
      "statementTimeoutMs",
      250,
      { connection: { statement_timeout: 250 } },
      { connection: { statement_timeout: 250 } },
    ],
    ["readOnly", false, {}, {}],
    [
      "readOnly",
      true,
      { connection: { default_transaction_read_only: true } },
      { connection: { default_transaction_read_only: true } },
    ],
  ];
  for (const [field, value, pg, bun] of FIELD_CASES) {
    test(`${field} = ${JSON.stringify(value)} renders its key, alone`, () => {
      const s = slice({ app: { ...READER, [field]: value } });
      expect(postgresJsOptions(s, "app")).toEqual(pg);
      expect(bunSqlOptions(s, "app")).toEqual(bun);
    });
  }

  test("keepAliveSeconds renders keep_alive for postgres.js", () => {
    expect(postgresJsOptions(slice({ app: { ...READER, keepAliveSeconds: 0 } }), "app")).toEqual({
      keep_alive: 0,
    });
  });

  test("statement timeout and read-only share one connection object", () => {
    const s = slice({ app: { ...READER, statementTimeoutMs: 100, readOnly: true } });
    const connection = { statement_timeout: 100, default_transaction_read_only: true };
    expect(postgresJsOptions(s, "app")).toEqual({ connection });
    expect(bunSqlOptions(s, "app")).toEqual({ connection });
    expect(postgresJsOptions(s, "app", { statementTimeoutMs: 0 })).toEqual({
      connection: { default_transaction_read_only: true },
    });
    const writer = slice({ app: { ...READER, statementTimeoutMs: 100 } });
    expect(postgresJsOptions(writer, "app", { statementTimeoutMs: 0 })).toEqual({});
  });

  test("a call statement timeout overrides the profile's", () => {
    const s = slice({ app: { ...READER, statementTimeoutMs: 100 } });
    expect(bunSqlOptions(s, "app", { statementTimeoutMs: 40 })).toEqual({
      connection: { statement_timeout: 40 },
    });
    expect(bunSqlOptions(S, "reader", { statementTimeoutMs: 40 })).toEqual({
      connection: { statement_timeout: 40 },
    });
  });

  test("a call statementTimeoutMs of undefined renders the profile value", () => {
    const s = slice({ app: { ...READER, statementTimeoutMs: 100 } });
    expect(postgresJsOptions(s, "app", { statementTimeoutMs: undefined })).toEqual({
      connection: { statement_timeout: 100 },
    });
  });

  test("a bad call statement timeout is refused with E-CALL-STMT", () => {
    for (const statementTimeoutMs of [-1, 1.5, Number.NaN]) {
      for (const [fn, render] of [
        ["postgresJsOptions", postgresJsOptions],
        ["bunSqlOptions", bunSqlOptions],
      ] as const) {
        expect(messageOf(() => render(S, "reader", { statementTimeoutMs }))).toBe(
          `${fn}: statementTimeoutMs must be a non-negative integer (0 = none) — got ${JSON.stringify(statementTimeoutMs)}`,
        );
      }
    }
  });

  test("call max 1 and maxCeiling are accepted, over a number or a driver-default max", () => {
    expect(postgresJsOptions(S, "app", { max: 1 }).max).toBe(1);
    expect(postgresJsOptions(S, "app", { max: 8 }).max).toBe(8);
    expect(bunSqlOptions(S, "reader", { max: 10 }).max).toBe(10);
    expect(postgresJsOptions(S, "reader", { max: 1 })).toEqual({ max: 1 });
  });

  test("call max undefined renders the profile max", () => {
    expect(postgresJsOptions(S, "app", { max: undefined })).toEqual(postgresJsOptions(S, "app"));
    expect(postgresJsOptions(S, "reader", { max: undefined })).toEqual({});
    expect(bunSqlOptions(S, "reader", {})).toEqual({});
  });

  for (const max of [0, 1.5, Number.NaN, -1]) {
    test(`call max ${max} is refused with E-CALL-MAX`, () => {
      expect(messageOf(() => postgresJsOptions(S, "app", { max }))).toBe(
        `postgresJsOptions: max for profile "app" must be an integer from 1 to 8 — got ${JSON.stringify(max)}`,
      );
    });
  }

  test("call-max-above-ceiling", () => {
    expect(messageOf(() => postgresJsOptions(S, "app", { max: 9 }))).toBe(
      'postgresJsOptions: max for profile "app" must be an integer from 1 to 8 — got 9',
    );
    expect(messageOf(() => bunSqlOptions(S, "reader", { max: 11 }))).toBe(
      'bunSqlOptions: max for profile "reader" must be an integer from 1 to 10 — got 11',
    );
  });

  test("each result is a fresh frozen object with no ssl", () => {
    const s = slice({ app: { ...APP, statementTimeoutMs: 5, keepAliveSeconds: "driver-default" } });
    for (const render of [postgresJsOptions, bunSqlOptions]) {
      const a = render(s, "app");
      const b = render(s, "app");
      expect(a).not.toBe(b);
      expect(a.connection).not.toBe(b.connection);
      expect(Object.isFrozen(a)).toBe(true);
      expect(Object.isFrozen(a.connection)).toBe(true);
      expect("ssl" in a).toBe(false);
    }
  });
});
