import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { listProperties, fetchCapitalForecast, fetchCapitalForecastRollup, downloadCapitalForecastPdf } from "../lib/api";
import type { Property, CapitalForecastResult, CapitalForecastRollupProperty } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

const OPENING_TYPE_LABELS: Record<string, string> = {
  door: "Door",
  overhead_door: "Overhead Door",
  loading_dock: "Loading Dock",
  gate: "Gate",
  automatic_entrance: "Automatic Entrance",
  access_control_point: "Access Control Point",
};

const DEFAULT_COSTS: Record<string, number> = {
  door: 800,
  overhead_door: 3500,
  loading_dock: 4000,
  gate: 1200,
  automatic_entrance: 2500,
  access_control_point: 600,
};

const BUCKET_ORDER: Array<{ key: "urgent" | "near_term" | "healthy" | "unassessed"; color: string }> = [
  { key: "urgent", color: "#C93838" },
  { key: "near_term", color: "#B8790F" },
  { key: "healthy", color: "#2F8F47" },
  { key: "unassessed", color: "#6B7178" },
];

function currency(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Shared by both the single-property detail view and the all-properties
// rollup table, so the same adjustable cost assumptions produce consistent
// numbers whichever view you're looking at.
function computeForecastTotals(forecast: CapitalForecastResult, costs: Record<string, number>) {
  const bucketTotals: Record<string, number> = {};
  for (const { key } of BUCKET_ORDER) {
    const bucket = forecast.buckets[key];
    const estimatedPortion = Object.entries(bucket.needing_estimate_by_type).reduce(
      (sum, [type, count]) => sum + count * (costs[type] ?? 0),
      0
    );
    bucketTotals[key] = bucket.known_cost_total + estimatedPortion;
  }
  const grandTotal = Object.values(bucketTotals).reduce((a, b) => a + b, 0);
  const urgentPlusNearTerm = (bucketTotals.urgent ?? 0) + (bucketTotals.near_term ?? 0);
  const totalKnownCost = BUCKET_ORDER.reduce((sum, { key }) => sum + forecast.buckets[key].known_cost_total, 0);
  return { bucketTotals, grandTotal, urgentPlusNearTerm, totalKnownCost, totalEstimatedCost: grandTotal - totalKnownCost };
}

export function CapitalForecastPage() {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [forecast, setForecast] = useState<CapitalForecastResult | null>(null);
  const [rollup, setRollup] = useState<CapitalForecastRollupProperty[] | null>(null);
  const [costs, setCosts] = useState<Record<string, number>>(DEFAULT_COSTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function onDownloadPdf() {
    setDownloading(true);
    setError(null);
    try {
      await downloadCapitalForecastPdf(propertyId || null, costs);
    } catch {
      setError("Couldn't generate the PDF. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    listProperties()
      .then(setProperties)
      .catch(() => setError("Couldn't load your properties. Check your connection and try again."));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    if (!propertyId) {
      setForecast(null);
      fetchCapitalForecastRollup()
        .then((res) => setRollup(res.properties))
        .catch(() => setError("Couldn't load the portfolio rollup. Check your connection and try again."))
        .finally(() => setLoading(false));
      return;
    }
    setRollup(null);
    fetchCapitalForecast(propertyId)
      .then(setForecast)
      .catch(() => setError("Couldn't load the forecast. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, [propertyId]);

  const computed = useMemo(() => (forecast ? computeForecastTotals(forecast, costs) : null), [forecast, costs]);
  const bucketTotals = computed?.bucketTotals ?? null;
  const grandTotal = computed?.grandTotal ?? 0;
  const urgentPlusNearTerm = computed?.urgentPlusNearTerm ?? 0;
  const totalKnownCost = computed?.totalKnownCost ?? 0;
  const totalEstimatedCost = computed?.totalEstimatedCost ?? 0;

  const chartData = forecast
    ? BUCKET_ORDER.map(({ key, color }) => ({
        name: forecast.buckets[key].label.split(" — ")[0],
        value: bucketTotals?.[key] ?? 0,
        color,
      }))
    : [];

  const rankedRollup = useMemo(() => {
    if (!rollup) return null;
    return rollup
      .map((p) => ({ ...p, ...computeForecastTotals(p, costs) }))
      .sort((a, b) => b.grandTotal - a.grandTotal);
  }, [rollup, costs]);

  const allTypesPresent = useMemo(() => {
    if (!forecast) return [];
    const types = new Set<string>();
    for (const { key } of BUCKET_ORDER) {
      Object.keys(forecast.buckets[key].by_type).forEach((t) => types.add(t));
    }
    return Array.from(types);
  }, [forecast]);

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
            <h1>Capital Forecast</h1>
            <p>Translates health score into a multi-year replacement budget — the number to defend in a capex meeting.</p>
          </div>
        </div>

        <div className="panel">
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">All Properties (portfolio rollup)</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>}

        {rankedRollup && (
          <>
            <div className="stat-row">
              <div className="stat-card alert">
                <div className="label">Urgent + Near-Term, Whole Portfolio</div>
                <div className="value">{currency(rankedRollup.reduce((s, p) => s + p.urgentPlusNearTerm, 0))}</div>
              </div>
              <div className="stat-card">
                <div className="label">Total Portfolio Value at Risk</div>
                <div className="value">{currency(rankedRollup.reduce((s, p) => s + p.grandTotal, 0))}</div>
              </div>
              <div className="stat-card">
                <div className="label">Properties</div>
                <div className="value">{rankedRollup.length}</div>
              </div>
            </div>

            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <h2>Properties Ranked by Risk</h2>
                  <p style={{ color: "var(--text-secondary)", fontSize: 12.5, marginTop: -4, marginBottom: 12 }}>
                    Click a property to see its full breakdown. Cost assumptions below apply across the whole rollup.
                  </p>
                </div>
                <button className="btn btn-secondary" style={{ width: "auto", padding: "0 16px" }} onClick={onDownloadPdf} disabled={downloading}>
                  {downloading ? "Generating…" : "Download PDF"}
                </button>
              </div>
              {rankedRollup.every((p) => p.total_openings === 0) ? (
                <div className="empty-state">No openings in your portfolio yet.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Openings</th>
                      <th>Urgent + Near-Term</th>
                      <th>Total at Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedRollup.map((p) => (
                      <tr key={p.property_id} onClick={() => setPropertyId(p.property_id)} style={{ cursor: "pointer" }}>
                        <td>{p.property_name}</td>
                        <td>{p.total_openings}</td>
                        <td style={{ color: p.urgentPlusNearTerm > 0 ? "var(--danger)" : undefined }}>{currency(p.urgentPlusNearTerm)}</td>
                        <td style={{ fontWeight: 600 }}>{currency(p.grandTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <h2>Cost Assumptions (per unit — applies across the whole rollup)</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {Object.keys(DEFAULT_COSTS).map((type) => (
                  <div className="field" key={type} style={{ marginBottom: 0 }}>
                    <label htmlFor={`rollup-cost-${type}`}>{OPENING_TYPE_LABELS[type] || type}</label>
                    <input
                      id={`rollup-cost-${type}`}
                      type="number"
                      min={0}
                      value={costs[type] ?? 0}
                      onChange={(e) => setCosts((prev) => ({ ...prev, [type]: Number(e.target.value) || 0 }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {forecast && bucketTotals && (
          <>
            <div className="stat-row">
              <div className="stat-card alert">
                <div className="label">Urgent + Near-Term (0-3 yrs)</div>
                <div className="value">{currency(urgentPlusNearTerm)}</div>
              </div>
              <div className="stat-card">
                <div className="label">Total Portfolio Value at Risk</div>
                <div className="value">{currency(grandTotal)}</div>
              </div>
              <div className="stat-card">
                <div className="label">Openings Assessed</div>
                <div className="value">{forecast.total_openings - forecast.buckets.unassessed.total} / {forecast.total_openings}</div>
              </div>
            </div>

            {totalKnownCost > 0 && (
              <p style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: -8, marginBottom: 16 }}>
                {currency(totalKnownCost)} based on real priced hardware parts on file · {currency(totalEstimatedCost)} from the adjustable per-type estimate below (for openings without priced parts yet)
              </p>
            )}

            <div className="panel">
              <h2>Estimated Replacement Cost by Timeline</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 10, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--text-secondary)" }} axisLine={{ stroke: "var(--border)" }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "var(--text-secondary)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(value) => [currency(Number(value)), "Estimated cost"]} contentStyle={{ fontSize: 13, borderRadius: 6, border: "1px solid var(--border)" }} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <h2 style={{ margin: 0 }}>Breakdown by Timeline & Type</h2>
                <button className="btn btn-secondary" style={{ width: "auto", padding: "0 16px" }} onClick={onDownloadPdf} disabled={downloading}>
                  {downloading ? "Generating…" : "Download PDF"}
                </button>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Timeline</th>
                    {allTypesPresent.map((t) => <th key={t}>{OPENING_TYPE_LABELS[t] || t}</th>)}
                    <th>Est. Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {BUCKET_ORDER.map(({ key }) => {
                    const bucket = forecast.buckets[key];
                    if (bucket.total === 0) return null;
                    return (
                      <tr key={key}>
                        <td>{bucket.label}</td>
                        {allTypesPresent.map((t) => (
                          <td key={t}>{bucket.by_type[t] || "—"}</td>
                        ))}
                        <td style={{ fontWeight: 600 }}>{currency(bucketTotals[key])}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="panel">
              <h2>Cost Assumptions (per unit — adjust to match your market)</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {allTypesPresent.map((type) => (
                  <div className="field" key={type} style={{ marginBottom: 0 }}>
                    <label htmlFor={`cost-${type}`}>{OPENING_TYPE_LABELS[type] || type}</label>
                    <input
                      id={`cost-${type}`}
                      type="number"
                      min={0}
                      value={costs[type] ?? 0}
                      onChange={(e) => setCosts((prev) => ({ ...prev, [type]: Number(e.target.value) || 0 }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
