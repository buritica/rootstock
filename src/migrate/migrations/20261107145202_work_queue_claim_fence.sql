-- rootstock-migration: additive
-- The claim fence: a token per claim that ack and fail must present, and a
-- version every enqueue bumps, so an ack never deletes work that arrived after
-- its claim. Run with search_path set to the target schema.
ALTER TABLE work_queue
  ADD COLUMN version bigint NOT NULL DEFAULT 0,
  ADD COLUMN claim_token uuid;
