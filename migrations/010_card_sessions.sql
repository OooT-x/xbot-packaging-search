CREATE TABLE card_sessions (
  session_id TEXT PRIMARY KEY,
  root_message_id TEXT NOT NULL UNIQUE,
  card_message_id TEXT UNIQUE,
  chat_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state_json TEXT NOT NULL
);
ALTER TABLE queries ADD COLUMN source_root_message_id TEXT;
