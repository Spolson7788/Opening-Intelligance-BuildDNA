import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchOpening, listFieldProperties, listOpenings } from "../lib/api";
import { getOfflineSetting, putOfflineSetting } from "../lib/db";
import { useAuth } from "../lib/AuthContext";
import { SyncBadge } from "../components/SyncBadge";
import { COMPARISON_REPORT_ROLES, comparisonReportHref, type FacilityOpening, type FacilityProperty, facilityOpeningsCacheKey, filterFacilityOpenings, prefetchOpenings, sortFacilityOpenings } from "../lib/facilityOpenings";

// M4 v2: a technician picks a facility and building they can reach and gets every opening
// in it, including openings created by a confirmed schedule import. Opening the list also
// saves each opening on the device so the building can be surveyed offline.
export function FacilityOpeningsPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [properties, setProperties] = useState<FacilityProperty[] | null>(null);
  const [buildingId, setBuildingId] = useState<string>(() => sessionStorage.getItem("oi-field-building") ?? "");
  const [openings, setOpenings] = useState<FacilityOpening[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [q, setQ] = useState("");
  const [onlyToSurvey, setOnlyToSurvey] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listFieldProperties().then(setProperties).catch(() => setError("Couldn't load your facilities. Check your connection.")); }, []);
  useEffect(() => {
    if (!buildingId || !auth) return;
    sessionStorage.setItem("oi-field-building", buildingId);
    const key = facilityOpeningsCacheKey(auth, buildingId);
    let stop = false;
    setOpenings(null); setError(null); setProgress(null);
    listOpenings({ building_id: buildingId }).then(async (rows: FacilityOpening[]) => {
      if (stop) return;
      setOpenings(rows); setFromCache(false);
      await putOfflineSetting({ key, value: rows, updatedAt: new Date().toISOString() });
      const r = await prefetchOpenings(rows.map((o) => o.id), (id) => fetchOpening(id), 3, (d, t) => { if (!stop) setProgress(`Saving openings for offline use: ${d} of ${t}`); });
      if (!stop) setProgress(`${r.saved} opening(s) saved on this device${r.failed ? `, ${r.failed} could not be saved` : ""}.`);
    }).catch(async () => {
      const cached = await getOfflineSetting(key);
      if (stop) return;
      if (cached && Array.isArray(cached.value)) { setOpenings(cached.value as FacilityOpening[]); setFromCache(true); }
      else setError("Couldn't load openings for this building. Check your connection.");
    });
    return () => { stop = true; };
  }, [buildingId, auth?.userId, auth?.organizationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (openings ? sortFacilityOpenings(filterFacilityOpenings(openings, q, onlyToSurvey)) : []), [openings, q, onlyToSurvey]);
  const buildings = (properties ?? []).flatMap((p) => (p.buildings ?? []).map((b) => ({ id: b.id, label: `${p.name} - ${b.name}` })));
  return (
    <div className="app-shell">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate("/scan")}>Back</button>
        <h1>Facility openings</h1>
        <SyncBadge />
      </div>
      <div className="screen">
        {error && <p role="alert">{error}</p>}
        {auth && COMPARISON_REPORT_ROLES.includes(auth.role) && <p><a href={comparisonReportHref()}>Schedule comparison report</a></p>}
        <label>Building{" "}
          <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
            <option value="">{properties ? "Choose a building" : "Loading facilities..."}</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </label>
        {fromCache && <p role="status">Offline: showing the openings saved on this device.</p>}
        {progress && <p role="status">{progress}</p>}
        {openings && <>
          <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mark or code, e.g. 101-A" /></label>
          <label><input type="checkbox" checked={onlyToSurvey} onChange={(e) => setOnlyToSurvey(e.target.checked)} /> Only openings not yet complete</label>
          <p>{shown.length} of {openings.length} opening(s)</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {shown.map((o) => <li key={o.id}>
              <button type="button" className="btn btn-secondary" style={{ textAlign: "left", marginBottom: 8 }} onClick={() => navigate(`/opening/${o.id}`)}>
                <strong>{o.schedule_door_mark ?? o.opening_code}</strong>{o.schedule_door_mark ? ` (${o.opening_code})` : ""}
                {o.floor_label ? ` - floor ${o.floor_label}` : ""}{o.completion_state === "complete" ? " - complete" : " - to survey"}
              </button>
            </li>)}
          </ul>
        </>}
      </div>
    </div>
  );
}