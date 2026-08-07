import { useState, useEffect, useCallback } from "react";

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

export default function Discrepancies() {
  const [data, setData] = useState<DiscrepancyDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minDiff, setMinDiff] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      if (minDiff) params.set("min_diff", minDiff);

      const url = `/api/reconciliation/discrepancies?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((json as { data: DiscrepancyDetail[] }).data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, minDiff]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="page">
      <h2 className="page-title">Discrepancies</h2>

      {/* ── Filters ── */}
      <div className="card filters">
        <div className="filter-row">
          <label className="filter-label">
            Date From
            <input
              type="text"
              className="filter-input"
              placeholder="YYYY-MM-DD"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="filter-label">
            Date To
            <input
              type="text"
              className="filter-input"
              placeholder="YYYY-MM-DD"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          <label className="filter-label">
            Min $ Diff
            <input
              type="number"
              className="filter-input"
              placeholder="0"
              value={minDiff}
              onChange={(e) => setMinDiff(e.target.value)}
            />
          </label>
          <button className="btn btn-secondary" onClick={fetchData}>
            Apply Filters
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="page-loading">Loading…</div>
      ) : error ? (
        <div className="page-error">{error}</div>
      ) : data.length === 0 ? (
        <div className="card">
          <p className="empty">No discrepancies found.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-count">{data.length} discrepancy entries</div>
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
              {data.map((d) => (
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
                    <span
                      className={`status-badge ${statusBadge(d.sales_diff)}`}
                    >
                      {statusLabel(d.sales_diff)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
