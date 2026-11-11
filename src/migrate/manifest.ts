/**
 * Every migration this package ships, as bare filenames, in apply order. A
 * test holds this list equal to the `migrations/` directory, sorted.
 */
export const MANIFEST: readonly string[] = Object.freeze([
  "20261020000000_schema_migrations.sql",
  "20261107020000_run_locks.sql",
  "20261107020001_work_queue.sql",
  "20261107020002_cursors.sql",
  "20261107145200_runs.sql",
  "20261107145201_quarantine.sql",
  "20261107145202_work_queue_claim_fence.sql",
]);
