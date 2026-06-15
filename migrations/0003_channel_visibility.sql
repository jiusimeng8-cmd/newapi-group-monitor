CREATE TABLE IF NOT EXISTS monitor_channel_visibility (
  channel_name TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT 0
);
