-- Preserve upload progress and distinguish safe retries from uncertain dispatches.
-- Legacy sending records are uncertain until explicitly reconciled by an operator.
ALTER TABLE deliveries ADD COLUMN phase TEXT NOT NULL DEFAULT 'uncertain'
  CHECK (phase IN ('preparing', 'uploaded', 'dispatching', 'uncertain', 'delivered'));
ALTER TABLE deliveries ADD COLUMN resource_json TEXT;
ALTER TABLE deliveries ADD COLUMN last_error TEXT;
UPDATE deliveries SET phase = 'delivered' WHERE status = 'completed';
-- Historical failed sends may also have an unknown remote outcome; reconcile them first.
