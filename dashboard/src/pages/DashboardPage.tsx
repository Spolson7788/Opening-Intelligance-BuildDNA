import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { listOpenings, listProperties, downloadOpeningsCsv, downloadComplianceReport } from "../lib/api";
import type { Opening, Property } from "../lib/api";
import { Sidebar } from "../components/Sidebar";
import { HealthPill, healthBand } from "../components/HealthPill";
import { HealthDistributionChart } from "../components/HealthDistributionChart";
import { useAuth } from "../lib/AuthContext";

const OPENING_TYPES = [
  { value: "", label: "All types" },
  { value: "door", label: "Door" },
  { value: "overhead_door", label: "Overhead Door" },
  { value: "loading_dock", label: "Loading Dock" },
  { value: "gate", label: "Gate" },
  { value: "automatic_entrance", label: "Automatic Entrance" },
  { value: "access_control_point", label: "Access Control" },
];

type SortKey = "opening_code" | "opening_type" | "health_score";
type SortDir = "asc" | "desc";

export function DashboardPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  // Mirrors the server-side rule in src/middleware/permissions.ts: only
  // admin/facilities_manager can create openings, properties, or run bulk
  // imports. This is a UX nicety, not the actual security boundary — the
  // API enforces this regardless of what the dashboard shows or hides.
  const canManageSetup = auth?.role === "admin" || auth?.role === "facilities_manager";
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [propertyFilter, setPropertyFilter] = useState("");
  const [buildingFilter, setBuildingFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [maxHealthFilter, setMaxHealthFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("health_score");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [exporting, setExporting] = useState(false);

  async function onExport() {
    setExporting(true);
    try {
      const params: Record<string, string> = {};
      if (typeFilter) params.opening_type = typeFilter;
      if (maxHealthFilter) params.max_health_score = maxHealthFilter;
      if (buildingFilter) params.building_id = buildingFilter;
      else if (propertyFilter) params.property_id = propertyFilter;
      await downloadOpeningsCsv(params);
    } catch {
      setError("Export failed. Try again.");
    } finally {
      setExporting(false);
    }
  }

  const [generatingReport, setGeneratingReport] = useState(false);

  async function onComplianceReport() {
    if (!propertyFilter) return;
    setGeneratingReport(true);
    try {
      await downloadComplianceReport(propertyFilter);
    } catch (err: any) {
      setError(
        err?.message === "no_openings_in_scope"
          ? "No fire-rated or life-safety openings found for this property yet."
          : "Couldn't generate the report. Try again."
      );
    } finally {
      setGeneratingReport(false);
    }
  }

  useEffect(() => {
    listProperties().catch(() => []).then((props) => setProperties(props ?? []));
  }, []);

  const buildingsForSelectedProperty = useMemo(() => {
    return properties.find((p) => p.id === propertyFilter)?.buildings ?? [];
  }, [properties, propertyFilter]);

  function onPropertyChange(propertyId: string) {
    setPropertyFilter(propertyId);
    setBuildingFilter(""); // reset building filter — it no longer applies to the new property
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, string> = {};
    if (typeFilter) params.opening_type = typeFilter;
    if (maxHealthFilter) params.max_health_score = maxHealthFilter;
    if (buildingFilter) params.building_id = buildingFilter;
    else if (propertyFilter) params.property_id = propertyFilter;

    listOpenings(params)
      .then(setOpenings)
      .catch(() => setError("Couldn't load openings. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, [typeFilter, maxHealthFilter, propertyFilter, buildingFilter]);

  const sorted = useMemo(() => {
    const copy = [...openings];
    copy.sort((a, b) => {
      let av: string | number = a[sortKey] ?? (sortKey === "health_score" ? 999 : "");
      let bv: string | number = b[sortKey] ?? (sortKey === "health_score" ? 999 : "");
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [openings, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const totalOpenings = openings.length;
  const scored = openings.filter((o) => o.health_score !== null && o.health_score !== undefined);
  const avgHealth = scored.length ? Math.round(scored.reduce((s, o) => s + (o.health_score ?? 0), 0) / scored.length) : null;
  const needsAttention = openings.filter((o) => healthBand(o.health_score) === "poor").length;
  const fireRatedCount = openings.filter((o) => o.fire_rated).length;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <div className="page-header">
          <div>
            <h1>Portfolio Overview</h1>
            <p>{totalOpenings} openings tracked across your portfolio</p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link
              to="/work-orders"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Work Orders
            </Link>
            <Link
              to="/maintenance-schedules"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Maintenance Schedules
            </Link>
            {canManageSetup && (
              <Link
                to="/audit-log"
                className="btn btn-secondary"
                style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
              >
                Audit Log
              </Link>
            )}
            <Link
              to="/team"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Team
            </Link>
            <Link
              to="/compliance-alerts"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Alerts
            </Link>
            <Link
              to="/capital-forecast"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Capital Forecast
            </Link>
            <Link
              to="/openings/print-labels"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Print Labels
            </Link>
            {canManageSetup && (
              <>
                <Link
                  to="/openings/new"
                  className="btn btn-secondary"
                  style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
                >
                  + New Opening
                </Link>
                <Link
                  to="/openings/import"
                  className="btn btn-secondary"
                  style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
                >
                  Import Openings
                </Link>
                <Link
                  to="/hardware/import"
                  className="btn btn-secondary"
                  style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
                >
                  Import Hardware
                </Link>
                <Link
                  to="/properties/new"
                  className="btn btn-primary"
                  style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
                >
                  + New Property
                </Link>
              </>
            )}
          </div>
        </div>

        <div className="stat-row">
          <div className="stat-card">
            <div className="label">Total Openings</div>
            <div className="value">{totalOpenings}</div>
          </div>
          <div className="stat-card">
            <div className="label">Avg Health Score</div>
            <div className="value">{avgHealth ?? "—"}</div>
          </div>
          <div className={`stat-card ${needsAttention > 0 ? "alert" : ""}`}>
            <div className="label">Needs Attention</div>
            <div className="value">{needsAttention}</div>
          </div>
          <div className="stat-card">
            <div className="label">Fire-Rated Openings</div>
            <div className="value">{fireRatedCount}</div>
          </div>
        </div>

        <div className="panel">
          <h2>Health Score Distribution</h2>
          <HealthDistributionChart openings={openings} />
        </div>

        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ marginBottom: 0 }}>Openings</h2>
            <button
              onClick={onExport}
              disabled={exporting || sorted.length === 0}
              style={{
                height: 32, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)",
                fontSize: 12.5, fontWeight: 600, padding: "0 12px", cursor: "pointer",
              }}
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
            <button
              onClick={onComplianceReport}
              disabled={generatingReport || !propertyFilter}
              title={!propertyFilter ? "Select a property first" : "Fire door & life safety compliance report"}
              style={{
                height: 32, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)",
                fontSize: 12.5, fontWeight: 600, padding: "0 12px", cursor: propertyFilter ? "pointer" : "not-allowed",
                marginLeft: 8, opacity: propertyFilter ? 1 : 0.5,
              }}
            >
              {generatingReport ? "Generating…" : "Compliance Report (PDF)"}
            </button>
          </div>
          <div className="filter-bar">
            <select value={propertyFilter} onChange={(e) => onPropertyChange(e.target.value)}>
              <option value="">All properties</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select value={buildingFilter} onChange={(e) => setBuildingFilter(e.target.value)} disabled={!propertyFilter}>
              <option value="">All buildings</option>
              {buildingsForSelectedProperty.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              {OPENING_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <select value={maxHealthFilter} onChange={(e) => setMaxHealthFilter(e.target.value)}>
              <option value="">All health scores</option>
              <option value="49">Needs attention (≤49)</option>
              <option value="74">Below good (≤74)</option>
            </select>
          </div>

          {loading ? (
            <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>Loading…</p>
          ) : error ? (
            <p className="error-text">{error}</p>
          ) : sorted.length === 0 ? (
            <div className="empty-state">No openings match these filters.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th onClick={() => toggleSort("opening_code")}>
                    Code {sortKey === "opening_code" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th>Location</th>
                  <th onClick={() => toggleSort("opening_type")}>
                    Type {sortKey === "opening_type" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => toggleSort("health_score")}>
                    Health {sortKey === "health_score" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => (
                  <tr key={o.id} onClick={() => navigate(`/opening/${o.id}`)} style={{ cursor: "pointer" }}>
                    <td>
                      <span className="asset-plate">{o.opening_code}</span>
                      {o.fire_rated && <span className="badge-fire">FIRE</span>}
                    </td>
                    <td>{o.location_description || `Floor ${o.floor_label || "—"}`}</td>
                    <td style={{ textTransform: "capitalize" }}>{o.opening_type.replace(/_/g, " ")}</td>
                    <td><HealthPill score={o.health_score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
