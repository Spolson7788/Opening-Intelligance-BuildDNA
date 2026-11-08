import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { emailInspectionReport, inspectionReportRecipients } from "../lib/api";

export function reportRecipientList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[\s,;]+/)) {
    const email = part.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

const OFFLINE = "Emailing this report needs a connection.";

export function EmailInspectionReport({ inspectionId, syncStatus = "ready", syncReason = null }: { inspectionId: string; syncStatus?: "syncing" | "ready" | "failed"; syncReason?: string | null }) {
  const [to, setTo] = useState("");
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeRole, setNoticeRole] = useState<"status" | "alert">("status");

  useEffect(() => {
    if (syncStatus !== "ready") return;
    let live = true;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setNotice(OFFLINE);
      setNoticeRole("alert");
      return;
    }
    inspectionReportRecipients(inspectionId).then((row) => {
      if (!live) return;
      setTo(row.to.join(", "));
      setReady(true);
    }).catch(() => {
      if (!live) return;
      setNotice(typeof navigator !== "undefined" && navigator.onLine === false ? OFFLINE : "Could not load the report recipients.");
      setNoticeRole("alert");
    });
    return () => { live = false; };
  }, [inspectionId, syncStatus]);

  if (syncStatus === "syncing") {
    return <p role="status">{syncReason && syncReason.startsWith("Sync failed") ? syncReason : "Syncing… email will be available once synced"}</p>;
  }
  if (syncStatus === "failed") {
    return <p role="alert">{syncReason || "The inspection could not sync."}</p>;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setNotice(OFFLINE);
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
      await emailInspectionReport(inspectionId, recipients);
      setNotice("Report emailed.");
      setNoticeRole("status");
    } catch {
      setNotice(typeof navigator !== "undefined" && navigator.onLine === false ? OFFLINE : "Could not email the report.");
      setNoticeRole("alert");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 12, textAlign: "left" }}>
      <label htmlFor={`report-email-${inspectionId}`}>Email this report</label>
      <textarea
        id={`report-email-${inspectionId}`}
        value={to}
        onChange={(event) => setTo(event.target.value)}
        placeholder="facility contact, your email, anyone else"
        disabled={!ready || sending}
      />
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Starts with the facility contact, when one is on file, and the email of the person who signed. Add or remove addresses before sending.
      </p>
      <button className="btn btn-secondary" type="submit" disabled={!ready || sending}>
        {sending ? "Sending…" : "Email this report"}
      </button>
      {notice && <p role={noticeRole}>{notice}</p>}
    </form>
  );
}
