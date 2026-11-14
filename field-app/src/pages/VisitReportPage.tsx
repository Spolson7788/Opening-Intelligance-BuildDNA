import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SyncBadge } from "../components/SyncBadge";
import { emailFailureText, reportRecipientList } from "../components/EmailInspectionReport";
import { ApiError, emailInspectionVisit, fetchInspectionVisit, inspectionVisitRecipients, storeInspectionVisitPdf } from "../lib/api";
import { flushOutbox, noteSyncDiagnostic } from "../lib/sync";
import { getSyncOperationsForPrincipal, loadAuth } from "../lib/db";
import { finishVisit, formatVisitDoorTime, openingCountText, pendingInspectionIds, readVisitById, visitSummaryText, visitUploadMessage } from "../lib/inspectionVisit";
import type { InspectionVisit } from "../lib/inspectionVisit";
import type { VisitDoorRow } from "../lib/api";

export function VisitReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [visit, setVisit] = useState<InspectionVisit | null>(null);
  const [to, setTo] = useState("");
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeRole, setNoticeRole] = useState<"status" | "alert">("status");
  const [serverCount, setServerCount] = useState<number | null>(null);
  const [doors, setDoors] = useState<VisitDoorRow[] | null>(null);
  const [reportBlocked, setReportBlocked] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    void readVisitById(id).then(setVisit);
    void fetchInspectionVisit(id).then((row) => {
      if (row.status === "finished" || row.report_sent) {
        setReportBlocked("This visit is already finished. No report was sent.");
        setReady(false);
      }
      setServerCount(row.inspection_ids?.length ?? row.inspected);
      setDoors(Array.isArray(row.doors) ? row.doors : []);
    }).catch((error: unknown) => {
      setServerCount(null);
      setDoors(null);
      const missing = !!error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404;
      if (missing) {
        setReportBlocked("This visit is not open on the server. No report was sent.");
        setReady(false);
      }
    });
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setNotice("Emailing this report needs a connection. The visit stays on this device.");
      setNoticeRole("alert");
      return;
    }
    inspectionVisitRecipients(id).then((row) => {
      setTo(row.to.join(", "));
      setReady(true);
    }).catch(() => {
      setNotice("Could not load the report recipients. The visit stays on this device.");
      setNoticeRole("alert");
    });
  }, [id]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id || reportBlocked) {
      if (reportBlocked) { setNotice(reportBlocked); setNoticeRole("alert"); }
      return;
    }
    const localIds = visit?.inspections.map((inspection) => inspection.inspectionId) ?? [];
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setNotice(visitUploadMessage(Math.max(localIds.length, 1)));
      setNoticeRole("alert");
      return;
    }
    const recipients = reportRecipientList(to);
    if (!recipients.length) {
      setNotice("Enter at least one email address.");
      setNoticeRole("alert");
      return;
    }
    setSending(true);
    try {
      await flushOutbox();
      const auth = await loadAuth();
      const operations = auth ? await getSyncOperationsForPrincipal(auth.userId, auth.organizationId) : [];
      let serverIds: string[] | null = null;
      try {
        const row = await fetchInspectionVisit(id);
        if (row.status === "finished" || row.report_sent) {
          const blocked = "This visit is already finished. No report was sent.";
          setReportBlocked(blocked);
          setNotice(blocked);
          setNoticeRole("alert");
          return;
        }
        serverIds = row.inspection_ids ?? [];
        setServerCount(serverIds.length);
        if (Array.isArray(row.doors)) setDoors(row.doors);
      } catch (error) {
        serverIds = null;
        setServerCount(null);
        const missing = !!error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404;
        if (missing) {
          const blocked = "This visit is not open on the server. No report was sent.";
          setReportBlocked(blocked);
          setNotice(blocked);
          setNoticeRole("alert");
          return;
        }
      }
      const pending = pendingInspectionIds(localIds, operations, serverIds);
      if (pending.length) {
        setNotice(visitUploadMessage(pending.length));
        setNoticeRole("alert");
        return;
      }
      await storeInspectionVisitPdf(id, localIds);
      await emailInspectionVisit(id, recipients, localIds);
      await finishVisit(id);
      setNotice("Combined report emailed.");
      setNoticeRole("status");
    } catch (error) {
      noteSyncDiagnostic(error, true);
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      setNotice(timedOut
        ? "The report request timed out. The visit stays open. Try again."
        : error instanceof ApiError && error.message === "visit_inspections_pending"
        ? visitUploadMessage(Math.max(localIds.length, 1))
        : emailFailureText(error));
      setNoticeRole("alert");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app-shell c04">
      <div className="c04-toolbar">
        <button type="button" className="btn c04-back" onClick={() => navigate("/scan")}>Back</button>
        <SyncBadge />
      </div>
      <div className="screen">
        <p className="c04-kicker">Field app</p>
        <h1>Inspection visit</h1>
        {visit || (doors && doors.length > 0) ? <div className="c04-band-green" role="status"><p>{doors && doors.length > 0 ? `This visit: ${openingCountText(doors.length)} (${doors.filter((door) => door.passed).length} passed, ${doors.filter((door) => !door.passed).length} failed)` : visitSummaryText(visit!.inspections)}</p>{visit && <p>On this device: {visit.inspections.length}. On the server: {serverCount === null ? "not confirmed" : serverCount}.</p>}</div> : doors === null ? <p role="status">Loading the openings in this visit.</p> : <p>This visit is not on this device.</p>}
        <section aria-label="Openings in this visit">
          <h2>Openings in this visit</h2>
          {doors === null && <p role="status">Loading the openings in this visit.</p>}
          {doors && doors.length === 0 && <p>No openings in this visit are on the server yet.</p>}
          {doors && doors.length > 0 && <ul className="c04-openings">
            {[...doors].sort((a, b) => a.opening_code.localeCompare(b.opening_code, undefined, { numeric: true })).map((door) => (
              <li key={door.inspection_id || door.opening_id}>
                <button type="button" className="c04-opening" onClick={() => { if (door.inspection_id) navigate(`/opening/${door.opening_id}/inspection/${door.inspection_id}`); }}>
                  <span>
                    <strong>{door.opening_code}</strong>
                    <span>{(door.opening_type || "Opening").replace(/_/g, " ")}</span>
                    <span className={door.passed ? "c04-result-passed" : "c04-result-failed"}>{door.passed ? "Passed" : "Failed"}</span>
                    <span>{formatVisitDoorTime(door.inspected_at)}</span>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>}
        </section>
        {reportBlocked ? <p className="c04-alert" role="alert">{reportBlocked}</p> : <form className="c04-band" onSubmit={onSubmit}>
          <h2>Finish visit / Send combined report</h2>
          <label htmlFor="visit-report-email">Email this combined report</label>
          <textarea id="visit-report-email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="facility contact, your email, anyone else" disabled={!ready || sending} />
          <p className="c04-note">Starts with the facility contact, when one is on file, and the email of the person who signed. Add or remove addresses before sending.</p>
          <button className="btn c04-btn-blue" type="submit" disabled={!ready || sending}>{sending ? "Sending…" : "Send combined report"}</button>
          {notice && <p role={noticeRole}>{notice}</p>}
        </form>}
      </div>
    </div>
  );
}
