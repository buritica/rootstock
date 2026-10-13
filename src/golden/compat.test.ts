import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  captureSuites,
  checkSuites,
  createRecordingFetch,
  type GoldenSuite,
  nearVector,
  seededVector,
  sha256Hex,
} from "./index.ts";

// Values measured with the v0.0.1 harness. Each test fails if this version
// moves one of them: consumers' committed goldens depend on every byte.

const E_ACUTE = String.fromCharCode(0xe9);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const LONE_HIGH = String.fromCharCode(0xd83d);

const MIXED = {
  b: [1, E_ACUTE, null, { "10": true, "2": false }],
  a: `x${LINE_SEPARATOR}y`,
  d: new Date("2026-01-02T03:04:05.006Z"),
  n: -0,
  f: 0.1 + 0.2,
  s: LONE_HIGH,
  u: undefined,
};

describe("canonicalJson pins", () => {
  test("mixed object, compact", () => {
    const text = canonicalJson(MIXED);
    expect(text).toBe(
      `{"a":"x${LINE_SEPARATOR}y","b":[1,"${E_ACUTE}",null,{"10":true,"2":false}],"d":"2026-01-02T03:04:05.006Z","f":0.30000000000000004,"n":0,"s":"\\ud83d"}`,
    );
    expect(sha256Hex(text)).toBe(
      "aa7d57699cf9a803eea623eed82f9f32d1327f574cdf0e87748c6cc7d7ad5d36",
    );
  });

  test("mixed object, indent 2", () => {
    expect(sha256Hex(canonicalJson(MIXED, 2))).toBe(
      "ac065d9ce3b5a7f14a9c1e170f10f73b31aa1a97a89059e542118a639e0f2832",
    );
  });
});

describe("vector pins", () => {
  test("seededVector", () => {
    expect(seededVector("rootstock-pin", 4)).toEqual([
      -0.7297222136858736, -0.15863106454054926, 0.15797855268438335, -0.6460529801091145,
    ]);
  });

  test("nearVector", () => {
    expect(nearVector("rootstock-pin", [1, 0, 0, 0], 0.5)).toEqual([
      0.36761242247381026, -0.21575857457843464, 0.2148710748419256, -0.8787148374387987,
    ]);
  });
});

describe("recorder pins", () => {
  test("POST with a secret query param and header", async () => {
    const { fetch: recording, requests } = createRecordingFetch(() => new Response("{}"));
    await recording("https://api.example.test/v1/m:gen?key=SECRET&alt=json", {
      method: "post",
      headers: {
        "x-goog-api-key": "S",
        "ai-model-id": "vendor/model-a",
        "content-type": "application/json",
      },
      body: JSON.stringify({ b: 2, a: 1 }),
    });
    expect(JSON.stringify(requests)).toBe(
      JSON.stringify([
        {
          method: "POST",
          url: "https://api.example.test/v1/m:gen?key=%3Credacted%3E&alt=json",
          headers: {
            "ai-model-id": "vendor/model-a",
            "content-type": "application/json",
            "x-goog-api-key": "<redacted>",
          },
          body: { b: 2, a: 1 },
          requestSha256: "a8578b0a86726e2bbab35f80c0d6e1c56aeb536973cae920be36d2cab1e8324b",
        },
      ]),
    );
  });

  test("bare GET", async () => {
    const { fetch: recording, requests } = createRecordingFetch(() => new Response("{}"));
    await recording("https://api.example.test/v1/get", {});
    const [recorded] = requests;
    expect(recorded).toEqual({
      method: "GET",
      url: "https://api.example.test/v1/get",
      headers: {},
      body: null,
      requestSha256: "c0455ce77e3128ecfb259e07d60ecdd589b2bb1ea9ea0772cafeba514054ce1c",
    });
    expect(Object.keys(recorded ?? {})).toEqual([
      "method",
      "url",
      "headers",
      "body",
      "requestSha256",
    ]);
  });
});

const SYNTHETIC: GoldenSuite = {
  capability: "chunk.split",
  profile: "synthetic-v1",
  cases: [
    {
      id: "a",
      input: { text: "Hola\r\nmundo" },
      run: () => ({ parts: ["Hola", "mundo"], n: 2, score: 0.333333 }),
    },
    { id: "b", input: "", run: () => [] },
  ],
};

const SYNTHETIC_FILE = `{
  "capability": "chunk.split",
  "capturedFrom": "0000000000000000000000000000000000000000",
  "cases": [
    {
      "id": "a",
      "inputSha256": "8ef66e30dd9c2f9c55742e9f354d9cdd9147969bf5b6f55024b41256c86d2caf",
      "output": {
        "n": 2,
        "parts": [
          "Hola",
          "mundo"
        ],
        "score": 0.333333
      }
    },
    {
      "id": "b",
      "inputSha256": "12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126",
      "output": []
    }
  ],
  "format": 1,
  "profile": "synthetic-v1",
  "repo": "synthetic"
}
`;

describe("golden file pins", () => {
  test("a capture writes the v0.0.1 bytes and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-compat-"));
    const written = await captureSuites([SYNTHETIC], {
      dir,
      repo: "synthetic",
      capturedFrom: "0".repeat(40),
    });
    expect(written).toEqual([join(dir, "chunk.split", "synthetic-v1.json")]);
    const text = await readFile(written[0] ?? "", "utf8");
    expect(text).toBe(SYNTHETIC_FILE);
    expect(sha256Hex(text)).toBe(
      "73e8de767e1eb756ecf9c95bec3dbc019d1db35ded876b17082d6c9fc567204f",
    );
    expect(await readdir(join(dir, "chunk.split"))).toEqual(["synthetic-v1.json"]);
  });

  test("a v0.0.1 golden file checks clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "golden-compat-"));
    await mkdir(join(dir, "chunk.split"));
    await writeFile(join(dir, "chunk.split", "synthetic-v1.json"), SYNTHETIC_FILE);
    const reports = await checkSuites([SYNTHETIC], { dir });
    expect(reports).toEqual([
      {
        capability: "chunk.split",
        profile: "synthetic-v1",
        path: join(dir, "chunk.split", "synthetic-v1.json"),
        problems: [],
      },
    ]);
  });
});

describe("export surface", () => {
  test("golden", async () => {
    expect(Object.keys(await import("@buritica/rootstock/golden")).sort()).toEqual([
      "CAPABILITIES",
      "GOLDEN_EXIT",
      "GOLDEN_FORMAT",
      "GOLDEN_LABELS",
      "GoldenCaseError",
      "GoldenFileError",
      "canonicalJson",
      "captureSuites",
      "checkSuites",
      "createRecordingFetch",
      "goldenPath",
      "isCapabilityId",
      "nearVector",
      "orphanGoldenFiles",
      "readGoldenFile",
      "redactUrl",
      "runCase",
      "runGoldenCli",
      "seededVector",
      "sha256Hex",
      "startThrowawayPostgres",
      "validateSuites",
    ]);
  });

  test("golden/bun-test", async () => {
    expect(Object.keys(await import("@buritica/rootstock/golden/bun-test")).sort()).toEqual([
      "registerGoldenTests",
    ]);
  });

  test("exit codes and labels", async () => {
    const { GOLDEN_EXIT, GOLDEN_LABELS } = await import("./index.ts");
    expect(GOLDEN_EXIT).toEqual({ ok: 0, mismatch: 1, usage: 2, aborted: 3 });
    expect(GOLDEN_LABELS).toEqual({
      marker: "rootstock.golden",
      pid: "rootstock.golden.pid",
      host: "rootstock.golden.host",
      ownerStart: "rootstock.golden.owner-start",
    });
  });
});
