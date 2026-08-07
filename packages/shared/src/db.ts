import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

/**
 * Resolve the SQLite database path.
 * Uses SALESRECON_DB_PATH env var, falls back to data/salesrecon.db
 * relative to the monorepo root (process.cwd() when run via pnpm --filter).
 */
function resolveDbPath(): string {
  if (process.env.SALESRECON_DB_PATH) {
    return process.env.SALESRECON_DB_PATH;
  }
  return path.resolve(process.cwd(), "data", "salesrecon.db");
}

/**
 * Get (or create) the SQLite database connection.
 * Runs migrations automatically on first connect.
 */
export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const resolvedPath = dbPath ?? resolveDbPath();
  const dir = path.dirname(resolvedPath);

  // Ensure data directory exists
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  return db;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Set a custom database path for testing.
 */
export function setDbPathForTest(newPath: string): void {
  closeDb();
  // Override via env so resolveDbPath picks it up next time getDb is called
  process.env.SALESRECON_DB_PATH = newPath;
}

// ── Migrations ──

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id           TEXT PRIMARY KEY,
      report_channel_id  TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS report_channels (
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      discord_guild_id  TEXT NOT NULL UNIQUE,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatters (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id  TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      chatter_id      INTEGER NOT NULL REFERENCES chatters(id) ON DELETE CASCADE,
      reported_sales  REAL NOT NULL DEFAULT 0,
      reported_tips   REAL NOT NULL DEFAULT 0,
      shift_start     TEXT NOT NULL,
      shift_end       TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      earnings_source TEXT NOT NULL DEFAULT 'explicit' CHECK (earnings_source IN ('explicit','inferred_zero')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS actuals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chatter_id    INTEGER NOT NULL REFERENCES chatters(id) ON DELETE CASCADE,
      actual_sales  REAL NOT NULL DEFAULT 0,
      actual_tips   REAL NOT NULL DEFAULT 0,
      date          TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'manual',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Unique constraint: one actual record per chatter per date
    CREATE UNIQUE INDEX IF NOT EXISTS idx_actuals_chatter_date
      ON actuals(chatter_id, date);

    CREATE TABLE IF NOT EXISTS discrepancies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      actual_id   INTEGER NOT NULL REFERENCES actuals(id) ON DELETE CASCADE,
      sales_diff  REAL NOT NULL DEFAULT 0,
      tips_diff   REAL NOT NULL DEFAULT 0,
      flagged_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chatters_team ON chatters(team_id);
    CREATE INDEX IF NOT EXISTS idx_reports_chatter ON reports(chatter_id);
    CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);
    -- Discord message IDs are stable source keys; enforce import idempotency.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_message_id ON reports(message_id);
    CREATE INDEX IF NOT EXISTS idx_actuals_chatter ON actuals(chatter_id);
    CREATE INDEX IF NOT EXISTS idx_actuals_date ON actuals(date);
    CREATE INDEX IF NOT EXISTS idx_discrepancies_report ON discrepancies(report_id);

    -- Raw Discord source messages are retained independently from parsed reports.
    CREATE TABLE IF NOT EXISTS raw_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      message_created_at TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      parse_status TEXT NOT NULL DEFAULT 'unparsed',
      parse_reason TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_raw_messages_channel ON raw_messages(channel_id, message_created_at);
    CREATE INDEX IF NOT EXISTS idx_raw_messages_status ON raw_messages(parse_status);

    CREATE TABLE IF NOT EXISTS chatter_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      chatter_id INTEGER NOT NULL REFERENCES chatters(id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('login','logout')),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chatter_events_time ON chatter_events(chatter_id, occurred_at);
  `);
  // Safe additive migrations for databases created before analytics foundation.
  const reportColumns = database.prepare("PRAGMA table_info(reports)").all() as Array<{name: string}>;
  if (!reportColumns.some((c) => c.name === "model_name")) {
    database.exec("ALTER TABLE reports ADD COLUMN model_name TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_reports_model ON reports(model_name)");
  const earningsColumns = database.prepare("PRAGMA table_info(reports)").all() as Array<{name: string}>;
  if (!earningsColumns.some((c) => c.name === "earnings_source")) {
    database.exec("ALTER TABLE reports ADD COLUMN earnings_source TEXT NOT NULL DEFAULT 'explicit'");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_reports_earnings_source ON reports(earnings_source)");
}
