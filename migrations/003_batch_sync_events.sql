PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS batch_sync_events (
  event_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (
    status IN ('processing', 'completed', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS batch_sync_events_batch_idx
  ON batch_sync_events(batch_id, updated_at);
