-- rootstock-migration: additive
-- What each caller spent per UTC day, in tokens or dollars: the store behind
-- usage's spend ceiling. Every write is an upsert that adds to `used` and
-- returns the new total. Run with search_path set to the target schema.
CREATE TABLE spend (
  window_start date NOT NULL,
  caller text NOT NULL,
  unit text NOT NULL,
  used numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (window_start, caller, unit),
  CONSTRAINT spend_unit_check CHECK (unit IN ('tokens', 'usd'))
);
