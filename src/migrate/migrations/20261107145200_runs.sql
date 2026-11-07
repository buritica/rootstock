-- rootstock-migration: additive
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
