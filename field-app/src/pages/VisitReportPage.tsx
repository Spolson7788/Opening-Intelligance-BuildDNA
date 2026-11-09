import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SyncBadge } from "../components/SyncBadge";
import { emailFailureText, reportRecipientList } from "../components/EmailInspectionReport";
import { emailInspectionVisit, inspectionVisitRecipients } from "../lib/api";
import { readVisitById, visitSummaryText } from "../lib/inspectionVisit";
import type { InspectionVisit } from "../lib/inspectionVisit";

export function VisitReportPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [visit, setVisit] = useState<InspectionVisit | null>(null);
  const [to, setTo] = useState("");
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeRole, setNoticeRole] = useState<"status" | "alert">("status");

  useEffect(() => {
    if (!id) return;
    void readVisitById(id).then(setVisit);
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
    if (!id || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      setNotice("Emailing this report needs a connection. The visit stays on this device.");
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
      await emailInspectionVisit(id, recipients);
      setNotice("Combined report emailed.");
      setNoticeRole("status");
    } catch (error) {
      setNotice(emailFailureText(error));
      setNoticeRole("alert");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app-shell c04">
      <div className="top-bar">
        <button type="button" className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate("/scan")}>← Scan</button>
        <SyncBadge />
      </div>
      <div className="screen">
        <h1>Inspection visit</h1>
        {visit ? <div className="c04-band-green" role="status"><p>{visitSummaryText(visit.inspections)}</p></div> : <p>This visit is not on this device.</p>}
        <form className="c04-band" onSubmit={onSubmit}>
          <h2>Finish visit / Send combined report</h2>
          <label htmlFor="visit-report-email">Email this combined report</label>
          <textarea id="visit-report-email" value={to} onChange={(event) => setTo(event.target.value)} placeholder="facility contact, your email, anyone else" disabled={!ready || sending} />
          <p className="c04-note">Starts with the facility contact, when one is on file, and the email of the person who signed. Add or remove addresses before sending.</p>
          <button className="btn c04-btn-blue" type="submit" disabled={!ready || sending}>{sending ? "Sending…" : "Send combined report"}</button>
          {notice && <p role={noticeRole}>{notice}</p>}
        </form>
      </div>
    </div>
  );
}
