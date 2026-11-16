// serve declares the part of serve/auth's AuthLayer it calls structurally,
// because serve may not import serve/auth. This pins the real type to it, so
// a change on either side fails typecheck here. A type-only import: nothing
// of Better Auth loads.

import { expect, test } from "bun:test";
import type { AuthLayer } from "./auth/index.ts";
import type { McpServiceOptions } from "./service.ts";

type ServeAuth = NonNullable<McpServiceOptions["auth"]>;

test("serve/auth's AuthLayer is assignable to the auth serve takes", () => {
  const assignable = (layer: AuthLayer): ServeAuth => layer;
  expect(typeof assignable).toBe("function");
});
