import { expect, test } from "bun:test";

// rootstock is public and consumer-neutral: source carries behavior, never the
// consumers' internals or identity. Patterns are built from pieces so this file
// does not match itself.
const FORBIDDEN: readonly RegExp[] = [
  new RegExp(["TEC", "-\\d"].join("")),
  new RegExp(["gh", " #\\d"].join("")),
  new RegExp(["sendas", "org"].join(""), "i"),
  new RegExp(["com", "pass"].join(""), "i"),
  /src\/[\w-]+\.ts:\d/,
  /(drizzle|migrations)\/\d{4,14}_/,
  /f_(embed|classify)_hash/,
  new RegExp(["gemini", "-embedding"].join("")),
  new RegExp(["Resoluci", "[oó]n"].join("")),
  new RegExp(["\\b", "Tec", "\\b"].join("")),
  new RegExp(["sev", "ero|half", "moon|estan", "li"].join("")),
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
  new RegExp(["Run", "Fatal"].join("")),
  new RegExp(["storm", ".?breaker"].join(""), "i"),
  new RegExp(["neon", "\\.tech"].join("")),
  new RegExp(["onrender", "\\.com"].join("")),
  new RegExp(["commons", "-migrate"].join("")),
];

const SELF = "hygiene.test.ts";

test("no source file names a consumer's internals", async () => {
  const hits: string[] = [];
  for await (const path of new Bun.Glob("**/*").scan({ cwd: import.meta.dir })) {
    if (path === SELF) continue;
    const lines = (await Bun.file(`${import.meta.dir}/${path}`).text()).split("\n");
    lines.forEach((line, i) => {
      for (const pattern of FORBIDDEN) {
        if (pattern.test(line)) hits.push(`${path}:${i + 1} matches ${pattern}`);
      }
    });
  }
  expect(hits).toEqual([]);
});
