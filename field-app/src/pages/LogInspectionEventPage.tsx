import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { flushOutbox, queueOpeningMutation } from "../lib/sync";
import { recomputeHealthScore } from "../lib/api";
import { SyncBadge } from "../components/SyncBadge";
import { SignaturePad } from "../components/SignaturePad";
import type { SignaturePadHandle } from "../components/SignaturePad";
import { EmailInspectionReport } from "../components/EmailInspectionReport";
import { NFPA80_ITEMS, checklistStarted, fireDoorOutcome, resolveInspectionType } from "../lib/nfpa80Items";
import { inspectionSaveFailureMessage, lowStorageWarning, queueInspectionFailurePhoto } from "../lib/inspectionPhoto";
import { holdFacilityDownload } from "../lib/facilitySync";
import { noteSyncDiagnostic } from "../lib/sync";
import { awaitInspectionSynced } from "../lib/sync";
import { scrollPageToTop } from "../lib/scrollPage";
import { ensureOpenVisit, recordVisitInspection, visitSummaryText } from "../lib/inspectionVisit";
import type { InspectionVisit } from "../lib/inspectionVisit";

type ItemAnswer = { result: "" | "pass" | "fail" | "na"; note: string; photo: File | null };

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
  const [qualification, setQualification] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [answers, setAnswers] = useState<Record<string, ItemAnswer>>({});
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const signaturePadRef = useRef<SignaturePadHandle>(null);
  const [submitting, setSubmitting] = useState(false);
  const savingRef = useRef(false);
  const queuedPhotoIds = useRef<Record<string, string>>({});
  const photoAttemptIds = useRef<Record<string, { photoId: string; operationId: string }>>({});
  const inspectionAttemptId = useRef<ReturnType<typeof crypto.randomUUID> | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedInspectionId, setSavedInspectionId] = useState<string | null>(null);
  const [visit, setVisit] = useState<InspectionVisit | null>(null);
  const [emailSync, setEmailSync] = useState<"syncing" | "ready" | "failed">("syncing");
  const [emailReason, setEmailReason] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    scrollPageToTop();
  }, [saved]);

  useEffect(() => {
    if (!savedInspectionId) return;
    let live = true;
    const watch = async () => {
      const result = await awaitInspectionSynced(savedInspectionId);
      if (!live) return;
      if (result.ok) setEmailSync("ready");
      else if (result.waiting) {
        setEmailSync("syncing");
        setEmailReason(result.reason);
      } else {
        setEmailSync("failed");
        setEmailReason(result.reason);
      }
    };
    void watch();
    const timer = window.setInterval(() => { void watch(); }, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [savedInspectionId]);

  const chosenType = resolveInspectionType(inspectionType, answers);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (savingRef.current) return;
    const unlockDownload = holdFacilityDownload();
    savingRef.current = true;
    setSubmitting(true);
    const release = () => { savingRef.current = false; setSubmitting(false); unlockDownload(); };
    const type = resolveInspectionType(inspectionType, answers);
    if (type !== "fire_door_nfpa80" && passed === null) { release(); return; }
    setSignatureError(null);

    const signatureDataUrl = signaturePadRef.current?.getDataUrl();
    if (!signatureDataUrl) {
      setSignatureError("A signature is required to save this inspection.");
      release();
      return;
    }
    if (!signedByName.trim()) {
      setSignatureError("Enter your name to sign off on this inspection.");
      release();
      return;
    }

    let checklist: Record<string, unknown> | undefined;
    let resultPassed = passed === "pass";
    if (type === "fire_door_nfpa80") {
      if (!qualification.trim()) {
        setSignatureError("Enter your qualification for this fire door inspection.");
        release();
        return;
      }
      if (!licenseNumber.trim()) {
        setSignatureError("Enter your inspector license number.");
        release();
        return;
      }
      const storageWarning = await lowStorageWarning();
      if (storageWarning) {
        setSignatureError(storageWarning);
        release();
        return;
      }
      const items: Record<string, unknown> = {};
      const stop = async (message: string) => {
        setSignatureError(message);
        unlockDownload();
        savingRef.current = false;
        setSubmitting(false);
      };
      try {
        for (const item of NFPA80_ITEMS) {
          const answer = answers[item.key];
          if (!answer?.result) return stop("Answer every fire door item before saving.");
          if (answer.result === "fail" && (!answer.note.trim() || (!answer.photo && !queuedPhotoIds.current[item.key]))) {
            return stop("A failed item needs a note and a photo.");
          }
          let photoId = queuedPhotoIds.current[item.key];
          if (answer.result === "fail" && !photoId && answer.photo) {
            const attempt = photoAttemptIds.current[item.key] ?? { photoId: crypto.randomUUID(), operationId: crypto.randomUUID() };
            photoAttemptIds.current[item.key] = attempt;
            const queued = await queueInspectionFailurePhoto(id!, answer.photo, answer.photo.name || "inspection-failure.jpg", attempt);
            if (queued.photoId) {
              photoId = queued.photoId;
              queuedPhotoIds.current[item.key] = photoId;
            }
            if (queued.kind !== "queued") return stop(queued.message);
          }
          items[item.key] = {
            result: answer.result,
            note: answer.note.trim() || undefined,
            photo_id: photoId,
          };
        }
      } catch (error) {
        noteSyncDiagnostic(error, true);
        return stop(inspectionSaveFailureMessage(error));
      }
      const outcome = fireDoorOutcome(answers);
      if (outcome.ok === false) return stop(outcome.error);
      resultPassed = outcome.passed;
      checklist = { status: "complete", items };
    }

    let inspectionId: string;
    let visitId: string | undefined;
    try {
    if (type === "fire_door_nfpa80") visitId = (await ensureOpenVisit())?.id;
    if (!inspectionAttemptId.current) inspectionAttemptId.current = crypto.randomUUID();
    inspectionId = await queueOpeningMutation("inspection_event", id!, {
        opening_id: id,
        event_date: eventDate,
        inspection_type: type,
        passed: resultPassed,
        notes: notes || undefined,
        signature_data: signatureDataUrl,
        signed_by_name: signedByName.trim(),
        inspector_qualification: type === "fire_door_nfpa80" ? qualification.trim() : undefined,
        inspector_license_number: type === "fire_door_nfpa80" ? licenseNumber.trim() : undefined,
        checklist_result: type === "fire_door_nfpa80" ? checklist : undefined,
        visit_id: visitId,
    }, inspectionAttemptId.current);

    setSaved(true);
    setSubmitting(false);
    unlockDownload();
    if (type === "fire_door_nfpa80") {
      setSavedInspectionId(inspectionId);
      if (visitId) setVisit(await recordVisitInspection(visitId, { inspectionId, openingId: id!, passed: resultPassed }));
      if (navigator.onLine) {
        flushOutbox().then(() => Promise.resolve(recomputeHealthScore(id!)).catch(() => {}));
      }
      return;
    }

    flushOutbox().then(() => {
      if (navigator.onLine) Promise.resolve(recomputeHealthScore(id!)).catch(() => {});
    });

    setTimeout(() => navigate(`/opening/${id}`), 700);
    } catch (error) {
      noteSyncDiagnostic(error, true);
      setSignatureError(inspectionSaveFailureMessage(error));
      release();
    }
  }

  return (
    <div className="app-shell c04">
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
          <div className="card">
            <p style={{ textAlign: "center", color: "var(--success)" }}>Saved.</p>
            {visit && <p className="c04-band-green" role="status">{visitSummaryText(visit.inspections)}</p>}
            {savedInspectionId && visit && <>
              <button type="button" className="btn c04-btn-blue" onClick={() => navigate("/scan")}>Add an Additional Opening</button>
              <button type="button" className="btn c04-btn-green" onClick={() => navigate(`/visit/${visit.id}`)}>Finish visit / Send combined report</button>
            </>}
            {savedInspectionId && <EmailInspectionReport inspectionId={savedInspectionId} syncStatus={emailSync} syncReason={emailReason} />}
            {!savedInspectionId && <p style={{ textAlign: "center" }}>Returning to the opening…</p>}
            <button type="button" className="btn btn-secondary" onClick={() => navigate(`/opening/${id}`)}>Back to the opening</button>
          </div>
        ) : (
          <form className="c04-band" onSubmit={onSubmit}>
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
              <select id="inspection-type" value={chosenType} onChange={(e) => {
                const next = e.target.value;
                if (checklistStarted(answers) && next !== "fire_door_nfpa80") return;
                setInspectionType(next);
              }}>
                {INSPECTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {chosenType === "fire_door_nfpa80" && (
              <div className="field">
                <label htmlFor="qualification">Qualification</label>
                <input id="qualification" value={qualification} onChange={(e) => setQualification(e.target.value)} placeholder="How you are qualified to inspect fire doors" />
                <label htmlFor="license-number">License number</label>
                <input id="license-number" value={licenseNumber} onChange={(e) => setLicenseNumber(e.target.value)} placeholder="License or certificate number" />
                {NFPA80_ITEMS.map((item) => {
                  const answer = answers[item.key] ?? { result: "", note: "", photo: null };
                  return (
                    <div key={item.key} style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 14 }}><strong>{item.section}</strong> {item.text}</div>
                      <select
                        aria-label={item.key}
                        value={answer.result}
                        onChange={(e) => setAnswers((current) => ({ ...current, [item.key]: { ...answer, result: e.target.value as ItemAnswer["result"] } }))}
                      >
                        <option value="">Choose</option>
                        <option value="pass">Pass</option>
                        <option value="fail">Fail</option>
                        {item.allowsNa && <option value="na">N/A</option>}
                      </select>
                      {answer.result === "fail" && (
                        <>
                          <textarea aria-label={`${item.key}-note`} value={answer.note} onChange={(e) => setAnswers((current) => ({ ...current, [item.key]: { ...answer, note: e.target.value } }))} placeholder="What failed" />
                          <input aria-label={`${item.key}-photo`} type="file" accept="image/*" onChange={(e) => setAnswers((current) => ({ ...current, [item.key]: { ...answer, photo: e.target.files?.[0] ?? null } }))} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {chosenType !== "fire_door_nfpa80" && <div className="field">
              <label>Result</label>
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  type="button"
                  className="btn"
                  style={{
                    background: passed === "pass" ? "var(--success)" : "var(--surface-raised)",
                    borderColor: passed === "pass" ? "var(--success)" : "var(--border)",
                    color: passed === "pass" ? "#fff" : "var(--text)",
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
                    color: passed === "fail" ? "#fff" : "var(--text)",
                  }}
                  onClick={() => setPassed("fail")}
                >
                  Failed
                </button>
              </div>
            </div>}

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

            <button type="submit" className="btn btn-primary" disabled={submitting || (chosenType !== "fire_door_nfpa80" && passed === null)}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
