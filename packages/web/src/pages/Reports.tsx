import { useState, useEffect, useCallback } from "react";

interface ReportEntry {
  id: number;
  chatter_name: string;
  chatter_discord_id: string;
  reported_sales: number;
  reported_tips: number;
  shift_start: string;
  shift_end: string;
  message_id: string;
  created_at: string;
  status: "reconciled" | "pending";
}

export default function Reports() {
  const [data, setData] = useState<ReportEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      const url = `/api/reports?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((json as { data: ReportEntry[] }).data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="page">
      <h2 className="page-title">Reports</h2>
      <p className="page-desc">
        All self-reported logout entries from team members.
      </p>

      {/* ── Filters ── */}
      <div className="card filters">
        <div className="filter-row">
          <label className="filter-label">
            Status
            <select
              className="filter-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="reconciled">Reconciled</option>
            </select>
          </label>
          <button className="btn btn-secondary" onClick={fetchData}>
            Apply
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
          <p className="empty">No reports found.</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-count">{data.length} reports</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Chatter</th>
                <th>Shift</th>
                <th>Reported Sales</th>
                <th>Reported Tips</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>{r.chatter_name}</td>
                  <td>
                    {new Date(r.shift_start + "Z").toLocaleDateString()}{" "}
                    {new Date(r.shift_start + "Z").toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    –{" "}
                    {new Date(r.shift_end + "Z").toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>${r.reported_sales.toLocaleString()}</td>
                  <td>${r.reported_tips.toLocaleString()}</td>
                  <td>
                    <span
                      className={`status-badge ${
                        r.status === "reconciled" ? "badge-ok" : "badge-under"
                      }`}
                    >
                      {r.status}
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
