import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TaskChrome } from "../components/TaskChrome";
import { DetailsDrawer } from "../components/DetailsDrawer";
import { useAuth } from "../lib/AuthContext";
import { flushOutbox, queueOpeningMutation } from "../lib/sync";
import { localCalendarDay } from "../lib/calendarDay";
import { readInspectDraft } from "../lib/inspectionDraft";

export function FixDoorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [work, setWork] = useState("");
  const [saving, setSaving] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inspector = auth?.role === "inspector" || auth?.role === "viewer";

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!id || !work.trim()) { setError("Say what you did, then save."); return; }
    setSaving(true);
    setError(null);
    try {
      await queueOpeningMutation("service_event", id, {
        opening_id: id,
        event_date: localCalendarDay(),
        work_performed: work.trim(),
      });
      void flushOutbox();
      navigate(`/tasks/inspect/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The note stayed on this page.");
      setSaving(false);
    }
  }

  return (
    <TaskChrome title="Fix this door" hint="The inspection stays put." backTo={id ? `/tasks/inspect/${id}` : "/tasks/day"}>
      {error && <p className="c04-alert" role="alert">{error}</p>}
      {inspector ? (
        <Link className="btn c04-btn-blue" to={id ? `/opening/${id}/request-service` : "/tasks/day"}>Request service</Link>
      ) : (
        <form onSubmit={save}>
          <section className="c04-band-green">
            <div className="field">
              <label htmlFor="work-done">What you did</label>
              <textarea id="work-done" value={work} onChange={(event) => setWork(event.target.value)} />
            </div>
          </section>
          <button className="btn c04-btn-blue" type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </form>
      )}
      {id && <button type="button" className="btn c04-choice" onClick={() => setDetails(true)}>Details</button>}
      {id && details && <DetailsDrawer openingId={id} onClose={() => setDetails(false)} />}
      <p className="c04-note">{id && Object.keys(readInspectDraft(id)).length > 0 ? "Your checklist is still on this phone." : "No checklist answers yet."}</p>
    </TaskChrome>
  );
}
