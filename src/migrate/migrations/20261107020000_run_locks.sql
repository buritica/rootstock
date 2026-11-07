-- rootstock-migration: additive
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
