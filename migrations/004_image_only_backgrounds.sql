-- Backgrounds may be represented by a preview PNG without an AE ZIP source.
-- Rebuild only the packages table so existing query/delivery foreign keys keep
-- referring to the table name `packages`.
CREATE TABLE packages_image_only (
  package_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  package_name TEXT NOT NULL,
  package_type TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL,
  base_package_id TEXT,
  preview_eagle_id TEXT NOT NULL UNIQUE,
  source_eagle_id TEXT UNIQUE,
  preview_path TEXT NOT NULL,
  source_path TEXT,
  ae_comp_name TEXT NOT NULL DEFAULT '',
  dependency_status TEXT NOT NULL DEFAULT 'complete',
  status TEXT NOT NULL DEFAULT 'active',
  eagle_modified_at INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);

INSERT INTO packages_image_only(
  package_id, project_id, package_name, package_type, tags_json, version,
  base_package_id, preview_eagle_id, source_eagle_id, preview_path, source_path,
  ae_comp_name, dependency_status, status, eagle_modified_at, synced_at
)
SELECT
  package_id, project_id, package_name, package_type, tags_json, version,
  base_package_id, preview_eagle_id, source_eagle_id, preview_path, source_path,
  ae_comp_name, dependency_status, status, eagle_modified_at, synced_at
FROM packages;

DROP TABLE packages;
ALTER TABLE packages_image_only RENAME TO packages;

CREATE INDEX IF NOT EXISTS packages_project_idx
  ON packages(project_id, status, package_type);
