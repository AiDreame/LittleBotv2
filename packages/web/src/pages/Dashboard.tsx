import { useState, useEffect } from "react";

interface ReconciliationSummary {
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

interface DiscrepancyDetail {
  id: number;
  chatter_name: string;
  chatter_discord_id: string;
  sales_diff: number;
  tips_diff: number;
  reported_sales: number;
  reported_tips: number;
  actual_sales: number;
  actual_tips: number;
  actual_date: string;
  flagged_at: string;
}

export default function Dashboard() {
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [recent, setRecent] = useState<DiscrepancyDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [sumRes, discRes] = await Promise.all([
          fetch("/api/reconciliation/summary"),
          fetch("/api/reconciliation/discrepancies"),
        ]);

        if (!sumRes.ok) throw new Error(`Summary: ${sumRes.status}`);
        if (!discRes.ok) throw new Error(`Discrepancies: ${discRes.status}`);

        const sumData = await sumRes.json();
        const discData = await discRes.json();

        setSummary(sumData as ReconciliationSummary);
        // Only show last 10
        setRecent(
          ((discData as { data: DiscrepancyDetail[] }).data ?? []).slice(0, 10),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  if (loading) {
    return <div className="page-loading">Loading dashboard…</div>;
  }

  if (error) {
    return <div className="page-error">Error: {error}</div>;
  }

  const s = summary!;

  return (
    <div className="page">
      <h2 className="page-title">Dashboard</h2>

      {/* ── Summary cards ── */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-value">{s.total_reports}</div>
          <div className="summary-label">Total Reports</div>
        </div>
        <div className="summary-card highlight-warn">
          <div className="summary-value">{s.total_discrepancies}</div>
          <div className="summary-label">Discrepancies</div>
        </div>
        <div className="summary-card">
          <div className="summary-value">
            ${Math.abs(s.total_sales_diff).toLocaleString()}
          </div>
          <div className="summary-label">Total $ Off</div>
        </div>
        <div className="summary-card">
          <div className="summary-value">{s.total_reconciled}</div>
          <div className="summary-label">Reconciled</div>
        </div>
      </div>

      {/* ── Over / Under breakdown ── */}
      <div className="summary-grid">
        <div className="summary-card over-bg">
          <div className="summary-value">{s.overreported_count}</div>
          <div className="summary-label">Overreported</div>
          <div className="summary-sub">
            +${s.overreported_sales_total.toLocaleString()}
          </div>
        </div>
        <div className="summary-card under-bg">
          <div className="summary-value">{s.underreported_count}</div>
          <div className="summary-label">Underreported</div>
          <div className="summary-sub">
            -${s.underreported_sales_total.toLocaleString()}
          </div>
        </div>
      </div>

      {/* ── Recent discrepancies ── */}
      <div className="card">
        <h3 className="card-title">Recent Discrepancies</h3>
        {recent.length === 0 ? (
          <p className="empty">No discrepancies found.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Chatter</th>
                <th>Date</th>
                <th>Reported $</th>
                <th>Actual $</th>
                <th>Sales Diff</th>
                <th>Tips Diff</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((d) => (
                <tr key={d.id} className={rowClass(d.sales_diff)}>
                  <td>{d.chatter_name}</td>
                  <td>{d.actual_date}</td>
                  <td>${d.reported_sales.toLocaleString()}</td>
                  <td>${d.actual_sales.toLocaleString()}</td>
                  <td>
                    {d.sales_diff > 0 ? "+" : ""}
                    {d.sales_diff.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                    })}
                  </td>
                  <td>
                    {d.tips_diff > 0 ? "+" : ""}
                    {d.tips_diff.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                    })}
                  </td>
                  <td>
                    <span className={`status-badge ${statusBadge(d.sales_diff)}`}>
                      {statusLabel(d.sales_diff)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function rowClass(salesDiff: number): string {
  if (salesDiff > 0) return "row-over";
  if (salesDiff < 0) return "row-under";
  return "row-ok";
}

function statusBadge(salesDiff: number): string {
  if (salesDiff > 0) return "badge-over";
  if (salesDiff < 0) return "badge-under";
  return "badge-ok";
}

function statusLabel(salesDiff: number): string {
  if (salesDiff > 0) return "Over";
  if (salesDiff < 0) return "Under";
  return "Match";
}
