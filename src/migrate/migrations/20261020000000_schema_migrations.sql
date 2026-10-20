-- rootstock-migration: additive
-- The applier's tracking table. Run with search_path set to the target
-- schema, so nothing here is schema-qualified.
CREATE TABLE schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
