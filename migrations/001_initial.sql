PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS packages (
  package_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  package_name TEXT NOT NULL,
  package_type TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL,
  base_package_id TEXT,
  preview_eagle_id TEXT NOT NULL UNIQUE,
  source_eagle_id TEXT NOT NULL UNIQUE,
  preview_path TEXT NOT NULL,
  source_path TEXT NOT NULL,
  ae_comp_name TEXT NOT NULL DEFAULT '',
  dependency_status TEXT NOT NULL DEFAULT 'complete',
  status TEXT NOT NULL DEFAULT 'active',
  eagle_modified_at INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS packages_project_idx
  ON packages(project_id, status, package_type);

CREATE TABLE IF NOT EXISTS queries (
  request_id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL UNIQUE,
  prompt_message_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('preparing', 'pending', 'sending', 'completed', 'cancelled', 'expired', 'failed')
  ),
  selected_package_id TEXT REFERENCES packages(package_id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  source_message_id TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS queries_chat_status_idx
  ON queries(chat_id, status, expires_at);

CREATE TABLE IF NOT EXISTS query_candidates (
  request_id TEXT NOT NULL REFERENCES queries(request_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  package_id TEXT NOT NULL REFERENCES packages(package_id),
  preview_message_id TEXT UNIQUE,
  PRIMARY KEY (request_id, position)
);

CREATE INDEX IF NOT EXISTS query_candidates_preview_idx
  ON query_candidates(preview_message_id);

CREATE TABLE IF NOT EXISTS deliveries (
  request_id TEXT NOT NULL REFERENCES queries(request_id),
  package_id TEXT NOT NULL REFERENCES packages(package_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('sending', 'completed', 'failed')),
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, package_id)
);
