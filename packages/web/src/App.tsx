import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Discrepancies from "./pages/Discrepancies";
import Upload from "./pages/Upload";
import Reports from "./pages/Reports";

export default function App() {
  return (
    <BrowserRouter basename="/dashboard">
      <div className="app-layout">
        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div className="sidebar-brand">
            <h1 className="logo">LittleBot</h1>
            <span className="logo-sub">Reconciliation</span>
          </div>

          <nav className="sidebar-nav">
            <NavLink to="/" end className={navClass}>
              <span className="nav-icon">📊</span>
              Dashboard
            </NavLink>
            <NavLink to="/reports" className={navClass}>
              <span className="nav-icon">📋</span>
              Reports
            </NavLink>
            <NavLink to="/discrepancies" className={navClass}>
              <span className="nav-icon">⚠️</span>
              Discrepancies
            </NavLink>
            <NavLink to="/upload" className={navClass}>
              <span className="nav-icon">📤</span>
              Upload
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              <span className="nav-icon">⚙️</span>
              Settings
            </NavLink>
          </nav>

          <div className="sidebar-footer">
            <span className="version">v0.1.0</span>
          </div>
        </aside>

        {/* ── Main content ── */}
        <div className="main-area">
          <header className="topbar">
            <select className="team-selector" defaultValue="">
              <option value="" disabled>
                Select team…
              </option>
              <option value="1">Default Team</option>
            </select>
          </header>

          <main className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/discrepancies" element={<Discrepancies />} />
              <Route path="/upload" element={<Upload />} />
              <Route
                path="/settings"
                element={
                  <div className="page-placeholder">
                    <h2>Settings</h2>
                    <p>Team and bot configuration coming soon.</p>
                  </div>
                }
              />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  );
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `nav-link${isActive ? " active" : ""}`;
}
