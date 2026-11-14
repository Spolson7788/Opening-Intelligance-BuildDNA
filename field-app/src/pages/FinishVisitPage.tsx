import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { TaskChrome } from "../components/TaskChrome";
import { ApiError, emailInspectionVisit, fetchInspectionVisit, inspectionVisitRecipients, storeInspectionVisitPdf, type VisitDoorRow } from "../lib/api";
import { reportRecipientList } from "../components/EmailInspectionReport";
import { readOpenVisit } from "../lib/inspectionVisit";
import { formatVisitDoorTime } from "../lib/inspectionVisit";

export function FinishVisitPage() {
  const [visitId, setVisitId] = useState<string | null>(null);
  const [doors, setDoors] = useState<VisitDoorRow[]>([]);
  const [to, setTo] = useState("");
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readOpenVisit().then(async (visit) => {
      if (!live) return;
      if (!visit) { setVisitId(null); return; }
      setVisitId(visit.id);
      try {
        const row = await fetchInspectionVisit(visit.id);
        if (!live) return;
        if (row.status === "finished" || row.report_sent) {
          setBlocked("This visit is already finished. No report was sent.");
          return;
        }
        setDoors(Array.isArray(row.doors) ? row.doors : []);
        const people = await inspectionVisitRecipients(visit.id);
        if (!live) return;
        setTo(people.to.join(", "));
        setReady(true);
      } catch (error) {
        if (!live) return;
        const missing = error instanceof ApiError && error.status === 404;
        if (missing || (error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404)) {
          setBlocked("This visit is not open on the server. No report was sent.");
        }
      }
    });
    return () => { live = false; };
  }, []);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!visitId || blocked || sending) return;
    const recipients = reportRecipientList(to);
    if (!recipients.length) { setNotice("Enter at least one email address."); return; }
    setSending(true);
    try {
      const ids = doors.map((door) => door.inspection_id).filter((id): id is string => !!id);
      await storeInspectionVisitPdf(visitId, ids);
      await emailInspectionVisit(visitId, recipients, ids);
      setNotice("Report sent.");
    } catch {
      setNotice("The report was not sent. The visit stays here.");
    } finally {
      setSending(false);
    }
  }

  return (
    <TaskChrome title="Finish the visit" hint="Today's doors. Nothing is emailed until you send." backTo="/tasks/day">
      {!visitId && !blocked && <p>No visit is open. Start from today's doors.</p>}
      {blocked && <p className="c04-alert" role="alert">{blocked}</p>}
      {doors.length > 0 && (
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
      {visitId && !blocked && (
        <form onSubmit={send}>
          <div className="field">
            <label htmlFor="visit-report-to">Email this report to</label>
            <textarea id="visit-report-to" value={to} onChange={(event) => setTo(event.target.value)} />
          </div>
          <button className="btn c04-btn-blue" type="submit" disabled={!ready || sending}>{sending ? "Sending…" : "Send one report"}</button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </TaskChrome>
  );
}
