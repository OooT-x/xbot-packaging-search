ALTER TABLE packages ADD COLUMN catalog_revision TEXT NOT NULL DEFAULT '';
ALTER TABLE query_candidates ADD COLUMN snapshot_json TEXT;
ALTER TABLE deliveries ADD COLUMN snapshot_key TEXT;

-- Do not guess historical file identities. Preserve all delivery/reconciliation rows.
UPDATE queries SET status = 'expired',
  expires_at = MIN(expires_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  last_error = 'candidate snapshot upgrade; query again'
WHERE status IN ('pending', 'preparing');
