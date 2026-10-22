import { describe, expect, test } from "bun:test";
import { pgCode } from "./pg-code.ts";

const wrap = (cause: unknown) => new Error("wrapped", { cause });

describe("pgCode", () => {
  test("a postgres.js-shaped error: the SQLSTATE is on code", () => {
    expect(pgCode(Object.assign(new Error("dup"), { code: "23505" }))).toBe("23505");
  });

  test("pgcode-bun-errno: a Bun.SQL-shaped error carries the SQLSTATE on errno", () => {
    const err = Object.assign(new Error("dup"), {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "23505",
    });
    expect(pgCode(err)).toBe("23505");
    expect(pgCode(wrap(err))).toBe("23505");
  });

  test("code wins over errno on the same hop", () => {
    expect(pgCode({ code: "57014", errno: "23505" })).toBe("57014");
  });

  test("a wrapped error is found on its cause", () => {
    expect(pgCode(wrap({ code: "25006" }))).toBe("25006");
  });

  test("pgcode-wrapped-twice: the code two hops down is found", () => {
    expect(pgCode(wrap(wrap({ code: "57014" })))).toBe("57014");
  });

  test("the walk stops at depth 5", () => {
    expect(pgCode(wrap(wrap(wrap(wrap({ code: "23505" })))))).toBe("23505");
    expect(pgCode(wrap(wrap(wrap(wrap(wrap({ code: "23505" }))))))).toBeUndefined();
  });

  test("the first SQLSTATE-shaped code wins, and unshaped codes are passed over", () => {
    expect(pgCode({ code: "ECONNRESET", cause: { code: "08006", cause: { code: "23505" } } })).toBe(
      "08006",
    );
    expect(pgCode({ code: "2350", errno: 5, cause: { code: "abcde" } })).toBeUndefined();
  });

  test("a self-referencing cause stops the walk", () => {
    const err: { code: string; cause?: unknown } = { code: "nope" };
    err.cause = err;
    expect(pgCode(err)).toBeUndefined();
  });

  test("non-objects have no code", () => {
    for (const value of [undefined, null, "23505", 23505, true]) {
      expect(pgCode(value)).toBeUndefined();
    }
  });

  test("pgcode-throwing-accessor: inspection never throws", () => {
    const hostile = {
      get code(): string {
        throw new Error("boom");
      },
    };
    expect(pgCode(hostile)).toBeUndefined();
    expect(pgCode(wrap(hostile))).toBeUndefined();
  });
});
