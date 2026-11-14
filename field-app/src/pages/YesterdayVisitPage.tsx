import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { fetchInspectionVisit, type VisitDoorRow } from "../lib/api";
import { formatVisitDoorTime } from "../lib/inspectionVisit";
import type { FinishedSiteRow } from "../lib/fieldRoutes";

export function YesterdayVisitPage() {
  const { id } = useParams();
  const location = useLocation();
  const passed = (location.state ?? null) as FinishedSiteRow | null;
  const [doors, setDoors] = useState<VisitDoorRow[] | null>(null);
  const [name, setName] = useState(passed?.property_name || "Yesterday");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;
    fetchInspectionVisit(id).then((row) => {
      if (!live) return;
      if (row.facility_name) setName(row.facility_name);
      setDoors(Array.isArray(row.doors) ? row.doors : []);
    }).catch(() => { if (live) setError("This visit summary is not available."); });
    return () => { live = false; };
  }, [id]);

  const when = formatVisitDoorTime(passed?.finished_at);
  return (
    <TaskChrome title={name} hint="This visit is finished. Nothing here can be changed." backTo="/tasks/day">
      {passed?.address && <p>{passed.address}</p>}
      {when && <p>Finished {when}</p>}
      {error && <p className="c04-alert" role="alert">{error}</p>}
      {doors && doors.length > 0 && (
        <ul className="c04-openings">
          {doors.map((door) => (
            <li key={door.inspection_id || door.opening_id}>
              <div className="c04-opening">
                <span>
                  <strong>{door.opening_code}</strong>
                  <span className={door.passed ? "c04-result-passed" : "c04-result-failed"}>{door.passed ? "Passed" : "Failed"}</span>
                  <span>{formatVisitDoorTime(door.inspected_at)}</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {doors && doors.length === 0 && !error && <p>No doors were recorded on this visit.</p>}
    </TaskChrome>
  );
}
