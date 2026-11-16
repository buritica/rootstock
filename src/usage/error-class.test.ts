import { describe, expect, test } from "bun:test";
import { CALL_ERROR_CLASSES, errorClassOf } from "./error-class.ts";

class RefusalError extends Error {}

describe("errorClassOf", () => {
  test("names the class, never the message", () => {
    expect(errorClassOf(new TypeError("SECRET"))).toBe("TypeError");
    expect(errorClassOf(new Error("SECRET"))).toBe("Error");
    expect(errorClassOf("a string")).toBe("non-Error throw");
    expect(errorClassOf(undefined)).toBe("non-Error throw");
    // A subclass that sets no name reads as its base: what classify is for.
    expect(errorClassOf(new RefusalError("SECRET"))).toBe("Error");
  });

  test("walks cause past a wrapper with no name, to a driver code or a class", () => {
    const driver = Object.assign(new Error("write CONNECTION_ENDED"), { code: "CONNECTION_ENDED" });
    const wrapped = new Error("Failed query: insert ... params: secret", { cause: driver });
    expect(errorClassOf(wrapped)).toBe("CONNECTION_ENDED");
    expect(errorClassOf(new Error("x", { cause: new RangeError("y") }))).toBe("RangeError");
  });

  test("stops after five hops", () => {
    let e: Error = new RangeError("deep");
    for (let i = 0; i < 5; i++) e = new Error("wrap", { cause: e });
    expect(errorClassOf(e)).toBe("Error");
    expect(errorClassOf(e.cause as Error)).toBe("RangeError");
  });

  test("prefers a SQLSTATE, anywhere in the chain", () => {
    expect(
      errorClassOf(Object.assign(new Error("relation does not exist"), { code: "42P01" })),
    ).toBe("42P01");
    const inner = Object.assign(new TypeError("x"), { code: "23505" });
    expect(errorClassOf(new Error("wrap", { cause: inner }))).toBe("23505");
  });

  test("never throws, even on an error whose accessors do", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("gotcha");
      },
    });
    expect(errorClassOf(hostile)).toBe("unreadable error");
  });

  test("the classify hook answers first; undefined or empty falls through to the walk", () => {
    const classify = (err: unknown) => (err instanceof RefusalError ? "RefusalError" : undefined);
    expect(errorClassOf(new RefusalError("x"), classify)).toBe("RefusalError");
    expect(errorClassOf(new TypeError("x"), classify)).toBe("TypeError");
    expect(errorClassOf(new TypeError("x"), () => "")).toBe("TypeError");
    expect(errorClassOf(Object.assign(new Error("x"), { code: "42P01" }), () => "Mine")).toBe(
      "Mine",
    );
  });

  test("a throwing classify hook reads as unreadable, never a throw", () => {
    expect(
      errorClassOf(new Error("x"), () => {
        throw new Error("hook");
      }),
    ).toBe("unreadable error");
  });
});

test("the classes rootstock writes", () => {
  expect([...CALL_ERROR_CLASSES]).toEqual([
    "UnknownTool",
    "InvalidParams",
    "RejectedBeforeHandler",
    "TurnBudgetExhausted",
    "DeadlineExceeded",
    "RateLimited",
    "Busy",
    "ScopeDenied",
  ]);
  expect(Object.isFrozen(CALL_ERROR_CLASSES)).toBe(true);
});
