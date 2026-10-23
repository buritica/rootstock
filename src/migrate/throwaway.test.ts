import { describe, expect, test } from "bun:test";
import { assertThrowawayDb } from "./throwaway.ts";

const DENY = { denyNames: ["app_prod"] } as const;

function refusal(run: () => void): { message: string; code: unknown } {
  try {
    run();
  } catch (err) {
    return { message: (err as Error).message, code: (err as { code?: unknown }).code };
  }
  throw new Error("expected a refusal");
}

describe("assertThrowawayDb", () => {
  test.each([
    "postgres://u:p@localhost:5432/app_test",
    "postgresql://u@127.0.0.1/app_test",
    "postgres://u@[::1]:5432/app_test",
    "postgres://u@LOCALHOST/app_test",
    "postgres://u@/app_test?host=/var/run/postgresql",
    "postgres://u:p@/app_test?host=%2Ftmp",
    "postgres://u@%2Fvar%2Frun%2Fpostgresql/app_test",
    "postgres://u@localhost/app_test?host=localhost,127.0.0.1",
  ])("allows %s", (url) => {
    expect(() => assertThrowawayDb(url, DENY)).not.toThrow();
  });

  test("refuses a remote host, naming host and database, with the contract's text and code", () => {
    const r = refusal(() => assertThrowawayDb("postgres://u:secret@remotehost:5432/app", DENY));
    expect(r.message).toBe(
      'rootstock migrate: refusing to touch "remotehost"/"app" — host "remotehost" is not in allowHosts (localhost, 127.0.0.1, ::1); tests run only against a throwaway local database',
    );
    expect(r.code).toBe("ERR_ROOTSTOCK_MIG_NOT_THROWAWAY");
    expect(r.message).not.toContain("secret");
  });

  test("refuses a denied name on a local host, case-insensitively", () => {
    expect(
      refusal(() => assertThrowawayDb("postgres://u@localhost/App_Prod", DENY)).message,
    ).toContain('the database name "App_Prod" is in denyNames');
  });

  test("a host, hostaddr or dbname parameter overrides the URL, as libpq reads it", () => {
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?host=remotehost", DENY),
    ).toThrow(/host "remotehost" is not in allowHosts/);
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?hostaddr=10.0.0.5", DENY),
    ).toThrow(/host "10\.0\.0\.5"/);
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?dbname=app_prod", DENY),
    ).toThrow(/"app_prod" is in denyNames/);
  });

  test("one remote host in a list is enough to refuse", () => {
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?host=localhost,remotehost", DENY),
    ).toThrow(/host "remotehost"/);
  });

  test.each([
    ["no host (PGHOST)", "postgres:///app_test", /names no host, so a driver would use PGHOST/],
    ["an empty host parameter", "postgres:///app_test?host=", /names no host/],
    ["no database (PGDATABASE)", "postgres://app_prod@localhost", /names no database/],
    ["a service parameter", "postgres://u@localhost/app_test?service=prod", /a service parameter/],
  ])("refuses %s, which a driver would fill from outside the URL", (_what, url, message) => {
    expect(() => assertThrowawayDb(url, DENY)).toThrow(message);
  });

  test.each([
    // postgres.js and Bun.SQL connect to the authority and ignore the parameters.
    ["?host=localhost", "postgres://u@remotehost/app_test?host=localhost"],
    ["?hostaddr=127.0.0.1", "postgres://u@remotehost/app_test?hostaddr=127.0.0.1"],
    ["an empty ?host=", "postgres://u@remotehost/app_test?host="],
    ["a socket ?host=", "postgres://u@remotehost/app_test?host=%2Ftmp"],
    // libpq connects to hostaddr when both are given.
    ["host and hostaddr", "postgres://u@localhost/app_test?host=localhost&hostaddr=10.0.0.5"],
    // libpq keeps the last of a repeated key.
    ["a repeated host", "postgres://u@localhost/app_test?host=localhost&host=remotehost"],
    ["an authority host list", "postgres://u@localhost,remotehost/app_test"],
  ])("a parameter never hides the authority, nor a list a host: %s", (_what, url) => {
    expect(() => assertThrowawayDb(url, DENY)).toThrow(/is not in allowHosts/);
  });

  test("every database name counts: the path's and each dbname", () => {
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_prod?dbname=app_test", DENY),
    ).toThrow(/"app_prod" is in denyNames/);
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?dbname=x&dbname=app_prod", DENY),
    ).toThrow(/"app_prod" is in denyNames/);
  });

  test("the option lists compare case-insensitively too", () => {
    expect(() =>
      assertThrowawayDb("postgres://u@pg/app_test", { ...DENY, allowHosts: ["PG"] }),
    ).not.toThrow();
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_prod", { denyNames: ["APP_PROD"] }),
    ).toThrow(/is in denyNames/);
  });

  test("a bad option is a config refusal, not a verdict on the database", () => {
    expect(refusal(() => assertThrowawayDb("postgres:///x", {} as never)).code).toBe(
      "ERR_ROOTSTOCK_MIG_SRC",
    );
  });

  test("allowHosts replaces the default", () => {
    expect(() =>
      assertThrowawayDb("postgres://u@pg/app_test", { ...DENY, allowHosts: ["pg"] }),
    ).not.toThrow();
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test", { ...DENY, allowHosts: ["pg"] }),
    ).toThrow(/not in allowHosts \(pg\)/);
  });

  test.each(["not a url", "mysql://u@localhost/app_test", "https://localhost/app_test"])(
    "refuses %s as unparseable",
    (url) => {
      expect(() => assertThrowawayDb(url, DENY)).toThrow(
        /refusing to touch "\?"\/"\?" — the URL is not a postgres/,
      );
    },
  );

  test("unsafeAllow skips the host check and logs on every call", () => {
    const lines: string[] = [];
    const opts = {
      ...DENY,
      unsafeAllow: { reason: "shared CI database", log: (m: string) => lines.push(m) },
    };
    assertThrowawayDb("postgres://u:secret@remotehost/app_ci", opts);
    assertThrowawayDb("postgres://u@localhost/app_test", opts);
    expect(lines).toEqual([
      'rootstock migrate: assertThrowawayDb skipped the host check for "remotehost"/"app_ci" — shared CI database',
      'rootstock migrate: assertThrowawayDb skipped the host check for "localhost"/"app_test" — shared CI database',
    ]);
  });

  test("unsafeAllow never lets through a denied name, a missing database or an unreadable URL", () => {
    const lines: string[] = [];
    const opts = { ...DENY, unsafeAllow: { reason: "r", log: (m: string) => lines.push(m) } };
    expect(() => assertThrowawayDb("postgres://u@remotehost/app_prod", opts)).toThrow(
      /is in denyNames/,
    );
    expect(() => assertThrowawayDb("postgres://app_prod@remotehost", opts)).toThrow(
      /names no database/,
    );
    expect(() => assertThrowawayDb("not a url", opts)).toThrow(/that parses/);
    expect(lines).toEqual([]);
  });

  test("refuses malformed options", () => {
    expect(() => assertThrowawayDb("postgres:///x", {} as never)).toThrow(
      /denyNames must be an array of strings/,
    );
    expect(() =>
      assertThrowawayDb("postgres:///x", { denyNames: [], allowHosts: "localhost" } as never),
    ).toThrow(/allowHosts must be an array/);
    expect(() =>
      assertThrowawayDb("postgres:///x", {
        denyNames: [],
        unsafeAllow: { reason: " ", log: () => {} },
      }),
    ).toThrow(/unsafeAllow needs a non-empty reason/);
  });
});
