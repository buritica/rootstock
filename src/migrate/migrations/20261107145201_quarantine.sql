-- rootstock-migration: additive
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
