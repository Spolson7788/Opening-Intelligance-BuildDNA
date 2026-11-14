import { useEffect, useState } from "react";
import { listOpeningDocuments, purchasingDestination, sendHardwareToPurchasing } from "../lib/api";
import type { PurchasingDestination } from "../lib/api";
import { checklistPhotoJpeg } from "../lib/photoPreparation";
import { purchasingSheetName, purchasingSheetProblem, sheetKind } from "../lib/purchasingSheet";

type Doc = { id: string; title: string; document_type: string };

async function fileToBase64(file: Blob): Promise<string> {
  const data = await file.arrayBuffer();
  let binary = "";
  for (const byte of new Uint8Array(data)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sendFailure(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "sheet_unreadable" || code === "pdf_required") return "That file is not a PDF or a photo the server can read. Choose it again from Files, or take a photo of the sheet.";
  if (code === "purchasing_email_missing") return "No purchasing email is set for this branch or the company. An admin or facility manager can set it under Purchasing email in the dashboard.";
  if (code === "branch_unknown") return "No branch covers this job's location, so purchasing was not sent.";
  if (code === "branch_choice_required") return "More than one branch covers this job. Choose the branch before sending.";
  if (code === "branch_not_authorized") return "That branch cannot receive purchasing for this job.";
  if (code === "email_not_configured") return "Email is not set up on this server.";
  if (code === "email_send_failed") return "The email service rejected the message.";
  if (code === "invalid_send") return "The file could not be sent. Try a smaller PDF or a photo of the sheet.";
  if (code === "encode_failed") return "This photo could not be prepared. Take it again or choose a JPEG.";
  return "Could not send. Check the connection and try again.";
}

export function SendToPurchasing({ openingId, hardwareId, principal }: { openingId: string; hardwareId: string; principal: any }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [alert, setAlert] = useState(false);
  const [branchId, setBranchId] = useState("");
  const [destination, setDestination] = useState<PurchasingDestination | null>(null);

  useEffect(() => {
    let live = true;
    purchasingDestination(openingId, branchId || undefined, principal)
      .then((row) => { if (live) setDestination(row); })
      .catch((error) => { if (live) setDestination({ ready: false, error: error instanceof Error ? error.message : "purchasing_destination_failed" }); });
    return () => { live = false; };
  }, [openingId, branchId, principal]);

  useEffect(() => {
    listOpeningDocuments(openingId, principal)
      .then((rows: Doc[]) => setDocs(Array.isArray(rows) ? rows : []))
      .catch(() => setDocs([]));
  }, [openingId, principal]);

  function choose(next: File | null) {
    setFile(next);
    setAlert(false);
    setMessage(next ? `Selected ${next.name || "sheet"}.` : null);
  }

  async function send() {
    setBusy(true);
    setMessage(null);
    setAlert(false);
    try {
      const uploads = [];
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const problem = purchasingSheetProblem(file, bytes);
        if (problem) {
          setMessage(problem);
          setAlert(true);
          setBusy(false);
          return;
        }
        const kind = sheetKind(bytes);
        if (kind === "pdf") {
          uploads.push({ filename: purchasingSheetName(file.name, "pdf"), content_base64: await fileToBase64(file) });
        } else {
          const jpeg = await checklistPhotoJpeg(file);
          uploads.push({ filename: purchasingSheetName(file.name, "jpeg"), content_base64: await fileToBase64(jpeg) });
        }
      }
      if (selected.length === 0 && uploads.length === 0) {
        setMessage("Choose a cut sheet, upload a PDF, or take a photo of the sheet.");
        setAlert(true);
        setBusy(false);
        return;
      }
      await sendHardwareToPurchasing({
        opening_id: openingId,
        hardware_component_id: hardwareId,
        note: note || undefined,
        document_ids: selected,
        uploads,
        branch_id: branchId || undefined,
      }, principal);
      setMessage("Sent to purchasing.");
      setFile(null);
    } catch (err) {
      setMessage(sendFailure(err));
      setAlert(true);
    } finally {
      setBusy(false);
    }
  }

  const needsBranch = (destination?.choices?.length ?? 0) > 1;
  const blocked = destination && !destination.ready ? sendFailure(new Error(destination.error || "purchasing_destination_failed")) : null;
  return (
    <section className="c04-purchasing" aria-label="Send to purchasing">
      <h2>Send to purchasing</h2>
      {destination === null && <p id="purchasing-block" role="status">Checking where this job should be sent.</p>}
      {blocked && <p id="purchasing-block" className="c04-alert" role="alert">{blocked}</p>}
      {needsBranch && (
        <div className="c04-step c04-band-blue">
          <h3><span>1</span> Choose a recipient</h3>
          <div className="field">
            <label htmlFor="purchasing-branch">Branch for this job <span className="c04-required">Required</span></label>
            <select id="purchasing-branch" value={branchId} aria-required="true" aria-invalid={branchId === ""} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Choose a branch</option>
              {destination?.choices?.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </div>
          <p>Recipient appears after branch selection.</p>
        </div>
      )}
      {destination?.ready && (
        <p className="c04-recipient" role="status">
          {destination.branch ? `${destination.branch.name}: ` : "Company purchasing: "}
          {destination.to}
          {destination.source === "company" && destination.branch ? " (company address; this branch has none of its own)" : ""}
        </p>
      )}
      <div className="c04-step c04-band-blue">
        <h3><span>2</span> Add a PDF or photo</h3>
        <p>Use Files or Downloads, or photograph the sheet. On iPhone, the file name comes from its contents, not from the picker label.</p>
        {docs.length > 0 && <p>Saved sheets on this opening</p>}
        {docs.map((doc) => (
          <label key={doc.id} className="c04-check">
            <input
              type="checkbox"
              checked={selected.includes(doc.id)}
              onChange={(e) => setSelected((current) => e.target.checked ? [...current, doc.id] : current.filter((id) => id !== doc.id))}
            />
            {doc.title}
          </label>
        ))}
        <label className="btn c04-btn-blue c04-file">
          Choose PDF or photo
          <input id="purchasing-pdf" type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
        </label>
        <label className="btn c04-btn-cyan c04-file">
          Take a photo of the sheet
          <input id="purchasing-camera" type="file" accept="image/*" capture="environment" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
        </label>
      </div>
      <div className="c04-step c04-step-note">
        <h3><span>3</span> Add a note <em>Optional</em></h3>
        <div className="field">
          <label htmlFor="purchasing-note">Note</label>
          <textarea id="purchasing-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <button type="button" className="btn btn-primary" onClick={send} disabled={busy || !destination?.ready} aria-describedby={blocked || destination === null ? "purchasing-block" : undefined}>{busy ? "Sending…" : "Send to purchasing"}</button>
      {needsBranch && !destination?.ready && !busy && <p className="c04-note">Choose a branch to enable sending.</p>}
      {message && <p role={alert ? "alert" : "status"} className={alert ? "c04-alert" : undefined}>{message}</p>}
    </section>
  );
}
