import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, type ComparisonReportItem, listComparisonReports } from "../lib/api";
import { SchedulePage } from "../components/SchedulePage";
import { comparisonErrorMessage } from "../lib/comparisonUi";

// M4 v2: comparison report index. Admin, facilities manager, technician and inspector of the
// owner org or an assigned provider org see every confirmed import they can reach.
export function ScheduleComparisonsPage() {
  const [items, setItems] = useState<ComparisonReportItem[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { listComparisonReports().then((r) => setItems(r.imports)).catch((e) => setMessage(comparisonErrorMessage(e instanceof ApiError ? e.message : ""))); }, []);
  return (
    <SchedulePage title="Schedule comparison reports" subtitle="Confirmed schedule imports compared with the field" back={{ to: "/", label: "Back to portfolio" }}>
      {message && <p className="error-text" role="alert">{message}</p>}
      {items && items.length === 0 && <p className="empty-state">No confirmed schedule imports are available to you yet.</p>}
      {items && items.length > 0 && (
        <table className="table">
          <thead><tr><th>Facility</th><th>Building</th><th>Confirmed</th><th>Latest snapshot</th><th></th></tr></thead>
          <tbody>{items.map((i) => (
            <tr key={i.import_id}><td>{i.property_name}</td><td>{i.building_name}</td><td>{i.confirmed_at ? new Date(i.confirmed_at).toLocaleDateString() : "-"}</td>
              <td>{i.latest_snapshot_at ? `${new Date(i.latest_snapshot_at).toLocaleString()}: ${i.latest_summary?.openings_matched ?? 0} matching, ${i.latest_summary?.openings_with_differences ?? 0} with differences` : "Not run yet"}</td>
              <td><Link to={i.latest_snapshot_id ? `/schedule-imports/${i.import_id}/comparison/${i.latest_snapshot_id}` : `/schedule-imports/${i.import_id}/comparison`}>Open report</Link></td></tr>))}</tbody>
        </table>)}
    </SchedulePage>
  );
}