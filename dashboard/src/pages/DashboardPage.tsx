import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link, useLocation } from "react-router-dom";
import { listOpenings, listProperties, listCompanies, downloadOpeningsCsv, downloadComplianceReport, fetchCapitalForecastRollup, fetchComplianceAlerts } from "../lib/api";
import type { ComplianceAlertsResult, Opening, Property } from "../lib/api";
import { facilitiesErrorMessage } from "../lib/scheduleUi";
import { Sidebar } from "../components/Sidebar";
import { HealthPill } from "../components/HealthPill";
import { useAuth } from "../lib/AuthContext";
import { useLocations } from "../lib/LocationContext";
import { CreateLocationPicker, useCreateTarget } from "../components/LocationBar";
import { groupByLocation, rollupByLocation } from "../lib/locationScope";
import { countBands, countyBadge, formatUsd, groupByStateCounty, needsAttentionCount, summarizeCorrectiveWork } from "../lib/portfolioOverview";
import { scrollToOpeningsWhenReady } from "../lib/scrollToOpenings";

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
  const location = useLocation();
  const { auth } = useAuth();
  // Mirrors the server-side rule in src/middleware/permissions.ts: only
  // admin/facilities_manager can create openings, properties, or run bulk
  // imports. This is a UX nicety, not the actual security boundary — the
  // API enforces this regardless of what the dashboard shows or hides.
  const canManageSetup = auth?.role === "admin" || auth?.role === "facilities_manager";
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
  const [newOpen, setNewOpen] = useState(false);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [corrective, setCorrective] = useState<{ knownCost: number; awaitingEstimate: number } | null | undefined>(undefined);
  const [compliance, setCompliance] = useState<ComplianceAlertsResult | null | undefined>(undefined);

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
    if (location.hash !== "#openings") return;
    void scrollToOpeningsWhenReady();
  }, [location.hash]);

  useEffect(() => {
    // M3.1: failures are shown (a 401 goes to sign-in via authedFetch) instead of an empty list.
    listProperties().then((props) => { setProperties(props ?? []); setPropertiesError(null); })
      .catch((err) => setPropertiesError(facilitiesErrorMessage(err)));
    listCompanies().then((rows) => {
      const mine = rows.find((company) => company.organization_id === auth?.organizationId);
      setCompanyName(mine?.name ?? null);
    }).catch(() => setCompanyName(null));
    fetchCapitalForecastRollup()
      .then((rollup) => setCorrective(summarizeCorrectiveWork(rollup.properties ?? [])))
      .catch(() => setCorrective(null));
    fetchComplianceAlerts()
      .then(setCompliance)
      .catch(() => setCompliance(null));
  }, [auth?.organizationId]);

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
  const needsAttention = needsAttentionCount(openings.map((o) => o.health_score));
  const fireRatedCount = openings.filter((o) => o.fire_rated).length;
  const bands = countBands(openings.map((o) => o.health_score));
  const buildingCount = properties.reduce((sum, property) => sum + (property.buildings?.length ?? 0), 0);
  const areaGroups = groupByStateCounty(properties, openings);
  const bandWidth = (count: number) => (totalOpenings ? `${(count / totalOpenings) * 100}%` : "0%");

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <div className="ov-header">
          <div>
            <h1>Portfolio Overview</h1>
            <p>
              {totalOpenings} openings tracked across {properties.length} {properties.length === 1 ? "property" : "properties"}
              {companyName ? ` · ${companyName}` : ""}
            </p>
          </div>
          <div className="ov-header-actions">
            <button type="button" className="ov-btn" onClick={() => window.print()}>Print / Save as PDF</button>
            {canManageSetup && createTarget.mustChoose && (
              <span title="New openings, properties and imports go to one specific location">
                <CreateLocationPicker onChosen={() => {}} />
              </span>
            )}
            {canManageSetup && !createTarget.mustChoose && (
              <div className={"ov-new" + (newOpen ? " open" : "")} onKeyDown={(e) => { if (e.key === "Escape") setNewOpen(false); }}>
                <button type="button" className="ov-btn ov-btn-primary" aria-expanded={newOpen} aria-controls="new-menu-panel" onClick={() => setNewOpen((open) => !open)}>
                  + New
                </button>
                {newOpen && (
                  <div id="new-menu-panel" className="ov-new-panel" role="menu">
                    <Link role="menuitem" to="/properties/new" onClick={() => setNewOpen(false)}>+ New Property</Link>
                    <Link role="menuitem" to="/openings/new" onClick={() => setNewOpen(false)}>+ New Opening</Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <section className="ov-scores" aria-label="Portfolio scores">
          <article className="ov-score">
            <div className="ov-score-label">Portfolio Health Score</div>
            <div className="ov-score-value">{avgHealth ?? "Not available"}</div>
            <div className={"ov-score-sub" + (needsAttention > 0 ? " warn" : "")}>{needsAttention} {needsAttention === 1 ? "opening needs" : "openings need"} attention</div>
          </article>
          <article className="ov-score">
            <div className="ov-score-label">Openings on File</div>
            <div className="ov-score-value">{totalOpenings}</div>
            <div className="ov-score-sub">{properties.length} {properties.length === 1 ? "property" : "properties"} · {buildingCount} {buildingCount === 1 ? "building" : "buildings"}</div>
          </article>
          <article className="ov-score">
            <div className="ov-score-label">Need Attention</div>
            <div className="ov-score-value">{needsAttention}</div>
            <div className="ov-score-sub warn">below healthy threshold</div>
          </article>
          <article className="ov-score">
            <div className="ov-score-label">Fire-Rated Openings</div>
            <div className="ov-score-value">{fireRatedCount}</div>
            <div className="ov-score-sub">{totalOpenings ? `${Math.round((fireRatedCount / totalOpenings) * 100)}% of portfolio` : "Not available"}</div>
          </article>
          <article className="ov-score">
            <div className="ov-score-label">Identified Corrective Work</div>
            <div className="ov-score-value">{corrective ? formatUsd(corrective.knownCost) : corrective === null ? "Not available" : "…"}</div>
            <div className="ov-score-sub">{corrective ? `${corrective.awaitingEstimate} awaiting estimate` : "Known hardware cost"}</div>
          </article>
          <article className="ov-score">
            <div className="ov-score-label">Recorded Service This Quarter</div>
            <div className="ov-score-value">Not available</div>
            <div className="ov-score-sub">No portfolio service-cost list</div>
          </article>
        </section>

        <section className="ov-card" aria-label="Condition at a glance">
          <div className="ov-card-head">
            <h2>Condition at a glance</h2>
            <p>Every opening on file, bucketed by its health score.</p>
          </div>
          <div className="ov-bar" title={`Healthy ${bands.healthy} · Monitor ${bands.monitor} · Serious ${bands.serious} · Critical ${bands.critical} · Not assessed ${bands.unassessed}`}>
            <span className="seg-healthy" style={{ width: bandWidth(bands.healthy) }} />
            <span className="seg-monitor" style={{ width: bandWidth(bands.monitor) }} />
            <span className="seg-serious" style={{ width: bandWidth(bands.serious) }} />
            <span className="seg-critical" style={{ width: bandWidth(bands.critical) }} />
            <span className="seg-none" style={{ width: bandWidth(bands.unassessed) }} />
          </div>
          <div className="ov-legend">
            <span><i className="dot healthy" /> Healthy <strong>{bands.healthy}</strong></span>
            <span><i className="dot monitor" /> Monitor <strong>{bands.monitor}</strong></span>
            <span><i className="dot serious" /> Serious <strong>{bands.serious}</strong></span>
            <span><i className="dot critical" /> Critical <strong>{bands.critical}</strong></span>
            <span><i className="dot none" /> Not assessed <strong>{bands.unassessed}</strong></span>
          </div>
        </section>

        <div className="ov-split">
          <section className="ov-card" aria-label="Properties by state and county">
            <div className="ov-card-head">
              <h2>Properties by state and county</h2>
              <p>Grouped summary of openings across the portfolio.</p>
            </div>
            {areaGroups.length === 0 ? <p className="ov-empty">No properties yet.</p> : areaGroups.map((state) => (
              <div className="ov-state" key={state.state}>
                <div className="ov-state-name"><span>{state.state}</span><span>{state.openingCount} openings</span></div>
                {state.counties.map((county) => {
                  const badge = countyBadge(county.bands);
                  return (
                    <div className="ov-county" key={state.state + county.county}>
                      <span className="ov-county-name">{county.county}</span>
                      <span className="ov-county-meta">{county.propertyCount} {county.propertyCount === 1 ? "property" : "properties"} · {county.openingCount} openings</span>
                      <span className={"ov-badge " + badge.tone}>{badge.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
          <section className="ov-card" aria-label="Service and compliance">
            <div className="ov-card-head">
              <h2>Service &amp; compliance</h2>
              <p>Compliance alerts come from the portfolio list. Recent service costs are not on a portfolio list yet.</p>
            </div>
            <div className="ov-service-summary">
              {compliance === undefined ? "Loading compliance alerts…" : compliance === null ? "Compliance alerts are not available." : <><strong>{compliance.total_flagged}</strong> compliance {compliance.total_flagged === 1 ? "alert" : "alerts"} on file.</>}
            </div>
            <div className="ov-kicker">Recent service</div>
            <p className="ov-empty">Not available</p>
            {compliance && compliance.alerts.slice(0, 5).map((alert) => (
              <div className="ov-service" key={alert.id}>
                <div><span className="ov-code">{alert.opening_code}</span> — {alert.property_name}: {alert.alert_level.replace(/_/g, " ")}</div>
                <div className="ov-when">{alert.last_inspection_date ? alert.last_inspection_date.slice(0, 10) : "No inspection date"}</div>
              </div>
            ))}
          </section>
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

        <section className="ov-card" id="openings" tabIndex={-1}>
          <div className="ov-card-head">
            <div>
              <h2>Openings</h2>
              <p>Filter, group, and export the full openings list.</p>
            </div>
            <div className="ov-header-actions">
            <button
              className="ov-btn"
              data-export-openings=""
              onClick={onExport}
              disabled={exporting || sorted.length === 0 || (loc.combined && !loc.index.canExportTree)}
              title={loc.combined && !loc.index.canExportTree ? "Exports across several locations are for company admins only" : undefined}
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
            <button
              className="ov-btn"
              onClick={onComplianceReport}
              disabled={generatingReport || !propertyFilter}
              title={!propertyFilter ? "Select a property first" : "Fire door & life safety compliance report"}
            >
              {generatingReport ? "Generating…" : "Compliance Report (PDF)"}
            </button>
            </div>
          </div>
          <div className="ov-filters">
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
            <select aria-label="Property" value={propertyFilter} onChange={(e) => onPropertyChange(e.target.value)}>
              <option value="">All properties</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select aria-label="Building" value={buildingFilter} onChange={(e) => setBuildingFilter(e.target.value)} disabled={!propertyFilter}>
              <option value="">All buildings</option>
              {buildingsForSelectedProperty.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <select aria-label="Type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              {OPENING_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <select aria-label="Health" value={maxHealthFilter} onChange={(e) => setMaxHealthFilter(e.target.value)}>
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
          {!loading && !error && <p className="ov-foot">Showing {sorted.length} openings</p>}
        </section>
      </div>
    </div>
  );
}
