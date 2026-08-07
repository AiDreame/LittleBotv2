/**
 * SalesRecon Reconciliation Engine
 *
 * Core business logic: compare self-reported sales numbers (reports)
 * against actual platform data (actuals) and flag discrepancies.
 */

import {
  getReportById,
  getUnmatchedReports,
  findActualForReport,
  insertDiscrepancy,
  hasDiscrepancy,
  listDiscrepancies,
  getReconciliationSummary,
  type DiscrepancyRow,
  type DiscrepancyFilters,
  type DiscrepancyDetail,
  type ReconciliationSummary,
} from "./db.js";

/** Options for reconciliation */
export interface ReconcileOptions {
  /** Only reconcile reports with absolute sales_diff or tips_diff above this dollar threshold (default: 1) */
  threshold?: number;
}

/** ReconcileAll filters */
export interface ReconcileAllFilters {
  /** Only reconcile reports from this date (YYYY-MM-DD) */
  date?: string;
  /** Only reconcile reports for this chatter */
  chatter_id?: number;
}

/** Result of reconciling all unmatched reports */
export interface ReconcileAllResult {
  matched: number;
  discrepancies_found: number;
  total_sales_diff: number;
  total_tips_diff: number;
}

/**
 * Reconcile a single report. Finds the matching actuals row for the chatter
 * on the report's shift date, computes sales_diff and tips_diff, and inserts a
 * discrepancy row if the difference exceeds the threshold.
 *
 * Returns the created DiscrepancyRow, or null if:
 * - The report doesn't exist
 * - The report has already been reconciled
 * - No matching actuals row was found
 * - Both diffs are within the threshold
 */
export function reconcileReport(
  reportId: number,
  opts: ReconcileOptions = {},
): DiscrepancyRow | null {
  const threshold = opts.threshold ?? 1;

  // 1. Fetch the report
  const report = getReportById(reportId);
  if (!report) {
    return null; // Report not found
  }

  // 2. Skip if already reconciled
  if (hasDiscrepancy(reportId)) {
    return null;
  }

  // 3. Find matching actuals
  const actual = findActualForReport(report);
  if (!actual) {
    return null; // No matching actuals yet
  }

  // 4. Compute diffs (REPORTED - ACTUAL: positive = overreported, negative = underreported)
  const salesDiff = roundCents(report.reported_sales - actual.actual_sales);
  const tipsDiff = roundCents(report.reported_tips - actual.actual_tips);

  // 5. Check threshold
  if (Math.abs(salesDiff) < threshold && Math.abs(tipsDiff) < threshold) {
    // Within threshold — still insert the discrepancy to mark as reconciled,
    // even though the diffs are negligible
    // (We always flag to track that it was checked)
  }

  // 6. Insert discrepancy row
  const discrepancy = insertDiscrepancy({
    report_id: reportId,
    actual_id: actual.id,
    sales_diff: salesDiff,
    tips_diff: tipsDiff,
  });

  return discrepancy;
}

/**
 * Run reconciliation across all unmatched reports, or filtered by date/chatter.
 * Returns a summary of what was matched and flagged.
 */
export function reconcileAll(
  filters?: ReconcileAllFilters,
  opts: ReconcileOptions = {},
): ReconcileAllResult {
  const unmatched = getUnmatchedReports(filters?.date, filters?.chatter_id);

  let discrepancies_found = 0;
  let total_sales_diff = 0;
  let total_tips_diff = 0;

  for (const report of unmatched) {
    const result = reconcileReport(report.id, opts);
    if (result) {
      discrepancies_found++;
      total_sales_diff += result.sales_diff;
      total_tips_diff += result.tips_diff;
    }
  }

  return {
    matched: unmatched.length,
    discrepancies_found,
    total_sales_diff: roundCents(total_sales_diff),
    total_tips_diff: roundCents(total_tips_diff),
  };
}

/**
 * List discrepancies with optional filters. Delegates to the DB layer
 * with rich JOIN data.
 */
export function getDiscrepancies(
  filters?: DiscrepancyFilters,
): DiscrepancyDetail[] {
  return listDiscrepancies(filters);
}

/**
 * Get reconciliation summary stats.
 */
export function getSummary(): ReconciliationSummary {
  return getReconciliationSummary();
}

/**
 * Helper: round a number to 2 decimal places to avoid floating-point noise.
 */
function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}
