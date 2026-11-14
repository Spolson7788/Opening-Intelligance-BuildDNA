import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { listFieldProperties, listOpenings } from "../lib/api";
import { loadAuth } from "../lib/db";
import { selectedFacilityKey } from "../lib/facilitySync";
import { getOfflineSetting } from "../lib/db";
import { selectTaskSite } from "../lib/taskSite";
import type { FacilityOpening, FacilityProperty } from "../lib/facilityOpenings";
import { sortFacilityOpenings } from "../lib/facilityOpenings";

export function SiteDoorsPage() {
  const [name, setName] = useState("This site");
  const [doors, setDoors] = useState<FacilityOpening[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const auth = await loadAuth();
      if (!auth) { if (live) setError("Sign in again before opening a site."); return; }
      const stored = await getOfflineSetting(selectedFacilityKey(auth));
      const propertyId = typeof stored?.value === "string" ? stored.value : "";
      if (!propertyId) { if (live) setError("No stop is open. Check with your manager."); return; }
      try { await selectTaskSite(propertyId); } catch { /* the list still opens; the visit is joined on the next save */ }
      const properties = await listFieldProperties() as FacilityProperty[];
      const property = (Array.isArray(properties) ? properties : []).find((item) => item.id === propertyId);
      if (live && property?.name) setName(property.name);
      const buildings = property?.buildings ?? [];
      const rows: FacilityOpening[] = [];
      for (const building of buildings) {
        const found = await listOpenings({ building_id: building.id }) as FacilityOpening[];
        if (Array.isArray(found)) rows.push(...found);
      }
      if (live) setDoors(sortFacilityOpenings(rows));
    })().catch((err) => { if (live) setError(err instanceof Error ? err.message : "This site's doors could not be loaded."); });
    return () => { live = false; };
  }, []);

  return (
    <TaskChrome title={name} hint="Tap a door to inspect it. Finish the visit when these doors are done." backTo="/tasks/day">
      {error && <p className="c04-alert" role="alert">{error}</p>}
      {doors === null && !error && <p role="status">Loading this site's doors.</p>}
      {doors && doors.length === 0 && <p>No doors are on file at this site.</p>}
      {doors && doors.length > 0 && (
        <ul className="c04-openings">
          {doors.map((door) => (
            <li key={door.id}>
              <Link className="c04-opening" to={`/tasks/inspect/${door.id}`}>
                <span><strong>{door.opening_code}</strong><span>{door.location_description || "Inspect"}</span></span>
                <span aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link className="btn c04-btn-blue" to="/tasks/finish">Finish the visit</Link>
    </TaskChrome>
  );
}
