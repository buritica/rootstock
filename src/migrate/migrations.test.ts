import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { MANIFEST } from "./manifest.ts";
import { parseMigration, rootstockMigrations } from "./migrations.ts";

const DIR = new URL("./migrations/", import.meta.url);
const FILE = "20261020000000_schema_migrations.sql";
const NAME = /^\d{14}_[a-z0-9_]+\.sql$/;
const FILES = readdirSync(DIR).sort();

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("the shipped files", () => {
  test("the manifest is the directory, sorted", () => {
    expect([...MANIFEST]).toEqual(FILES);
  });

  for (const file of FILES) {
    test(`${file} follows the file rules`, () => {
      expect(file).toMatch(NAME);
      const text = readFileSync(new URL(file, DIR), "utf8");
      const head = text.split("\n").slice(0, 40).join("\n");
      expect(head).toMatch(/^--\s*rootstock-migration:\s*(additive|heavy)\s*$/m);
      for (const chunk of text.split(/^--> statement-breakpoint$/m)) {
        const code = chunk.split("\n").filter((l) => l.trim() !== "" && !/^\s*--/.test(l));
        expect(code.length).toBeGreaterThan(0);
      }
      // Schema-free: no qualified name outside comments and string literals,
      // except pg_catalog's.
      const bare = text
        .replace(/--.*$/gm, "")
        .replace(/'(?:[^']|'')*'/g, "''")
        .replaceAll("pg_catalog.", "");
      expect(bare).not.toMatch(/[a-z_"]\s*\.\s*[a-z_"]/i);
    });
  }

  test("schema-migrations-sha-pinned", () => {
    const [first] = rootstockMigrations();
    expect(first?.filename).toBe(FILE);
    expect(first?.sha256).toBe("066321b3d800c6062cebd7924d98964fe52732198950098a9459d7707b2bfc99");
    expect(first?.kind).toBe("additive");
    expect(first?.statements).toHaveLength(1);
  });
});

// The three Stage C files, byte for byte as the contract freezes them. A
// shipped file is frozen once released: its hash is recorded in every
// database that applied it.
const STAGE_C: Readonly<Record<string, string>> = {
  "20261107020000_run_locks.sql": `-- rootstock-migration: additive
-- The fencing table behind the run lock. One row per lock name: the holder of
-- the current acquisition, written after the advisory lock is taken and before
-- the holder writes anything else. Run with search_path set to the target
-- schema, so nothing here is schema-qualified.
CREATE TABLE run_locks (
  name text PRIMARY KEY,
  holder uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
`,
  "20261107020001_work_queue.sql": `-- rootstock-migration: additive
-- A durable work list: one row per unit of work, keyed \`<source>:<id>\`. The
-- vocabulary of sources and kinds belongs to the consumer and is validated by
-- the queue slice, not here. Run with search_path set to the target schema.
CREATE TABLE work_queue (
  key text PRIMARY KEY,
  source text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  not_before timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  dead_at timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_queue_key_source_check CHECK (key LIKE source || ':%'),
  CONSTRAINT work_queue_key_length_check CHECK (length(key) <= 512)
);
CREATE INDEX work_queue_due_idx ON work_queue (source, not_before) WHERE dead_at IS NULL;
`,
  "20261107020002_cursors.sql": `-- rootstock-migration: additive
-- Named resume points and pulses: where a feed resumes, or when a worker last
-- beat. Run with search_path set to the target schema.
CREATE TABLE cursors (
  name text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
};

// The three Stage D files (0.8.0), byte for byte as the D1 contract freezes them.
const STAGE_D: Readonly<Record<string, string>> = {
  "20261107145200_runs.sql": `-- rootstock-migration: additive
-- The run record: one row per run, written when the run starts and settled when
-- it ends. A row still 'running' whose lock has moved on was interrupted. Run
-- with search_path set to the target schema, so nothing here is schema-qualified.
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  job text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  phase text,
  lock_name text NOT NULL,
  holder uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  listed integer,
  written integer,
  unchanged integer,
  quarantined integer,
  excluded_count integer,
  reconciled boolean,
  excluded_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric,
  cost_note text,
  scope jsonb,
  scope_excluded jsonb,
  overrides jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text,
  CONSTRAINT runs_status_check
    CHECK (status IN ('running', 'ok', 'failed', 'refused', 'interrupted')),
  CONSTRAINT runs_settled_check CHECK ((status = 'running') = (finished_at IS NULL))
);
CREATE INDEX runs_job_started_idx ON runs (job, started_at DESC);
CREATE INDEX runs_running_idx ON runs (lock_name) WHERE status = 'running';
`,
  "20261107145201_quarantine.sql": `-- rootstock-migration: additive
-- Records a run could not load, one row per (job, external id). A repeat failure
-- updates the row; a later success resolves it. Run with search_path set to the
-- target schema.
CREATE TABLE quarantine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job text NOT NULL,
  external_id text NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  failed_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  run_id uuid,
  CONSTRAINT quarantine_status_check CHECK (status IN ('pending', 'resolved'))
);
CREATE UNIQUE INDEX quarantine_job_external_idx ON quarantine (job, external_id);
CREATE INDEX quarantine_pending_idx ON quarantine (job) WHERE status = 'pending';
`,
  "20261107145202_work_queue_claim_fence.sql": `-- rootstock-migration: additive
-- The claim fence: a token per claim that ack and fail must present, and a
-- version every enqueue bumps, so an ack never deletes work that arrived after
-- its claim. Run with search_path set to the target schema.
ALTER TABLE work_queue
  ADD COLUMN version bigint NOT NULL DEFAULT 0,
  ADD COLUMN claim_token uuid;
`,
};

describe("the Stage C files", () => {
  for (const [file, text] of Object.entries(STAGE_C)) {
    test(`${file} is byte-equal to the frozen text`, () => {
      expect(readFileSync(new URL(file, DIR), "utf8")).toBe(text);
    });
  }

  test("they follow the first file in the manifest, in order, as one statement each", () => {
    expect(MANIFEST.slice(1, 4)).toEqual(Object.keys(STAGE_C));
    for (const m of rootstockMigrations().slice(1, 4)) {
      expect(m.kind).toBe("additive");
      expect(m.statements).toHaveLength(1);
    }
  });
});

describe("the Stage D files", () => {
  for (const [file, text] of Object.entries(STAGE_D)) {
    test(`${file} is byte-equal to the frozen text`, () => {
      expect(readFileSync(new URL(file, DIR), "utf8")).toBe(text);
    });
  }

  test("they follow the Stage C files, in order, all additive", () => {
    expect(MANIFEST.slice(4)).toEqual(Object.keys(STAGE_D));
    for (const m of rootstockMigrations().slice(4)) expect(m.kind).toBe("additive");
  });
});

describe("rootstockMigrations", () => {
  test("is read once and frozen all the way down", () => {
    const list = rootstockMigrations();
    expect(rootstockMigrations()).toBe(list);
    expect(Object.isFrozen(list)).toBe(true);
    for (const m of list) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.statements)).toBe(true);
    }
  });

  test("lists the manifest in order", () => {
    expect(rootstockMigrations().map((m) => m.filename)).toEqual([...MANIFEST]);
  });
});

describe("parseMigration", () => {
  test("splits statements on breakpoint lines and hashes the bytes", () => {
    const text =
      "-- rootstock-migration: heavy\nCREATE TABLE a (x int);\n--> statement-breakpoint\nCREATE TABLE b (y int);\n";
    expect(parseMigration("20200101000000_two.sql", encode(text))).toEqual({
      filename: "20200101000000_two.sql",
      sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
      kind: "heavy",
      statements: [
        "-- rootstock-migration: heavy\nCREATE TABLE a (x int);",
        "CREATE TABLE b (y int);",
      ],
    });
  });

  test("a trailing breakpoint sends no empty statement", () => {
    const text = "-- rootstock-migration: additive\nSELECT 1;\n--> statement-breakpoint\n";
    expect(parseMigration("20200101000000_one.sql", encode(text)).statements).toEqual([
      "-- rootstock-migration: additive\nSELECT 1;",
    ]);
  });

  test("a breakpoint must be the whole line", () => {
    const text =
      "-- rootstock-migration: additive\nSELECT 1; --> statement-breakpoint\nSELECT 2;\n";
    expect(parseMigration("20200101000000_one.sql", encode(text)).statements).toHaveLength(1);
  });

  test("the marker tolerates spacing and may sit on line 40", () => {
    const padding = "-- note\n".repeat(39);
    const m = parseMigration(
      "20200101000000_late.sql",
      encode(`${padding}--   rootstock-migration:   additive  \nSELECT 1;\n`),
    );
    expect(m.kind).toBe("additive");
  });

  test("a marker on line 41, a misspelt kind or none at all is refused", () => {
    const late = `${"-- note\n".repeat(40)}-- rootstock-migration: additive\nSELECT 1;\n`;
    for (const text of [late, "-- rootstock-migration: huge\nSELECT 1;\n", "SELECT 1;\n"]) {
      let message = "";
      try {
        parseMigration("20200101000000_x.sql", encode(text));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe(
        'rootstockMigrations: 20200101000000_x.sql has no "-- rootstock-migration: additive|heavy" line in its first 40 lines',
      );
    }
  });
});
