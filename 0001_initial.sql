CREATE TABLE IF NOT EXISTS monthly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,     
  rank INTEGER NOT NULL,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  verifier TEXT NOT NULL,
  points REAL NOT NULL,
  video_url TEXT,
  beaten_at TEXT NOT NULL 
);

CREATE INDEX IF NOT EXISTS idx_monthly_month ON monthly_snapshots(month);

-- `progress` is no longer used — /api/progress now reads the sheet's
-- PROGRESS tab instead. Safe to drop if you already ran the old
-- version of this migration and have an empty/unused progress table:
--   DROP TABLE IF EXISTS progress;
