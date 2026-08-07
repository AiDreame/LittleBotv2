-- SalesRecon: Initial Schema
-- Compatible with SQLite (dev) and PostgreSQL (production).
--   - Use INTEGER PRIMARY KEY for auto-increment on SQLite; switch to
--     BIGSERIAL or UUID on PostgreSQL.
--   - TEXT for JSON-like / datetime strings to keep it portable.

BEGIN;

-- ── Teams ──
CREATE TABLE IF NOT EXISTS teams (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  discord_guild_id  TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Chatters ──
CREATE TABLE IF NOT EXISTS chatters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Reports (self-reported logout messages) ──
CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chatter_id      INTEGER NOT NULL REFERENCES chatters(id) ON DELETE CASCADE,
  reported_sales  REAL NOT NULL DEFAULT 0,
  reported_tips   REAL NOT NULL DEFAULT 0,
  shift_start     TEXT NOT NULL,
  shift_end       TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Actuals (platform-imported sales data) ──
CREATE TABLE IF NOT EXISTS actuals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chatter_id    INTEGER NOT NULL REFERENCES chatters(id) ON DELETE CASCADE,
  actual_sales  REAL NOT NULL DEFAULT 0,
  actual_tips   REAL NOT NULL DEFAULT 0,
  date          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual'
);

-- ── Discrepancies (flagged mismatches) ──
CREATE TABLE IF NOT EXISTS discrepancies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actual_id   INTEGER NOT NULL REFERENCES actuals(id) ON DELETE CASCADE,
  sales_diff  REAL NOT NULL DEFAULT 0,
  tips_diff   REAL NOT NULL DEFAULT 0,
  flagged_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Guild Config (per-server bot settings) ──
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id           TEXT PRIMARY KEY,
  report_channel_id  TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Report Channels (multi-channel support per guild) ──
CREATE TABLE IF NOT EXISTS report_channels (
  guild_id    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS idx_chatters_team ON chatters(team_id);
CREATE INDEX IF NOT EXISTS idx_reports_chatter ON reports(chatter_id);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_actuals_chatter ON actuals(chatter_id);
CREATE INDEX IF NOT EXISTS idx_actuals_date ON actuals(date);
CREATE INDEX IF NOT EXISTS idx_discrepancies_report ON discrepancies(report_id);

COMMIT;
