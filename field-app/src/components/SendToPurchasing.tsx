import { useEffect, useState } from "react";
import { listOpeningDocuments, sendHardwareToPurchasing } from "../lib/api";

type Doc = { id: string; title: string; document_type: string };

async function fileToBase64(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(data);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function SendToPurchasing({ openingId, hardwareId, principal }: { openingId: string; hardwareId: string; principal: any }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    listOpeningDocuments(openingId, principal)
      .then((rows: Doc[]) => setDocs(Array.isArray(rows) ? rows : []))
      .catch(() => setDocs([]));
  }, [openingId, principal]);

  async function send() {
    setBusy(true);
    setMessage(null);
    try {
      const uploads = file ? [{ filename: file.name.toLowerCase().endsWith(".pdf") ? file.name : `${file.name}.pdf`, content_base64: await fileToBase64(file) }] : [];
      if (selected.length === 0 && uploads.length === 0) {
        setMessage("Choose a cut sheet or upload a PDF.");
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
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border)" }}>
      <div className="section-label">Send to purchasing</div>
      <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Choose the cut sheet or installation sheet for this hardware. If none is on the opening, upload a PDF.
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
        <label htmlFor="purchasing-pdf">Upload a PDF</label>
        <input id="purchasing-pdf" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div className="field">
        <label htmlFor="purchasing-note">Note (optional)</label>
        <textarea id="purchasing-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send to purchasing"}</button>
      {message && <p style={{ fontSize: 14 }}>{message}</p>}
    </div>
  );
}
