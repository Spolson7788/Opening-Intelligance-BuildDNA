import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { listOpenings, listProperties, downloadOpeningsCsv, downloadComplianceReport } from "../lib/api";
import type { Opening, Property } from "../lib/api";
import { facilitiesErrorMessage } from "../lib/scheduleUi";
import { Sidebar } from "../components/Sidebar";
import { HealthPill, healthBand } from "../components/HealthPill";
import { HealthDistributionChart } from "../components/HealthDistributionChart";
import { useAuth } from "../lib/AuthContext";
import { useLocations } from "../lib/LocationContext";
import { CreateLocationPicker, useCreateTarget } from "../components/LocationBar";
import { groupByLocation, rollupByLocation } from "../lib/locationScope";

const OPENING_TYPES = [
  { value: "", label: "All types" },
  { value: "door", label: "Door" },
  { value: "overhead_door", label: "Overhead Door" },
  { value: "loading_dock", label: "Loading Dock" },
  { value: "gate", label: "Gate" },
  { value: "automatic_entrance", label: "Automatic Entrance" },
  { value: "access_control_point", label: "Access Control" },
];

type SortKey = "opening_code" | "opening_type" | "health_score" | "location";
type SortDir = "asc" | "desc";

export function DashboardPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  // Mirrors the server-side rule in src/middleware/permissions.ts: only
  // admin/facilities_manager can create openings, properties, or run bulk
  // imports. This is a UX nicety, not the actual security boundary — the
  // API enforces this regardless of what the dashboard shows or hides.
  const canManageSetup = auth?.role === "admin" || auth?.role === "facilities_manager";
  // M4 v2: comparison reports are open to admin, facilities manager, technician and inspector.
  const canViewComparisons = canManageSetup || auth?.role === "technician" || auth?.role === "inspector";
  const loc = useLocations();
  const createTarget = useCreateTarget();
  const [groupBy, setGroupBy] = useState(false);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);

  const [propertyFilter, setPropertyFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [countyFilter, setCountyFilter] = useState("");
  const [groupGeo, setGroupGeo] = useState(false);
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
    // M3.1: failures are shown (a 401 goes to sign-in via authedFetch) instead of an empty list.
    listProperties().then((props) => { setProperties(props ?? []); setPropertiesError(null); })
      .catch((err) => setPropertiesError(facilitiesErrorMessage(err)));
  }, []);

  const buildingsForSelectedProperty = useMemo(() => {
    return properties.find((p) => p.id === propertyFilter)?.buildings ?? [];
  }, [properties, propertyFilter]);

  const stateOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of properties) if (p.state_code) map.set(p.state_code, p.state_name || p.state_code);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [properties]);
  const countyOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of properties) {
      if (!p.county_fips) continue;
      if (stateFilter && p.state_code !== stateFilter) continue;
      map.set(p.county_fips, p.county_name || p.county_fips);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [properties, stateFilter]);
  function facilityOf(opening: Opening) {
    return properties.find((p) => p.buildings?.some((b) => b.id === opening.building_id));
  }

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
    if (stateFilter) params.state_code = stateFilter;
    if (countyFilter) params.county_fips = countyFilter;

    listOpenings(params)
      .then((rows) => setOpenings((rows ?? []).filter(loc.inFilter)))
      .catch(() => setError("Couldn't load openings. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, [typeFilter, maxHealthFilter, propertyFilter, buildingFilter, stateFilter, countyFilter]);

  const sorted = useMemo(() => {
    const copy = [...openings];
    copy.sort((a, b) => {
      let av: string | number = sortKey === "location" ? loc.label(a) : a[sortKey] ?? (sortKey === "health_score" ? 999 : "");
      let bv: string | number = sortKey === "location" ? loc.label(b) : b[sortKey] ?? (sortKey === "health_score" ? 999 : "");
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
            <Link
              to="/facility-schedules"
              className="btn btn-secondary"
              style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
            >
              Door Schedules
            </Link>
            {canViewComparisons && (
              <Link
                to="/schedule-comparisons"
                className="btn btn-secondary"
                style={{ width: "auto", textDecoration: "none", padding: "0 16px" }}
              >
                Schedule Comparisons
              </Link>
            )}
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
            {canManageSetup && createTarget.mustChoose && (
              <span title="New openings, properties and imports go to one specific location">
                <CreateLocationPicker onChosen={() => {}} />
              </span>
            )}
            {canManageSetup && !createTarget.mustChoose && (
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

        {loc.combined && (
          <div className="panel location-rollup">
            <h2>By location</h2>
            <table>
              <thead><tr><th>Location</th><th>Openings</th><th>Avg health</th><th>Needs attention</th><th>Near term</th><th></th></tr></thead>
              <tbody>
                {(() => { const r = rollupByLocation(openings, loc.index); return [...r.locations, r.total].map((t) => (
                  <tr key={t.facility_id ?? t.label} style={t.facility_id ? undefined : { fontWeight: 700 }}>
                    <td>{t.label}</td><td>{t.openings}</td><td>{t.avg_health ?? "—"}</td><td>{t.urgent}</td><td>{t.near_term}</td>
                    <td>{t.facility_id && <button className="btn" onClick={() => loc.setFilter({ kind: "facility", propertyId: t.facility_id! })}>Drill down</button>}</td>
                  </tr>)); })()}
              </tbody>
            </table>
          </div>
        )}

        <div className="panel">
          <h2>Health Score Distribution</h2>
          <HealthDistributionChart openings={openings} />
        </div>

        <div className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ marginBottom: 0 }}>Openings</h2>
            <button
              onClick={onExport}
              disabled={exporting || sorted.length === 0 || (loc.combined && !loc.index.canExportTree)}
              title={loc.combined && !loc.index.canExportTree ? "Exports across several locations are for company admins only" : undefined}
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
            {loc.combined && (
              <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={groupBy} onChange={(e) => setGroupBy(e.target.checked)} /> Group by location</label>
            )}
            <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={groupGeo} onChange={(e) => setGroupGeo(e.target.checked)} /> Group by state and county</label>
            <select aria-label="State" value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setCountyFilter(""); }}>
              <option value="">All states</option>
              {stateOptions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            <select aria-label="County" value={countyFilter} onChange={(e) => setCountyFilter(e.target.value)}>
              <option value="">All counties</option>
              {countyOptions.map(([fips, name]) => <option key={fips} value={fips}>{name}</option>)}
            </select>
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

          {propertiesError && <p className="error-text" role="alert">{propertiesError}</p>}
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
                  <th onClick={() => toggleSort("location")}>
                    Location {sortKey === "location" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th>State</th>
                  <th>County</th>
                  <th>Area</th>
                  <th onClick={() => toggleSort("opening_type")}>
                    Type {sortKey === "opening_type" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                  <th onClick={() => toggleSort("health_score")}>
                    Health {sortKey === "health_score" && (sortDir === "asc" ? "↑" : "↓")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(groupGeo
                  ? [...sorted.reduce((map, opening) => {
                      const facility = facilityOf(opening);
                      const key = `${facility?.state_name ?? "State not set"} / ${facility?.county_name ?? "County not set"}`;
                      map.set(key, [...(map.get(key) ?? []), opening]);
                      return map;
                    }, new Map<string, Opening[]>())].sort((a, b) => a[0].localeCompare(b[0]))
                  : groupBy ? groupByLocation(sorted, loc.index) : [["", sorted] as [string, Opening[]]]
                ).flatMap(([group, rows]) => [
                  ...(group ? [<tr key={"g:" + group} className="group-row"><td colSpan={7} style={{ fontWeight: 700 }}>{group} ({rows.length})</td></tr>] : []),
                  ...rows.map((o) => (
                  <tr key={o.id} onClick={() => navigate(`/opening/${o.id}`)} style={{ cursor: "pointer" }}>
                    <td>
                      <span className="asset-plate">{o.opening_code}</span>
                      {o.fire_rated && <span className="badge-fire">FIRE</span>}
                    </td>
                    <td>{loc.label(o)}</td>
                    <td>{facilityOf(o)?.state_name ?? "—"}</td>
                    <td>{facilityOf(o)?.county_name ?? "—"}</td>
                    <td>{o.location_description || `Floor ${o.floor_label || "—"}`}</td>
                    <td style={{ textTransform: "capitalize" }}>{o.opening_type.replace(/_/g, " ")}</td>
                    <td><HealthPill score={o.health_score} /></td>
                  </tr>
                ))])}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
