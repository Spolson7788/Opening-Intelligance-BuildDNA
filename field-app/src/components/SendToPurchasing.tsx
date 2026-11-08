import { useEffect, useState } from "react";
import { listOpeningDocuments, sendHardwareToPurchasing } from "../lib/api";
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
  if (code === "purchasing_email_missing") return "No purchasing email is set. An admin or facility manager can set it under Purchasing email in the dashboard.";
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

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
      <div className="section-label">Send to purchasing</div>
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Choose a PDF from Files or Downloads, or take a photo of the sheet. iPhone names the file from its contents, not from the picker label.
      </p>
      {docs.map((doc) => (
        <label key={doc.id} style={{ display: "block", fontSize: 14, marginBottom: 6 }}>
          <input
            type="checkbox"
            checked={selected.includes(doc.id)}
            onChange={(e) => setSelected((current) => e.target.checked ? [...current, doc.id] : current.filter((id) => id !== doc.id))}
          />{" "}
          {doc.title}
        </label>
      ))}
      <div className="field">
        <label htmlFor="purchasing-pdf">PDF or photo</label>
        <input id="purchasing-pdf" type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      </div>
      <div className="field">
        <label htmlFor="purchasing-camera">Take a photo of the sheet</label>
        <input id="purchasing-camera" type="file" accept="image/*" capture="environment" onChange={(e) => choose(e.target.files?.[0] ?? null)} />
      </div>
      <div className="field">
        <label htmlFor="purchasing-note">Note (optional)</label>
        <textarea id="purchasing-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send to purchasing"}</button>
      {message && <p role={alert ? "alert" : "status"} style={{ fontSize: 14 }}>{message}</p>}
    </div>
  );
}
