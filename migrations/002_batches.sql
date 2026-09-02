PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  source_path_key TEXT NOT NULL DEFAULT '',
  batch_key TEXT NOT NULL DEFAULT '',
  manifest_key TEXT NOT NULL DEFAULT '',
  batch_folder_id TEXT,
  import_mode TEXT NOT NULL DEFAULT 'new' CHECK (
    import_mode IN ('reuse', 'update', 'new')
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'imported', 'updated', 'filed', 'failed', 'cancelled')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS batches_batch_key_idx
  ON batches(batch_key, updated_at);

CREATE INDEX IF NOT EXISTS batches_source_path_idx
  ON batches(source_path_key, updated_at);

CREATE INDEX IF NOT EXISTS batches_manifest_key_idx
  ON batches(manifest_key, updated_at);

CREATE TABLE IF NOT EXISTS batch_details (
  batch_id TEXT NOT NULL REFERENCES batches(batch_id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  package_name TEXT NOT NULL DEFAULT '',
  package_type TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT 'v01',
  ae_comp_name TEXT NOT NULL DEFAULT '',
  preview_path TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  manifest_path TEXT NOT NULL DEFAULT '',
  preview_eagle_id TEXT,
  source_eagle_id TEXT,
  package_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'imported', 'updated', 'filed', 'superseded', 'failed')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, package_id)
);

CREATE INDEX IF NOT EXISTS batch_details_package_idx
  ON batch_details(package_id, updated_at);

CREATE INDEX IF NOT EXISTS batch_details_package_key_idx
  ON batch_details(package_key, updated_at);
