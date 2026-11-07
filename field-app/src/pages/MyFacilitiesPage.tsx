import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listFacilityOpenings, listMyFacilities } from "../lib/api";
import type { FieldFacility, FieldFacilityOpening } from "../lib/api";
import { SyncBadge } from "../components/SyncBadge";

// Group facilities by state, then county. A missing value stays visible
// as "not set" rather than being dropped.
function groupFacilities(rows: FieldFacility[]) {
  const states: Array<{
    key: string;
    label: string;
    counties: Array<{ key: string; label: string; facilities: FieldFacility[] }>;
  }> = [];
  for (const facility of rows) {
    const stateKey = facility.state_code ?? "";
    const stateLabel = facility.state_name ?? "State not set";
    let state = states.find((item) => item.key === stateKey);
    if (!state) {
      state = { key: stateKey, label: stateLabel, counties: [] };
      states.push(state);
    }
    const countyKey = facility.county_fips ?? "";
    const countyLabel = facility.county_name ?? "County not set";
    let county = state.counties.find((item) => item.key === countyKey);
    if (!county) {
      county = { key: countyKey, label: countyLabel, facilities: [] };
      state.counties.push(county);
    }
    county.facilities.push(facility);
  }
  return states;
}

export function MyFacilitiesPage() {
  const navigate = useNavigate();
  const [facilities, setFacilities] = useState<FieldFacility[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openFacilityId, setOpenFacilityId] = useState<string | null>(null);
  const [openings, setOpenings] = useState<FieldFacilityOpening[]>([]);
  const [openingsLoading, setOpeningsLoading] = useState(false);

  useEffect(() => {
    listMyFacilities()
      .then(setFacilities)
      .catch(() => setError("Couldn't load facilities — check your connection."))
      .finally(() => setLoading(false));
  }, []);

  async function toggleFacility(facilityId: string) {
    if (openFacilityId === facilityId) {
      setOpenFacilityId(null);
      setOpenings([]);
      return;
    }
    setOpenFacilityId(facilityId);
    setOpenings([]);
    setOpeningsLoading(true);
    try {
      setOpenings(await listFacilityOpenings(facilityId));
    } catch {
      setError("Couldn't load openings for that facility.");
    } finally {
      setOpeningsLoading(false);
    }
  }

  const groups = groupFacilities(facilities);

  return (
    <div className="app-shell">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate("/scan")}>
          ← Back
        </button>
        <h1>Facilities</h1>
        <SyncBadge />
      </div>
      <div className="screen">
        <p style={{ color: "var(--text-secondary)", fontSize: 14, marginTop: 0 }}>
          Grouped by state and county.
        </p>
        {error && <p className="error-text">{error}</p>}
        {loading && <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>Loading…</p>}

        {!loading && facilities.length === 0 && (
          <div className="card" style={{ textAlign: "center", color: "var(--text-secondary)" }}>
            No facilities are available to you.
          </div>
        )}

        {groups.map((state) => (
          <section key={state.key || "state-unset"}>
            <div className="section-label">{state.label}</div>
            {state.counties.map((county) => (
              <div key={county.key || "county-unset"}>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", margin: "8px 0" }}>{county.label}</div>
                {county.facilities.map((facility) => (
                  <div key={facility.id} className="card">
                    <button
                      onClick={() => toggleFacility(facility.id)}
                      style={{ background: "none", border: "none", color: "inherit", textAlign: "left", width: "100%", padding: 0, cursor: "pointer" }}
                    >
                      <strong>{facility.name}</strong>
                      <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                        {[facility.city, facility.state_code].filter(Boolean).join(", ") || "Location not set"}
                        {" · "}
                        {facility.opening_count} opening{facility.opening_count === 1 ? "" : "s"}
                      </div>
                    </button>
                    {openFacilityId === facility.id && (
                      <div style={{ marginTop: 12 }}>
                        {openingsLoading && <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading openings…</p>}
                        {!openingsLoading && openings.length === 0 && (
                          <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No openings at this facility.</p>
                        )}
                        {openings.map((opening) => (
                          <button
                            key={opening.id}
                            className="btn btn-secondary"
                            style={{ marginTop: 8 }}
                            onClick={() => navigate(`/opening/${opening.id}`)}
                          >
                            {opening.opening_code}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
