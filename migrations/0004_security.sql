CREATE TABLE IF NOT EXISTS monitor_login_attempt (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitor_group_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  group_names TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitor_admin_password (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
