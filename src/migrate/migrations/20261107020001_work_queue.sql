-- rootstock-migration: additive
-- A durable work list: one row per unit of work, keyed `<source>:<id>`. The
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
