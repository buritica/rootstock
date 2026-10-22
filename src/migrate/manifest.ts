/**
 * Every migration this package ships, as bare filenames, in apply order. A
 * test holds this list equal to the `migrations/` directory, sorted.
 */
export const MANIFEST: readonly string[] = Object.freeze(["20261020000000_schema_migrations.sql"]);
