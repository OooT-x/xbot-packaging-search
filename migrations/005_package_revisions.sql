CREATE TABLE IF NOT EXISTS package_revisions (
  revision_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'replace',
  replaced_kind TEXT NOT NULL DEFAULT '',
  replaced_eagle_id TEXT NOT NULL DEFAULT '',
  new_eagle_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS package_revisions_package_idx
  ON package_revisions(package_id, created_at DESC);
