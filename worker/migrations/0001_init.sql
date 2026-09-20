-- 0001_init.sql: Initial D1 schema for Hush

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sender','domain','keyword')),
  pattern TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('now','later','mute')),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  sender TEXT,
  title TEXT NOT NULL,
  body TEXT,
  dedupe_hash TEXT NOT NULL,
  classifier TEXT NOT NULL, -- 'jev' | 'heuristic' | 'heuristic_fallback' | 'rule'
  lane TEXT NOT NULL CHECK (lane IN ('now','later','mute')),
  lane_reason TEXT NOT NULL,
  urgency REAL,
  p_now REAL,
  p_later REAL,
  p_mute REAL,
  p_time_sensitive REAL,
  p_needs_reply REAL,
  p_from_person REAL,
  p_promotional REAL,
  p_suspicious REAL,
  answers_json TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0,
  suspicious INTEGER NOT NULL DEFAULT 0,
  classify_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','snoozed')),
  snooze_until TEXT,
  user_lane TEXT CHECK (user_lane IN ('now','later','mute')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  tone TEXT NOT NULL,
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  item_count INTEGER,
  summary_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  created_at TEXT NOT NULL,
  classifier TEXT NOT NULL,
  n INTEGER,
  accuracy REAL,
  false_mute_rate REAL,
  results_json TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  client_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_notif_client_time ON notifications(client_id, received_at);
CREATE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(client_id, dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_rules_client_priority ON rules(client_id, priority DESC, created_at ASC);
