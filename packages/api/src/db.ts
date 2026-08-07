import { getDb } from "@salesrecon/shared";
import type Database from "better-sqlite3";

/** Row shape from the actuals table */
export interface ActualRow {
  id: number;
  chatter_id: number;
  actual_sales: number;
  actual_tips: number;
  date: string;       // YYYY-MM-DD
  source: string;
  created_at: string;
}

/** Row with chatter info joined */
export interface ActualWithChatter extends ActualRow {
  chatter_discord_id: string;
  chatter_name: string;
}

/** Input for creating/upserting an actual */
export interface ActualInput {
  discord_id: string;
  date: string;       // YYYY-MM-DD
  actual_sales: number;
  actual_tips: number;
  source: string;
}

/** Result of a CSV import operation */
export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

// ── Report row shapes ──

/** Row shape from the reports table */
export interface ReportRow {
  id: number;
  chatter_id: number;
  reported_sales: number;
  reported_tips: number;
  shift_start: string;
  shift_end: string;
  message_id: string;
  created_at: string;
}

/** Report row joined with chatter info */
export interface ReportWithChatter extends ReportRow {
  chatter_discord_id: string;
  chatter_name: string;
}

// ── Discrepancy row shapes ──

/** Row shape from the discrepancies table */
export interface DiscrepancyRow {
  id: number;
  report_id: number;
  actual_id: number;
  sales_diff: number;
  tips_diff: number;
  flagged_at: string;
}

/** Rich discrepancy row with all joined data */
export interface DiscrepancyDetail {
  id: number;
  report_id: number;
  actual_id: number;
  sales_diff: number;
  tips_diff: number;
  flagged_at: string;
  // Chatter info
  chatter_discord_id: string;
  chatter_name: string;
  // Report info
  reported_sales: number;
  reported_tips: number;
  shift_start: string;
  shift_end: string;
  // Actual info
  actual_sales: number;
  actual_tips: number;
  actual_date: string;
  actual_source: string;
}

/** Filters for listing discrepancies */
export interface DiscrepancyFilters {
  date_from?: string;
  date_to?: string;
  chatter_id?: number;
  min_diff?: number;
}

/** Summary stats */
export interface ReconciliationSummary {
  total_reports: number;
  total_reconciled: number;
  total_discrepancies: number;
  total_sales_diff: number;
  total_tips_diff: number;
  overreported_count: number;
  underreported_count: number;
  overreported_sales_total: number;
  underreported_sales_total: number;
}

/**
 * Upsert an actual record: match by chatter (via discord_id) + date.
 * Creates the chatter if they don't exist yet (with a placeholder guild).
 */
export function upsertActual(input: ActualInput): ActualRow {
  const db = getDb();

  // Find chatter by discord_id
  let chatter = db
    .prepare("SELECT id FROM chatters WHERE discord_id = ?")
    .get(input.discord_id) as { id: number } | undefined;

  if (!chatter) {
    // Auto-create chatter with a placeholder team
    const teamResult = db
      .prepare(
        "INSERT OR IGNORE INTO teams (name, discord_guild_id) VALUES (?, ?)",
      )
      .run("imported", "imported");

    let teamId: number;
    const team = db
      .prepare("SELECT id FROM teams WHERE discord_guild_id = ?")
      .get("imported") as { id: number } | undefined;
    if (team) {
      teamId = team.id;
    } else {
      teamId = Number(teamResult.lastInsertRowid);
    }

    const cResult = db
      .prepare(
        "INSERT INTO chatters (discord_id, name, team_id) VALUES (?, ?, ?)",
      )
      .run(input.discord_id, input.discord_id, teamId);
    chatter = { id: Number(cResult.lastInsertRowid) };
  }

  // Upsert actuals
  db.prepare(
    `INSERT INTO actuals (chatter_id, actual_sales, actual_tips, date, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chatter_id, date) DO UPDATE SET
       actual_sales = excluded.actual_sales,
       actual_tips = excluded.actual_tips,
       source = excluded.source,
       created_at = datetime('now')`,
  ).run(chatter.id, input.actual_sales, input.actual_tips, input.date, input.source);

  return db
    .prepare("SELECT * FROM actuals WHERE chatter_id = ? AND date = ?")
    .get(chatter.id, input.date) as ActualRow;
}

/**
 * List actuals, optionally filtered by date and/or chatter (by discord_id).
 */
export function listActuals(opts?: {
  date?: string;
  chatterId?: string; // discord_id
}): ActualWithChatter[] {
  const db = getDb();

  let sql = `
    SELECT a.*, c.discord_id AS chatter_discord_id, c.name AS chatter_name
    FROM actuals a
    JOIN chatters c ON c.id = a.chatter_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (opts?.date) {
    sql += " AND a.date = ?";
    params.push(opts.date);
  }

  if (opts?.chatterId) {
    sql += " AND c.discord_id = ?";
    params.push(opts.chatterId);
  }

  sql += " ORDER BY a.date DESC, a.created_at DESC";

  return db.prepare(sql).all(...params) as ActualWithChatter[];
}

/**
 * Get a single actual by its ID.
 */
export function getActualById(id: number): ActualWithChatter | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT a.*, c.discord_id AS chatter_discord_id, c.name AS chatter_name
       FROM actuals a
       JOIN chatters c ON c.id = a.chatter_id
       WHERE a.id = ?`,
    )
    .get(id) as ActualWithChatter | undefined;
}

/**
 * Create a single actual record (JSON body).
 */
export function createActual(input: ActualInput): ActualRow {
  return upsertActual(input);
}

/**
 * Delete an actual record by ID.
 * Returns true if a row was deleted.
 */
export function deleteActual(id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM actuals WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Report queries ──

/**
 * Get reports that haven't been reconciled yet (no discrepancy row referencing them).
 * Optionally filtered by date (shift_start date) and/or chatter_id.
 */
export function getUnmatchedReports(
  date?: string,
  chatterId?: number,
): ReportWithChatter[] {
  const db = getDb();

  let sql = `
    SELECT r.*, c.discord_id AS chatter_discord_id, c.name AS chatter_name
    FROM reports r
    JOIN chatters c ON c.id = r.chatter_id
    LEFT JOIN discrepancies d ON d.report_id = r.id
    WHERE d.id IS NULL
  `;
  const params: unknown[] = [];

  if (date) {
    sql += " AND date(r.shift_start) = ?";
    params.push(date);
  }

  if (chatterId !== undefined) {
    sql += " AND r.chatter_id = ?";
    params.push(chatterId);
  }

  sql += " ORDER BY r.created_at ASC";

  return db.prepare(sql).all(...params) as ReportWithChatter[];
}

/**
 * Get a single report by ID, joined with chatter info.
 */
export function getReportById(id: number): ReportWithChatter | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT r.*, c.discord_id AS chatter_discord_id, c.name AS chatter_name
       FROM reports r
       JOIN chatters c ON c.id = r.chatter_id
       WHERE r.id = ?`,
    )
    .get(id) as ReportWithChatter | undefined;
}

/**
 * Count total reports in the database (optionally filtered by date).
 */
export function countReports(date?: string): number {
  const db = getDb();
  let sql = "SELECT COUNT(*) as cnt FROM reports";
  const params: unknown[] = [];

  if (date) {
    sql += " WHERE date(shift_start) = ?";
    params.push(date);
  }

  const row = db.prepare(sql).get(...params) as { cnt: number };
  return row.cnt;
}

// ── Actual matching ──

/**
 * Find the actuals row for the chatter on the report's shift date.
 * The report's shift_start date is extracted and matched against actuals.date.
 */
export function findActualForReport(
  report: ReportRow,
): ActualRow | undefined {
  const db = getDb();
  // Extract date from shift_start (YYYY-MM-DD)
  return db
    .prepare(
      `SELECT * FROM actuals
       WHERE chatter_id = ? AND date = date(?)
       LIMIT 1`,
    )
    .get(report.chatter_id, report.shift_start) as ActualRow | undefined;
}

// ── Discrepancy mutations ──

/** Input for creating a discrepancy */
export interface InsertDiscrepancyInput {
  report_id: number;
  actual_id: number;
  sales_diff: number;
  tips_diff: number;
}

/**
 * Insert a discrepancy row. Returns the created row.
 */
export function insertDiscrepancy(
  data: InsertDiscrepancyInput,
): DiscrepancyRow {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO discrepancies (report_id, actual_id, sales_diff, tips_diff)
       VALUES (?, ?, ?, ?)`,
    )
    .run(data.report_id, data.actual_id, data.sales_diff, data.tips_diff);

  return db
    .prepare("SELECT * FROM discrepancies WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as DiscrepancyRow;
}

/**
 * Check if a report has already been reconciled (has a discrepancy row).
 */
export function hasDiscrepancy(reportId: number): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM discrepancies WHERE report_id = ?")
    .get(reportId);
  return row !== undefined;
}

// ── Discrepancy queries ──

/**
 * List discrepancies with rich joined data (chatter, report, actual).
 * Filterable by date range, chatter_id, and minimum absolute diff.
 */
export function listDiscrepancies(
  filters?: DiscrepancyFilters,
): DiscrepancyDetail[] {
  const db = getDb();

  let sql = `
    SELECT
      d.id,
      d.report_id,
      d.actual_id,
      d.sales_diff,
      d.tips_diff,
      d.flagged_at,
      c.discord_id AS chatter_discord_id,
      c.name AS chatter_name,
      r.reported_sales,
      r.reported_tips,
      r.shift_start,
      r.shift_end,
      a.actual_sales,
      a.actual_tips,
      a.date AS actual_date,
      a.source AS actual_source
    FROM discrepancies d
    JOIN reports r ON r.id = d.report_id
    JOIN actuals a ON a.id = d.actual_id
    JOIN chatters c ON c.id = r.chatter_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (filters?.date_from) {
    sql += " AND a.date >= ?";
    params.push(filters.date_from);
  }

  if (filters?.date_to) {
    sql += " AND a.date <= ?";
    params.push(filters.date_to);
  }

  if (filters?.chatter_id !== undefined) {
    sql += " AND c.id = ?";
    params.push(filters.chatter_id);
  }

  if (filters?.min_diff !== undefined) {
    sql += " AND (ABS(d.sales_diff) >= ? OR ABS(d.tips_diff) >= ?)";
    params.push(filters.min_diff, filters.min_diff);
  }

  sql += " ORDER BY d.flagged_at DESC";

  return db.prepare(sql).all(...params) as DiscrepancyDetail[];
}

/**
 * Get reconciliation summary stats.
 */
export function getReconciliationSummary(): ReconciliationSummary {
  const db = getDb();

  const totalReports =
    (
      db
        .prepare("SELECT COUNT(*) as cnt FROM reports")
        .get() as { cnt: number }
    ).cnt;

  const totalReconciled =
    (
      db
        .prepare(
          "SELECT COUNT(DISTINCT report_id) as cnt FROM discrepancies",
        )
        .get() as { cnt: number }
    ).cnt;

  const agg = db
    .prepare(
      `SELECT
         COUNT(*) as total_discrepancies,
         COALESCE(SUM(sales_diff), 0) as total_sales_diff,
         COALESCE(SUM(tips_diff), 0) as total_tips_diff
       FROM discrepancies`,
    )
    .get() as { total_discrepancies: number; total_sales_diff: number; total_tips_diff: number };

  // Over/under breakdown (positive diff = overreported, negative = underreported)
  const over = db
    .prepare(
      `SELECT
         COALESCE(SUM(sales_diff), 0) as overreported_sales_total,
         COUNT(*) as overreported_count
       FROM discrepancies
       WHERE sales_diff > 0`,
    )
    .get() as { overreported_sales_total: number; overreported_count: number };

  const under = db
    .prepare(
      `SELECT
         COALESCE(SUM(ABS(sales_diff)), 0) as underreported_sales_total,
         COUNT(*) as underreported_count
       FROM discrepancies
       WHERE sales_diff < 0`,
    )
    .get() as { underreported_sales_total: number; underreported_count: number };

  return {
    total_reports: totalReports,
    total_reconciled: totalReconciled,
    total_discrepancies: agg.total_discrepancies,
    total_sales_diff: agg.total_sales_diff,
    total_tips_diff: agg.total_tips_diff,
    overreported_count: over.overreported_count,
    underreported_count: under.underreported_count,
    overreported_sales_total: over.overreported_sales_total,
    underreported_sales_total: under.underreported_sales_total,
  };
}
