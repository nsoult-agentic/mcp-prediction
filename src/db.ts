/**
 * SQLite database for prediction agent state.
 * Stores forecasts, trades, portfolio snapshots, calibration data, system health.
 * Shared between MCP server (write) and web dashboard (read-only).
 */
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const DATA_DIR = process.env["DATA_DIR"] || "/data";
const DB_PATH = resolve(DATA_DIR, "trades.db");

let db: Database;

export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    initSchema();
  }
  return db;
}

function initSchema(): void {
  const d = getDb();

  d.run(`CREATE TABLE IF NOT EXISTS forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    market_slug TEXT,
    market_question TEXT,
    category TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    -- Ensemble estimates
    estimate_1 REAL,
    estimate_2 REAL,
    estimate_3 REAL,
    estimate_4 REAL,
    estimate_5 REAL,
    median_estimate REAL NOT NULL,
    market_price REAL NOT NULL,
    edge REAL NOT NULL,
    direction TEXT CHECK(direction IN ('YES', 'NO')),
    reasoning TEXT,
    -- Trade execution
    traded INTEGER DEFAULT 0,
    order_id TEXT,
    fill_price REAL,
    contracts REAL,
    cost REAL,
    -- Resolution
    resolved INTEGER DEFAULT 0,
    outcome INTEGER,
    pnl REAL,
    resolved_at TEXT
  )`);

  d.run(`CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    total_value REAL NOT NULL,
    cash REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    daily_pnl REAL,
    cumulative_pnl REAL,
    max_drawdown REAL,
    sharpe_ratio REAL
  )`);

  d.run(`CREATE TABLE IF NOT EXISTS system_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    cycle_status TEXT CHECK(cycle_status IN ('success', 'failure', 'skipped')),
    inference_cost REAL DEFAULT 0,
    api_calls INTEGER DEFAULT 0,
    markets_scanned INTEGER DEFAULT 0,
    trades_placed INTEGER DEFAULT 0,
    errors TEXT
  )`);

  d.run(`CREATE TABLE IF NOT EXISTS calibration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    bucket_start REAL,
    bucket_end REAL,
    predicted_mean REAL,
    actual_frequency REAL,
    sample_count INTEGER
  )`);

  // Indexes for common queries
  d.run(`CREATE INDEX IF NOT EXISTS idx_forecasts_resolved ON forecasts(resolved)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_forecasts_category ON forecasts(category)`);
  d.run(`CREATE INDEX IF NOT EXISTS idx_forecasts_created ON forecasts(created_at)`);
}
