import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { listProperties, createOpening } from "../lib/api";
import type { Property } from "../lib/api";
import { Sidebar } from "../components/Sidebar";

const OPENING_TYPES = [
  { value: "door", label: "Door" },
  { value: "overhead_door", label: "Overhead Door" },
  { value: "loading_dock", label: "Loading Dock" },
  { value: "gate", label: "Gate" },
  { value: "automatic_entrance", label: "Automatic Entrance" },
  { value: "access_control_point", label: "Access Control Point" },
];

export function NewOpeningPage() {
  const navigate = useNavigate();
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [buildingId, setBuildingId] = useState("");

  const [openingCode, setOpeningCode] = useState("");
  const [openingType, setOpeningType] = useState("door");
  const [floorLabel, setFloorLabel] = useState("");
  const [locationDescription, setLocationDescription] = useState("");
  const [fireRated, setFireRated] = useState(false);
  const [lifeSafetyCritical, setLifeSafetyCritical] = useState(false);
  const [isElectrified, setIsElectrified] = useState(false);
  const [installDate, setInstallDate] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ code: string } | null>(null);
  const [addAnother, setAddAnother] = useState(true);

  useEffect(() => {
    listProperties()
      .then(setProperties)
      .catch(() => setError("Couldn't load your properties. Check your connection and try again."));
  }, []);

  const buildingsForProperty = properties.find((p) => p.id === propertyId)?.buildings ?? [];

  function resetOpeningFields() {
    setOpeningCode("");
    setOpeningType("door");
    setFloorLabel("");
    setLocationDescription("");
    setFireRated(false);
    setLifeSafetyCritical(false);
    setIsElectrified(false);
    setInstallDate("");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!buildingId) return;
    setSubmitting(true);
    setError(null);
    setJustCreated(null);
    try {
      await createOpening({
        opening_code: openingCode,
        building_id: buildingId,
        opening_type: openingType,
        floor_label: floorLabel || undefined,
        location_description: locationDescription || undefined,
        fire_rated: fireRated,
        life_safety_critical: lifeSafetyCritical,
        is_electrified: isElectrified,
        install_date: installDate || undefined,
      });
      setJustCreated({ code: openingCode });
      if (addAnother) {
        resetOpeningFields();
      } else {
        setTimeout(() => navigate("/"), 700);
      }
    } catch (err: any) {
      setError(
        err?.message === "opening_code already exists"
          ? "That opening code is already in use — codes must be unique across your whole portfolio."
          : "Couldn't create the opening. Check your connection and try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main" style={{ maxWidth: 620 }}>
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        <div className="panel">
          <h2 style={{ marginBottom: 4 }}>New Opening</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20 }}>
            Add a single door, gate, or other opening by hand — no CSV needed. For a whole building's worth
            at once, use <a href="/openings/import">Import Openings</a> instead.
          </p>

          <div className="filter-bar" style={{ marginBottom: 20 }}>
            <select value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setBuildingId(""); }}>
              <option value="">Select property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} disabled={!propertyId}>
              <option value="">Select building…</option>
              {buildingsForProperty.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          {properties.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              No properties yet — <a href="/properties/new">create one first</a>.
            </p>
          )}

          {justCreated && (
            <div className="card" style={{ marginBottom: 16, borderLeft: "3px solid var(--success)" }}>
              <span style={{ color: "var(--success)", fontWeight: 600 }}>Created:</span> {justCreated.code}
            </div>
          )}

          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="opening-code">Opening code</label>
              <input
                id="opening-code"
                value={openingCode}
                onChange={(e) => setOpeningCode(e.target.value)}
                placeholder="e.g. AZ-PHX-BLDGA-F01-0001"
                required
                disabled={!buildingId}
              />
            </div>
            <div className="field">
              <label htmlFor="opening-type">Type</label>
              <select id="opening-type" value={openingType} onChange={(e) => setOpeningType(e.target.value)} disabled={!buildingId}>
                {OPENING_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="floor-label">Floor</label>
                <input id="floor-label" value={floorLabel} onChange={(e) => setFloorLabel(e.target.value)} placeholder="e.g. F01" disabled={!buildingId} />
              </div>
              <div className="field" style={{ flex: 2 }}>
                <label htmlFor="location-description">Location</label>
                <input id="location-description" value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} placeholder="e.g. East stairwell door" disabled={!buildingId} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="install-date">Install date (if known)</label>
              <input id="install-date" type="date" value={installDate} onChange={(e) => setInstallDate(e.target.value)} disabled={!buildingId} />
            </div>

            <div className="field">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: buildingId ? "pointer" : "default" }}>
                <input type="checkbox" checked={fireRated} onChange={(e) => setFireRated(e.target.checked)} disabled={!buildingId} style={{ height: "auto" }} />
                Fire rated
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, cursor: buildingId ? "pointer" : "default" }}>
                <input type="checkbox" checked={lifeSafetyCritical} onChange={(e) => setLifeSafetyCritical(e.target.checked)} disabled={!buildingId} style={{ height: "auto" }} />
                Life-safety critical
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, cursor: buildingId ? "pointer" : "default" }}>
                <input type="checkbox" checked={isElectrified} onChange={(e) => setIsElectrified(e.target.checked)} disabled={!buildingId} style={{ height: "auto" }} />
                Electrified
              </label>
            </div>

            {error && <p className="error-text">{error}</p>}

            <button type="submit" className="btn btn-primary" disabled={submitting || !buildingId || !openingCode}>
              {submitting ? "Creating…" : "Create Opening"}
            </button>

            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={addAnother} onChange={(e) => setAddAnother(e.target.checked)} style={{ height: "auto" }} />
              Keep this building selected and clear the form to add another
            </label>
          </form>
        </div>
      </div>
    </div>
  );
}
