import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sidebar } from "../components/Sidebar";
import { fetchInspectionVisits, type InspectionVisitRow } from "../lib/api";

export function InspectionVisitsPage() {
  const [visits, setVisits] = useState<InspectionVisitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchInspectionVisits().then((result) => setVisits(result.visits)).catch(() => setError("Inspection visits are not available for this company."));
  }, []);
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <div className="ov-header"><div><h1>Inspection visits</h1><p>One combined fire-door report for each visit.</p></div></div>
        {error && <p role="alert">{error}</p>}
        <section className="ov-card">
          <table>
            <thead><tr><th>Date</th><th>Facility</th><th>Inspector</th><th>Inspected</th><th>Passed</th><th>Failed</th><th>Report</th></tr></thead>
            <tbody>
              {(visits ?? []).map((visit) => (
                <tr key={visit.id}>
                  <td><Link to={`/inspection-visits/${visit.id}`}>{String(visit.visit_date).slice(0, 10)}</Link></td>
                  <td>{visit.facility_name}</td>
                  <td>{visit.inspector_name}</td>
                  <td>{visit.inspected}</td>
                  <td>{visit.passed}</td>
                  <td>{visit.failed}</td>
                  <td>{visit.report_sent ? "Sent" : "Not sent"}</td>
                </tr>
              ))}
              {visits && visits.length === 0 && <tr><td colSpan={7}>No inspection visits yet.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
