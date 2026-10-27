import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ApiError, FACILITY_SCHEDULE_MAX_BYTES, type FacilitySchedule, type Property,
  listFacilitySchedules, listProperties, uploadFacilitySchedule,
} from "../lib/api";

const ACCEPT = ".pdf,.csv,.xlsx,.xls,.docx";

// M1: store door / hardware schedules on a facility as immutable versions.
// M2: door schedule versions (XLSX/CSV) link to the import review page.
export function FacilitySchedulesPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [propertyId, setPropertyId] = useState("");
  const [schedules, setSchedules] = useState<FacilitySchedule[]>([]);
  const [kind, setKind] = useState<"door" | "hardware">("door");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [replaceId, setReplaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    listProperties().then((p) => { setProperties(p); if (p[0]) setPropertyId(p[0].id); }).catch(() => setMessage("Could not load facilities."));
  }, []);
  const refresh = (id: string) => listFacilitySchedules(id).then(setSchedules).catch(() => setMessage("Could not load schedules."));
  useEffect(() => { if (propertyId) refresh(propertyId); }, [propertyId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !propertyId) return;
    if (file.size > FACILITY_SCHEDULE_MAX_BYTES) { setMessage("File is larger than 25 MB."); return; }
    setBusy(true); setMessage(null);
    try {
      await uploadFacilitySchedule({ propertyId, kind, title: title || file.name, file, scheduleId: replaceId || undefined });
      setFile(null); setTitle(""); setReplaceId("");
      setMessage("Schedule stored.");
      await refresh(propertyId);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      setMessage(code === "insufficient_role_for_action" ? "Your role cannot upload schedules."
        : code === "storage_not_configured" ? "File storage is not configured in this environment."
        : "Upload failed. Nothing was stored.");
    } finally { setBusy(false); }
  }

  const sameKind = schedules.filter((s) => s.kind === kind);
  return (
    <div className="page">
      <p><Link to="/">Back to dashboard</Link></p>
      <h1>Door &amp; hardware schedules</h1>
      <label>Facility{" "}
        <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <form onSubmit={submit} aria-label="Upload schedule">
        <label>Type{" "}
          <select value={kind} onChange={(e) => { setKind(e.target.value as "door" | "hardware"); setReplaceId(""); }}>
            <option value="door">Door schedule</option>
            <option value="hardware">Door hardware schedule</option>
          </select>
        </label>
        <label>Title <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
        <label>New version of{" "}
          <select value={replaceId} onChange={(e) => setReplaceId(e.target.value)}>
            <option value="">(new schedule)</option>
            {sameKind.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </label>
        <input type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button type="submit" disabled={!file || busy}>{busy ? "Uploading..." : "Upload"}</button>
      </form>
      {message && <p role="status">{message}</p>}
      <table>
        <thead><tr><th>Title</th><th>Type</th><th>Version</th><th>File</th><th>Size</th><th>Uploaded</th><th>SHA-256</th><th></th></tr></thead>
        <tbody>
          {schedules.flatMap((s) => s.versions.map((v) => (
            <tr key={v.id}>
              <td>{s.title}</td><td>{s.kind === "door" ? "Door" : "Hardware"}</td>
              <td>v{v.version}{v.version === s.head_version ? " (current)" : ""}</td>
              <td>{v.original_filename}</td><td>{Math.ceil(v.byte_size / 1024)} KB</td>
              <td>{new Date(v.uploaded_at).toLocaleString()}</td><td><code>{v.sha256.slice(0, 12)}</code></td>
              <td>{s.kind === "door" && /(sheet|csv)/.test(v.content_type) && !v.content_type.includes("ms-excel")
                ? <Link to={`/schedule-imports/new?property=${propertyId}&version=${v.id}`}>Import to building</Link> : null}</td>
            </tr>
          )))}
          {schedules.length === 0 && <tr><td colSpan={8}>No schedules uploaded for this facility.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}