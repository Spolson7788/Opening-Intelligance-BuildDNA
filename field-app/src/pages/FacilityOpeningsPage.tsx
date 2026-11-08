import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listFieldProperties, listOpenings } from "../lib/api";
import { isAppSessionFailure } from "../lib/siteAccess";
import { FieldBrand } from "../components/FieldBrand";
import { FacilitySelector, useFacilitySync } from "../components/FacilitySelector";
import { getOfflineSetting, putOfflineSetting } from "../lib/db";
import { useAuth } from "../lib/AuthContext";
import { SyncBadge } from "../components/SyncBadge";
import { COMPARISON_REPORT_ROLES, comparisonReportHref, type FacilityOpening, type FacilityProperty, facilityOpeningsCacheKey, filterFacilityOpenings, sortFacilityOpenings } from "../lib/facilityOpenings";

// M4 v2: a technician picks a facility and building they can reach and gets every opening
// in it, including openings created by a confirmed schedule import. Browsing only: the
// offline download happens when the facility is selected (FacilitySelector).
export function FacilityOpeningsPage() {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const sync = useFacilitySync();
  const [properties, setProperties] = useState<FacilityProperty[] | null>(null);
  const [buildingId, setBuildingId] = useState<string>(() => sessionStorage.getItem("oi-field-building") ?? "");
  const [openings, setOpenings] = useState<FacilityOpening[] | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [q, setQ] = useState("");
  const [onlyToSurvey, setOnlyToSurvey] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    document.body.classList.add("c04-on");
    return () => document.body.classList.remove("c04-on");
  }, []);
  useEffect(() => { if (!buildingId && sync?.selectedId) { const p = sync.properties?.find((x) => x.id === sync.selectedId); if (p?.buildings?.length === 1) setBuildingId(p.buildings[0].id); } }, [sync?.selectedId, sync?.properties]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listFieldProperties().then(setProperties).catch((error) => { if (!isAppSessionFailure(error)) setError("Couldn't load your facilities. Check your connection."); }); }, []);
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
    }).catch(async (error) => {
      const cached = await getOfflineSetting(key);
      if (stop) return;
      if (cached && Array.isArray(cached.value)) { setOpenings(cached.value as FacilityOpening[]); setFromCache(true); }
      else if (!isAppSessionFailure(error)) setError("Couldn't load openings for this building. Check your connection.");
    });
    return () => { stop = true; };
  }, [buildingId, auth?.userId, auth?.organizationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (openings ? sortFacilityOpenings(filterFacilityOpenings(openings, q, onlyToSurvey)) : []), [openings, q, onlyToSurvey]);
  // The selected facility (downloaded for offline use on selection) is listed first.
  const ordered = [...(sync?.properties ?? properties ?? [])].sort((a, b) => Number(b.id === sync?.selectedId) - Number(a.id === sync?.selectedId));
  const buildings = ordered.flatMap((p) => (p.buildings ?? []).map((b) => ({ id: b.id, label: `${p.name} - ${b.name}` })));
  return (
    <div className="app-shell c04">
      <FieldBrand />
      <div className="c04-toolbar">
        <button className="btn c04-back" type="button" onClick={() => navigate("/scan")}>Back</button>
        <SyncBadge />
      </div>
      <div className="screen">
        <p className="c04-kicker">Field app</p>
        <h1>Facility openings</h1>
        {error && <p className="c04-alert" role="alert">{error}</p>}
        {auth && COMPARISON_REPORT_ROLES.includes(auth.role) && <p><a className="c04-link" href={comparisonReportHref()}>Schedule comparison report</a></p>}
        <div className="field">
          <label htmlFor="facility-building">Building</label>
          <select id="facility-building" value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
            <option value="">{properties ? "Choose a building" : "Loading facilities..."}</option>
            {buildings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </div>
        {fromCache && <p className="c04-note" role="status">Offline: showing the openings saved on this device.</p>}
        {progress && <p role="status">{progress}</p>}
        <FacilitySelector />
        {openings && <>
          <h2>Find an opening</h2>
          <div className="field">
            <label htmlFor="facility-opening-search">Search</label>
            <input id="facility-opening-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mark or code, e.g. 101-A" />
          </div>
          <label className="c04-check"><input type="checkbox" checked={onlyToSurvey} onChange={(e) => setOnlyToSurvey(e.target.checked)} /> Only openings not yet complete</label>
          <p>{shown.length} of {openings.length} opening(s)</p>
          <ul className="c04-openings">
            {shown.map((o) => <li key={o.id}>
              <button type="button" className="c04-opening" onClick={() => navigate(`/opening/${o.id}`)}>
                <span>
                  <strong>{o.schedule_door_mark ?? o.opening_code}</strong>
                  <span>{o.schedule_door_mark ? o.opening_code : "Opening details"}{o.floor_label ? ` · floor ${o.floor_label}` : ""} · {o.completion_state === "complete" ? "complete" : "to survey"}</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>)}
          </ul>
        </>}
      </div>
    </div>
  );
}