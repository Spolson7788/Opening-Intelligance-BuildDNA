import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { flushOutbox, queueOpeningMutation } from "../lib/sync";
import { fetchOpening, recomputeHealthScore } from "../lib/api";
import { getCachedOpening } from "../lib/db";
import { componentLabel } from "../lib/serviceHistory";
import type { ComponentRow, OpeningServiceView } from "../lib/serviceHistory";
import { SyncBadge } from "../components/SyncBadge";

export function LogServiceEventPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [workPerformed, setWorkPerformed] = useState("");
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [searchParams] = useSearchParams();
  // "" = the whole opening; otherwise the id of one hardware component of this opening.
  const [target, setTarget] = useState(searchParams.get("component") ?? "");
  const [opening, setOpening] = useState<OpeningServiceView | null>(null);

  useEffect(() => {
    let active = true;
    fetchOpening(id!).then(({ opening }) => opening).catch(() => getCachedOpening(id!))
      .then((loaded) => { if (active && loaded) setOpening(loaded); }).catch(() => {});
    return () => { active = false; };
  }, [id]);
  const components: ComponentRow[] = opening?.hardware_components || [];
  // A preselected component that is not on this opening is not used.
  const validTarget = target && (!opening || components.some((c) => c.id === target)) ? target : "";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);

    await queueOpeningMutation("service_event", id!, {
        opening_id: id,
        event_date: eventDate,
        work_performed: workPerformed,
        ...(validTarget ? { hardware_component_id: validTarget } : {}),
    });

    setSaved(true);
    setSubmitting(false);

    // Try to sync right away if we have a connection; if not, it just sits in
    // the outbox and the top-bar badge shows it's queued.
    flushOutbox().then(() => {
      if (navigator.onLine) recomputeHealthScore(id!).catch(() => {});
    });

    setTimeout(() => navigate(`/opening/${id}`), 700);
  }

  return (
    <div className="app-shell">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate(-1)}>
          ← Back
        </button>
        <SyncBadge />
      </div>
      <div className="screen">
        <h2 style={{ marginBottom: 4 }}>Log Service</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 20 }}>
          Saved locally the moment you tap Save — this works with no signal.
        </p>

        {saved ? (
          <div className="card" style={{ textAlign: "center", color: "var(--success)" }}>
            Saved. Returning to the opening…
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="service-target">Applies to</label>
              <select id="service-target" value={validTarget} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Whole opening</option>
                {components.map((c) => (
                  <option key={c.id} value={c.id}>{componentLabel(c, opening!)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="event-date">Date</label>
              <input
                id="event-date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="work-performed">Work performed</label>
              <textarea
                id="work-performed"
                value={workPerformed}
                onChange={(e) => setWorkPerformed(e.target.value)}
                placeholder="e.g. Replaced closer arm, adjusted latch throw"
                required
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={submitting || !workPerformed.trim()}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
