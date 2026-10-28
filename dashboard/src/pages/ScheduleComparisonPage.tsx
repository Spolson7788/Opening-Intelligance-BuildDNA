import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, type ComparisonSnapshot, type ComparisonSnapshotListItem, downloadComparisonCsv, fetchComparisonSnapshot, listComparisonSnapshots, runComparison } from "../lib/api";
import { SchedulePage } from "../components/SchedulePage";
import { CATEGORY_LABEL, CATEGORY_ORDER, type ComparisonFilter, MATCH_LABEL, STATUS_LABEL, comparisonErrorMessage, filterOpenings, floorsOf, hardwareSetLabel } from "../lib/comparisonUi";

// M4: schedule vs field comparison. "Run comparison" saves a read-only snapshot;
// past snapshots can be opened; CSV export always comes from the open snapshot.
export function ScheduleComparisonPage() {
  const { id = "", snapshotId } = useParams();
  const navigate = useNavigate();
  const [list, setList] = useState<ComparisonSnapshotListItem[]>([]);
  const [building, setBuilding] = useState("");
  const [snap, setSnap] = useState<ComparisonSnapshot | null>(null);
  const [filter, setFilter] = useState<ComparisonFilter>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fail = (err: unknown) => setMessage(comparisonErrorMessage(err instanceof ApiError ? err.message : ""));
  const loadList = () => listComparisonSnapshots(id).then((r) => { setList(r.snapshots); setBuilding(r.import.building_name); return r.snapshots; }).catch((e) => { fail(e); return []; });
  useEffect(() => { loadList(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSnap(null); if (snapshotId) fetchComparisonSnapshot(snapshotId).then(setSnap).catch(fail); }, [snapshotId]);
  async function run() {
    setBusy(true); setMessage(null);
    try { const s = await runComparison(id); await loadList(); navigate(`/schedule-imports/${id}/comparison/${s.id}`); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }
  const shown = useMemo(() => (snap ? filterOpenings(snap.results, filter) : []), [snap, filter]);
  const floors = useMemo(() => (snap ? floorsOf(snap.results) : []), [snap]);
  const set = (p: Partial<ComparisonFilter>) => setFilter({ ...filter, ...p });
  return (
    <SchedulePage title="Schedule vs field comparison" subtitle={building} back={{ to: "/schedule-comparisons", label: "All comparison reports" }}>
      {message && <p className="error-text" role="alert">{message}</p>}
      <section className="panel">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={run}>{busy ? "Running..." : "Run comparison"}</button>
        <p className="muted">Each run saves a read-only snapshot of the current field data compared with this confirmed import.</p>
        <h2>Saved snapshots</h2>
        {list.length === 0 ? <p className="empty-state">No comparison has been run yet.</p> : (
          <ul className="comparison-snapshots">
            {list.map((s) => <li key={s.id}><Link to={`/schedule-imports/${id}/comparison/${s.id}`}>{new Date(s.created_at).toLocaleString()}</Link>{" "}
              by {s.created_by_name ?? "unknown"} ({s.created_by_role}): {s.line_count} line(s){s.id === snapshotId ? " (open)" : ""}</li>)}
          </ul>)}
      </section>
      {snap && (
        <section className="panel" aria-label="Comparison snapshot">
          <h2>Snapshot {new Date(snap.created_at).toLocaleString()}</h2>
          <p>{snap.summary.schedule_rows} schedule row(s), {snap.summary.surveyed} surveyed, {snap.summary.openings_matched} matching, {snap.summary.openings_with_differences} with differences,
            {" "}{snap.summary.matched_by_code} matched by code{snap.summary.ambiguous_code_matches ? `, ${snap.summary.ambiguous_code_matches} ambiguous code match(es) not guessed` : ""}.</p>
          {snap.summary.hardware_sets_compared !== undefined && <p>Hardware sets: {snap.summary.hardware_sets_compared} compared, {snap.summary.hardware_sets_matched} match, {snap.summary.hardware_sets_differ} differ
            {" "}({snap.summary.hardware_items_missing} item(s) missing, {snap.summary.hardware_items_extra} extra, {snap.summary.hardware_items_changed} changed).</p>}
          <ul className="comparison-summary">{CATEGORY_ORDER.map((c) => <li key={c}><button type="button" className="btn btn-secondary" onClick={() => set({ category: filter.category === c ? "" : c })}>
            {CATEGORY_LABEL[c]}: {snap.summary[c] ?? 0}</button></li>)}</ul>
          <div className="filters">
            <label>Category <select value={filter.category ?? ""} onChange={(e) => set({ category: e.target.value as ComparisonFilter["category"] })}>
              <option value="">All</option>{CATEGORY_ORDER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
            <label>Surveyed <select value={filter.surveyed ?? ""} onChange={(e) => set({ surveyed: e.target.value as ComparisonFilter["surveyed"] })}>
              <option value="">All</option><option value="yes">Surveyed</option><option value="no">Not surveyed</option></select></label>
            <label>Field <select value={filter.field ?? ""} onChange={(e) => set({ field: e.target.value })}>
              <option value="">All</option><option value="size">Size</option><option value="fire">Fire rating</option><option value="material">Material</option>
              <option value="configuration">Configuration</option><option value="hardware">Hardware</option></select></label>
            {floors.length > 0 && <label>Floor <select value={filter.floor ?? ""} onChange={(e) => set({ floor: e.target.value })}>
              <option value="">All</option>{floors.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>}
            <label>Mark <input value={filter.search ?? ""} onChange={(e) => set({ search: e.target.value })} placeholder="Search mark or code" /></label>
            <label><input type="checkbox" checked={!!filter.onlyDifferences} onChange={(e) => set({ onlyDifferences: e.target.checked })} /> Only mismatches</label>
            <button type="button" className="btn btn-secondary" onClick={() => downloadComparisonCsv(snap.id).catch(fail)}>Export CSV</button>
          </div>
          <p className="muted">Showing {shown.length} of {snap.results.length} opening(s). CSV exports the whole snapshot.</p>
          <table className="table">
            <thead><tr><th>Mark</th><th>Opening</th><th>Match</th><th>Status</th><th>Hardware set</th><th>Surveyed</th><th>Lines</th></tr></thead>
            <tbody>{shown.map((o, i) => { const k = `${o.mark}-${o.opening_id}-${i}`; return [
              <tr key={k}><td>{o.mark ?? "-"}</td><td>{o.opening_id ? <Link to={`/opening/${o.opening_id}`}>{o.opening_code}</Link> : "-"}</td>
                <td>{MATCH_LABEL(o.match)}</td><td>{STATUS_LABEL[o.status]}{o.match_candidates ? ` (ambiguous: ${o.match_candidates.join(", ")})` : ""}</td><td>{hardwareSetLabel(o)}</td><td>{o.surveyed ? `yes${o.surveyed_by_role ? ` (${o.surveyed_by_role})` : ""}` : "no"}</td>
                <td><button type="button" className="btn btn-secondary" onClick={() => setOpen({ ...open, [k]: !open[k] })}>{o.lines.length} {open[k] ? "Hide" : "Show"}</button></td></tr>,
              open[k] ? <tr key={k + "-d"}><td colSpan={7}><ul>{o.lines.map((l, j) => <li key={j} style={l.level === "item" ? { marginLeft: 20 } : undefined}><strong>{l.level === "item" ? l.change ?? "item" : CATEGORY_LABEL[l.category]}</strong>{l.field ? ` ${l.entity} ${l.field}` : ""}
                {l.schedule_value !== null || l.field_value !== null ? `: schedule ${l.schedule_value ?? "-"}, field ${l.field_value ?? "-"}` : ""}{l.note ? ` (${l.note})` : ""}</li>)}</ul></td></tr> : null,
            ]; })}</tbody>
          </table>
        </section>)}
    </SchedulePage>
  );
}