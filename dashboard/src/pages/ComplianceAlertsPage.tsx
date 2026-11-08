import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listProperties, fetchComplianceAlerts, fetchWarrantyAlerts } from "../lib/api";
import type { Property, ComplianceAlertsResult, WarrantyAlertsResult } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

const INSPECTION_LEVEL_STYLES: Record<string, { label: string; className: string }> = {
  never_inspected: { label: "Never Inspected", className: "health-poor" },
  overdue: { label: "Overdue", className: "health-poor" },
  due_soon: { label: "Due Soon", className: "health-fair" },
};

const WARRANTY_LEVEL_STYLES: Record<string, { label: string; className: string }> = {
  expired: { label: "Expired", className: "health-poor" },
  expiring_soon: { label: "Expiring Soon", className: "health-fair" },
};

type Tab = "inspections" | "warranties";

export function ComplianceAlertsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("inspections");
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [inspectionResult, setInspectionResult] = useState<ComplianceAlertsResult | null>(null);
  const [warrantyResult, setWarrantyResult] = useState<WarrantyAlertsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProperties()
      .then(setProperties)
      .catch(() => setError("Couldn't load your properties. Check your connection and try again."));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const fetchFn = tab === "inspections" ? fetchComplianceAlerts : fetchWarrantyAlerts;
    fetchFn(propertyId || undefined)
      .then((res) => (tab === "inspections" ? setInspectionResult(res as ComplianceAlertsResult) : setWarrantyResult(res as WarrantyAlertsResult)))
      .catch(() => setError("Couldn't load alerts. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, [propertyId, tab]);

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        <div className="page-header">
          <div>
            <h1>Alerts</h1>
            <p>Things that need attention before they become a problem — inspections and hardware warranties.</p>
          </div>
        </div>

        <div className="panel">
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button
              className={tab === "inspections" ? "btn btn-primary" : "btn btn-secondary"}
              style={{ width: "auto", padding: "0 16px" }}
              onClick={() => setTab("inspections")}
            >
              Inspections
            </button>
            <button
              className={tab === "warranties" ? "btn btn-primary" : "btn btn-secondary"}
              style={{ width: "auto", padding: "0 16px" }}
              onClick={() => setTab("warranties")}
            >
              Warranties
            </button>
          </div>
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">All properties</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>}

        {tab === "inspections" && inspectionResult && (
          <>
            <div className="stat-row">
              <div className={`stat-card ${inspectionResult.counts.never_inspected > 0 ? "alert" : ""}`}>
                <div className="label">Never Inspected</div>
                <div className="value">{inspectionResult.counts.never_inspected}</div>
              </div>
              <div className={`stat-card ${inspectionResult.counts.overdue > 0 ? "alert" : ""}`}>
                <div className="label">Overdue</div>
                <div className="value">{inspectionResult.counts.overdue}</div>
              </div>
              <div className="stat-card">
                <div className="label">Due Soon (30 days)</div>
                <div className="value">{inspectionResult.counts.due_soon}</div>
              </div>
              <div className="stat-card">
                <div className="label">Total Flagged</div>
                <div className="value">{inspectionResult.total_flagged}</div>
              </div>
            </div>

            <div className="panel">
              <h2>Fire-Rated / Life-Safety Openings</h2>
              <p style={{ color: "var(--text-secondary)", fontSize: 12.5, marginTop: -8, marginBottom: 12 }}>
                NFPA 80 requires annual inspection.
              </p>
              {inspectionResult.alerts.length === 0 ? (
                <div className="empty-state">Nothing flagged — every fire-rated / life-safety opening here is current.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Status</th><th>Code</th><th>Property</th><th>Building</th><th>Location</th><th>Last Inspection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspectionResult.alerts.map((a) => {
                      const style = INSPECTION_LEVEL_STYLES[a.alert_level];
                      return (
                        <tr key={a.id} onClick={() => navigate(`/opening/${a.id}`)} style={{ cursor: "pointer" }}>
                          <td><span className={`health-pill ${style.className}`}>{style.label}</span></td>
                          <td><span className="asset-plate">{a.opening_code}</span></td>
                          <td>{a.property_name}</td>
                          <td>{a.building_name}</td>
                          <td>{a.location_description || `Floor ${a.floor_label || "—"}`}</td>
                          <td>{a.last_inspection_date ? new Date(a.last_inspection_date).toLocaleDateString() : "Never"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {tab === "warranties" && warrantyResult && (
          <>
            <div className="stat-row">
              <div className={`stat-card ${warrantyResult.counts.expired > 0 ? "alert" : ""}`}>
                <div className="label">Expired</div>
                <div className="value">{warrantyResult.counts.expired}</div>
              </div>
              <div className="stat-card">
                <div className="label">Expiring Soon (90 days)</div>
                <div className="value">{warrantyResult.counts.expiring_soon}</div>
              </div>
              <div className="stat-card">
                <div className="label">Total Flagged</div>
                <div className="value">{warrantyResult.total_flagged}</div>
              </div>
            </div>

            <div className="panel">
              <h2>Hardware Warranties</h2>
              {warrantyResult.alerts.length === 0 ? (
                <div className="empty-state">Nothing flagged — no tracked warranties are expired or expiring within 90 days.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Status</th><th>Tracker</th><th>Component</th><th>Manufacturer / Model</th><th>Opening</th><th>Property</th><th>Warranty Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {warrantyResult.alerts.map((a) => {
                      const style = WARRANTY_LEVEL_STYLES[a.alert_level];
                      return (
                        <tr key={a.hardware_id} onClick={() => navigate(`/opening/${a.opening_id}`)} style={{ cursor: "pointer" }}>
                          <td><span className={`health-pill ${style.className}`}>{style.label}</span></td>
                          <td><span className="asset-plate">{a.tracker_id}</span></td>
                          <td style={{ textTransform: "capitalize" }}>{a.component_type.replace(/_/g, " ")}</td>
                          <td>{[a.manufacturer, a.model_number].filter(Boolean).join(" ") || "—"}</td>
                          <td>{a.opening_code}</td>
                          <td>{a.property_name}</td>
                          <td>{new Date(a.warranty_expiration).toLocaleDateString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
