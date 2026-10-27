import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchFacilitySchedulesForOpening, type FieldFacilitySchedule } from "../lib/api";

// Read-only list of the facility's door and hardware schedules. Uploading is
// done in the Dashboard by admins / facilities managers; download is not built.
export function FacilitySchedulesPage() {
  const { id } = useParams();
  const [schedules, setSchedules] = useState<FieldFacilitySchedule[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!id) return;
    fetchFacilitySchedulesForOpening(id).then(setSchedules).catch(() => setFailed(true));
  }, [id]);
  return (
    <div className="page">
      <p><Link to={`/opening/${id}`}>Back to opening</Link></p>
      <h1>Facility schedules</h1>
      {failed && <p role="alert">Schedules could not be loaded.</p>}
      {!failed && schedules === null && <p>Loading schedules.</p>}
      {schedules && schedules.length === 0 && <p>No schedules have been uploaded for this facility.</p>}
      {schedules?.map((s) => (
        <section key={s.id} className="card" aria-label={s.title}>
          <h2>{s.title}</h2>
          <p>{s.kind === "door" ? "Door schedule" : "Door hardware schedule"}</p>
          <ul>
            {s.versions.map((v) => (
              <li key={v.id}>
                v{v.version}{v.version === s.head_version ? " (current)" : ""} · {v.original_filename} · {new Date(v.uploaded_at).toLocaleDateString()}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}