import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Sidebar } from "../components/Sidebar";
import { downloadAuthedFile, fetchInspectionVisit } from "../lib/api";

export function InspectionVisitPage() {
  const { id } = useParams();
  const [visit, setVisit] = useState<Awaited<ReturnType<typeof fetchInspectionVisit>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    fetchInspectionVisit(id).then(setVisit).catch(() => setError("This visit is not available for this company."));
  }, [id]);
  const failed = visit?.doors.filter((door) => !door.passed) ?? [];
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <p><Link to="/inspection-visits">Inspection visits</Link></p>
        <div className="ov-header"><div><h1>Inspection visit</h1>{visit && <p>{visit.facility_name} · {visit.event_date} · {visit.inspector_name || "Inspector"}</p>}</div></div>
        {error && <p role="alert">{error}</p>}
        {visit && <>
          <section className="ov-card">
            <p>{visit.summary}</p>
            <p>{visit.report_sent ? "Official report sent" : "Official report not sent"}</p>
            {visit.report_stored
              ? <button type="button" className="ov-btn ov-btn-primary" onClick={() => downloadAuthedFile(`/events/inspection-visits/${visit.id}/report.pdf`, "fire-door-inspection-visit.pdf").catch(() => setError("Could not download the official report."))}>Download official PDF</button>
              : <p>The official PDF is saved when the visit report is sent.</p>}
          </section>
          <section className="ov-card">
            <h2>Failed doors</h2>
            {failed.length === 0 && <p>No doors failed on this visit.</p>}
            {failed.map((door) => <article key={door.opening_id}>
              <p><Link to={`/opening/${door.opening_id}`}>{door.opening_code}</Link>{door.location ? ` · ${door.location}` : ""}</p>
              {door.deficiencies.map((item) => <p key={item.section}><strong>{item.section}</strong> {item.description} — {item.note}</p>)}
              {door.notes && <p>{door.notes}</p>}
            </article>)}
          </section>
          <section className="ov-card">
            <h2>Doors</h2>
            {visit.doors.map((door) => <p key={door.opening_id}><Link to={`/opening/${door.opening_id}`}>{door.opening_code}</Link> {door.passed ? "Passed" : "Failed"}</p>)}
          </section>
        </>}
      </div>
    </div>
  );
}
