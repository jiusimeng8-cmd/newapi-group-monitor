CREATE TABLE IF NOT EXISTS monitor_session (
  session_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
