import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, type ScheduleFollowUp, listScheduleFollowUps, resolveScheduleFollowUp } from "../lib/api";

// M2C: openings imported without hardware that still need a follow-up.
export const FOLLOW_UP_REASON_LABEL: Record<string, string> = {
  hw_missing: "Blank hardware column", hw_varies: "Hardware <varies>", hw_group_x: "Group X",
  hw_group_undefined: "Group not in hardware schedule", hw_variant_none: "No variant applies", hw_none_chosen: "No hardware chosen",
};

export function ScheduleFollowUps({ propertyId }: { propertyId: string }) {
  const [items, setItems] = useState<ScheduleFollowUp[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => listScheduleFollowUps(propertyId, "open").then(setItems).catch(() => setMessage("Could not load follow-ups."));
  useEffect(() => { setItems([]); setMessage(null); load(); }, [propertyId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function resolve(id: string) {
    const note = (notes[id] ?? "").trim();
    if (!note) { setMessage("Add a resolution note first."); return; }
    setBusy(id); setMessage(null);
    try { await resolveScheduleFollowUp(id, note); setNotes({ ...notes, [id]: "" }); await load(); }
    catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      setMessage(code === "insufficient_role_for_action" ? "Your role can view follow-ups but not resolve them."
        : code === "already_resolved" ? "That follow-up was already resolved." : "Could not resolve the follow-up.");
      await load();
    } finally { setBusy(null); }
  }
  return (
    <section>
      <h2>Schedule follow-ups</h2>
      {items.length === 0 ? <p>No open follow-ups.</p> : (
        <table>
          <thead><tr><th>Door mark</th><th>Building</th><th>Reason</th><th>Import</th><th>Date</th><th>Resolve</th></tr></thead>
          <tbody>
            {items.map((f) => (
              <tr key={f.id}>
                <td>{f.door_mark ?? f.opening_code}</td>
                <td>{f.building_name}</td>
                <td>{FOLLOW_UP_REASON_LABEL[f.reason] ?? f.reason}{f.detail ? ` (${f.detail})` : ""}</td>
                <td><Link to={`/schedule-imports/${f.import_id}`}>{f.import_id.slice(0, 8)}</Link></td>
                <td>{new Date(f.created_at).toLocaleDateString()}</td>
                <td>
                  <input placeholder="Resolution note" maxLength={2000} value={notes[f.id] ?? ""} onChange={(e) => setNotes({ ...notes, [f.id]: e.target.value })} />{" "}
                  <button disabled={busy === f.id || !(notes[f.id] ?? "").trim()} onClick={() => resolve(f.id)}>{busy === f.id ? "Resolving..." : "Resolve"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
