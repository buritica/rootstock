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
    "postgres:///app_test",
    "postgres://u@/app_test?host=/var/run/postgresql",
    "postgres://u:p@/app_test",
    "postgres://u@%2Fvar%2Frun%2Fpostgresql/app_test",
    "postgres://u@localhost/app_test?host=localhost,127.0.0.1",
  ])("allows %s", (url) => {
    expect(() => assertThrowawayDb(url, DENY)).not.toThrow();
  });

  test("refuses a remote host, naming host and database, with the contract's text and code", () => {
    const r = refusal(() =>
      assertThrowawayDb("postgres://u:secret@db.example.test:5432/app", DENY),
    );
    expect(r.message).toBe(
      'rootstock migrate: refusing to touch "db.example.test"/"app" — host "db.example.test" is not in allowHosts (localhost, 127.0.0.1, ::1); tests run only against a throwaway local database',
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
      assertThrowawayDb("postgres://u@localhost/app_test?host=db.example.test", DENY),
    ).toThrow(/host "db\.example\.test" is not in allowHosts/);
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?hostaddr=10.0.0.5", DENY),
    ).toThrow(/host "10\.0\.0\.5"/);
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?dbname=app_prod", DENY),
    ).toThrow(/"app_prod" is in denyNames/);
  });

  test("one remote host in a list is enough to refuse", () => {
    expect(() =>
      assertThrowawayDb("postgres://u@localhost/app_test?host=localhost,db.example.test", DENY),
    ).toThrow(/host "db\.example\.test"/);
  });

  test("an empty database name is the user's, as libpq defaults it", () => {
    expect(() => assertThrowawayDb("postgres://app_prod@localhost", DENY)).toThrow(
      /"app_prod" is in denyNames/,
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

  test("unsafeAllow skips the refusal and logs on every call", () => {
    const lines: string[] = [];
    const opts = {
      ...DENY,
      unsafeAllow: { reason: "shared CI database", log: (m: string) => lines.push(m) },
    };
    assertThrowawayDb("postgres://u:secret@db.example.test/app_prod", opts);
    assertThrowawayDb("postgres://u@localhost/app_test", opts);
    expect(lines).toEqual([
      'rootstock migrate: assertThrowawayDb skipped for "db.example.test"/"app_prod" — shared CI database',
      'rootstock migrate: assertThrowawayDb skipped for "localhost"/"app_test" — shared CI database',
    ]);
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
