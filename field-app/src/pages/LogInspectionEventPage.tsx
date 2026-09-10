import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { enqueueOutboxItem } from "../lib/db";
import { flushOutbox } from "../lib/sync";
import { recomputeHealthScore } from "../lib/api";
import { SyncBadge } from "../components/SyncBadge";
import { SignaturePad } from "../components/SignaturePad";
import type { SignaturePadHandle } from "../components/SignaturePad";

const INSPECTION_TYPES = [
  { value: "general", label: "General" },
  { value: "fire_door_nfpa80", label: "Fire Door (NFPA 80)" },
  { value: "ada_compliance", label: "ADA Compliance" },
  { value: "access_control", label: "Access Control" },
];

export function LogInspectionEventPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [inspectionType, setInspectionType] = useState("general");
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [passed, setPassed] = useState<"pass" | "fail" | null>(null);
  const [notes, setNotes] = useState("");
  const [signedByName, setSignedByName] = useState("");
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const signaturePadRef = useRef<SignaturePadHandle>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (passed === null) return;
    setSignatureError(null);

    const signatureDataUrl = signaturePadRef.current?.getDataUrl();
    if (!signatureDataUrl) {
      setSignatureError("A signature is required to save this inspection.");
      return;
    }
    if (!signedByName.trim()) {
      setSignatureError("Enter your name to sign off on this inspection.");
      return;
    }

    setSubmitting(true);

    await enqueueOutboxItem({
      id: crypto.randomUUID(),
      kind: "inspection_event",
      payload: {
        opening_id: id,
        event_date: eventDate,
        inspection_type: inspectionType,
        passed: passed === "pass",
        notes: notes || undefined,
        signature_data: signatureDataUrl,
        signed_by_name: signedByName.trim(),
      },
    });

    setSaved(true);
    setSubmitting(false);

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
        <h2 style={{ marginBottom: 4 }}>Log Inspection</h2>
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
              <label htmlFor="inspection-type">Inspection type</label>
              <select id="inspection-type" value={inspectionType} onChange={(e) => setInspectionType(e.target.value)}>
                {INSPECTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Result</label>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn"
                  style={{
                    background: passed === "pass" ? "var(--success)" : "var(--surface-raised)",
                    borderColor: passed === "pass" ? "var(--success)" : "var(--border)",
                    color: passed === "pass" ? "#0b1a0d" : "var(--text)",
                  }}
                  onClick={() => setPassed("pass")}
                >
                  Passed
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{
                    background: passed === "fail" ? "var(--danger)" : "var(--surface-raised)",
                    borderColor: passed === "fail" ? "var(--danger)" : "var(--border)",
                    color: passed === "fail" ? "#1a0b0c" : "var(--text)",
                  }}
                  onClick={() => setPassed("fail")}
                >
                  Failed
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="notes">Notes</label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything a facilities manager should know"
              />
            </div>

            <div className="section-label" style={{ marginTop: 4 }}>Sign Off</div>
            <div className="field">
              <label htmlFor="signed-by-name">Your name</label>
              <input
                id="signed-by-name"
                value={signedByName}
                onChange={(e) => setSignedByName(e.target.value)}
                placeholder="Type your full name"
              />
            </div>
            <div className="field">
              <SignaturePad ref={signaturePadRef} />
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginTop: 8, minHeight: 36, fontSize: 13 }}
                onClick={() => signaturePadRef.current?.clear()}
              >
                Clear Signature
              </button>
            </div>
            {signatureError && <p className="error-text">{signatureError}</p>}

            <button type="submit" className="btn btn-primary" disabled={submitting || passed === null}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
