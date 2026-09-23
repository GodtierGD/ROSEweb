CREATE TABLE IF NOT EXISTS monthly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,        -- e.g. "September 2026"
  rank INTEGER NOT NULL,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  verifier TEXT NOT NULL,
  points REAL NOT NULL,
  video_url TEXT,
  beaten_at TEXT NOT NULL     -- ISO date, used to bucket into `month`
);

CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player TEXT NOT NULL,
  level TEXT NOT NULL,
  pct INTEGER NOT NULL,
  status TEXT NOT NULL,       -- "In progress" | "Completed"
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_progress_player ON progress(player);
CREATE INDEX IF NOT EXISTS idx_monthly_month ON monthly_snapshots(month);
