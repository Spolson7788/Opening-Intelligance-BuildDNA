import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listProperties, fetchQrCodesForBuilding } from "../lib/api";
import type { Property, QrLabelItem } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

export function PrintLabelsPage() {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [buildingId, setBuildingId] = useState("");
  const [items, setItems] = useState<QrLabelItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProperties()
      .then(setProperties)
      .catch(() => setError("Couldn't load your properties. Check your connection and try again."));
  }, []);

  const buildingsForProperty = properties.find((p) => p.id === propertyId)?.buildings ?? [];

  async function onLoad() {
    if (!buildingId) return;
    setLoading(true);
    setError(null);
    setItems(null);
    try {
      const res = await fetchQrCodesForBuilding(buildingId);
      if (res.count === 0) {
        setError("This building has no openings yet — nothing to print. Import or add openings first.");
      } else {
        setItems(res.items);
      }
    } catch {
      setError("Couldn't load QR codes. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main print-labels-main">
        <div className="no-print">
          <button
            onClick={() => navigate("/")}
            style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
          >
            ← Back to Portfolio
          </button>

          <div className="panel">
            <h2 style={{ marginBottom: 4 }}>Print QR Labels</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20 }}>
              Generates a printable sheet — one QR code and opening code per label. Cut and tag each door,
              or hand the sheet to whoever's doing the physical walk.
            </p>

            <div className="filter-bar" style={{ marginBottom: 16 }}>
              <select
                value={propertyId}
                onChange={(e) => { setPropertyId(e.target.value); setBuildingId(""); setItems(null); }}
              >
                <option value="">Select property…</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select value={buildingId} onChange={(e) => { setBuildingId(e.target.value); setItems(null); }} disabled={!propertyId}>
                <option value="">Select building…</option>
                {buildingsForProperty.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <button className="btn" style={{ width: "auto" }} onClick={onLoad} disabled={!buildingId || loading}>
                {loading ? "Loading…" : "Load QR Codes"}
              </button>
            </div>

            {error && <p className="error-text">{error}</p>}

            {items && items.length > 0 && (
              <>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                  {items.length} label{items.length === 1 ? "" : "s"} ready.
                </p>
                <button className="btn btn-primary" onClick={() => window.print()}>
                  Print / Save as PDF
                </button>
              </>
            )}
          </div>
        </div>

        {items && items.length > 0 && (
          <div className="label-sheet">
            {items.map((item) => (
              <div className="label-card" key={item.id}>
                <img src={item.qr_data_url} alt="" className="label-qr" />
                <div className="label-code">{item.opening_code}</div>
                {item.location_description && <div className="label-location">{item.location_description}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
