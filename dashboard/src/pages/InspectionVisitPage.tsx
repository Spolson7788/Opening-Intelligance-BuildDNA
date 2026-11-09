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
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <p><Link to="/">Portfolio Overview</Link></p>
        <h1>Inspection visit</h1>
        {error && <p role="alert">{error}</p>}
        {visit && <section className="ov-card">
          <h2>{visit.facility_name}</h2>
          <p>{visit.event_date} · {visit.inspector_name || "Inspector"}</p>
          <p>{visit.summary}</p>
          <button type="button" className="ov-btn ov-btn-primary" onClick={() => downloadAuthedFile(`/events/inspection-visits/${visit.id}/report.pdf`, "fire-door-inspection-visit.pdf").catch(() => setError("Could not download the combined report."))}>Download combined PDF</button>
          <h3>Doors</h3>
          {visit.doors.map((door) => <p key={door.opening_code}><strong>{door.opening_code}</strong> {door.passed ? "Passed" : "Failed"}{door.location ? ` · ${door.location}` : ""}</p>)}
        </section>}
      </div>
    </div>
  );
}
