-- rootstock-migration: additive
-- Named resume points and pulses: where a feed resumes, or when a worker last
-- beat. Run with search_path set to the target schema.
CREATE TABLE cursors (
  name text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
