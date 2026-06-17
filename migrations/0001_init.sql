CREATE TABLE IF NOT EXISTS monitor_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL DEFAULT '',
  user_id TEXT NOT NULL DEFAULT '',
  refresh_interval_seconds INTEGER NOT NULL DEFAULT 60,
  admin_allow_ips TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitor_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'empty',
  message TEXT NOT NULL DEFAULT '',
  refreshed_at INTEGER NOT NULL DEFAULT 0
);
