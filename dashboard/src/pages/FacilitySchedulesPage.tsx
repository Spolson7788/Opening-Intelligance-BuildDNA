import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ScheduleFollowUps } from "./ScheduleFollowUps";
import { SchedulePage } from "../components/SchedulePage";
import { ProviderHistorySharingToggle } from "../components/ProviderHistorySharingToggle";
import { useAuth } from "../lib/AuthContext";
import {
  ApiError, FACILITY_SCHEDULE_MAX_BYTES, type FacilitySchedule, type Property, type ScheduleImportListItem,
  archiveSchedule, changeScheduleKind, listFacilitySchedules, listProperties, listScheduleImports, unarchiveSchedule, uploadFacilitySchedule,
} from "../lib/api";
import { NO_FACILITIES_MESSAGE, facilitiesErrorMessage, kindChangeWarning, kindForFilename, scheduleChangeErrorMessage } from "../lib/scheduleUi";

const ACCEPT = ".pdf,.csv,.xlsx,.xls,.docx";

// M1: store door / hardware schedules on a facility as immutable versions.
// M2: door schedule versions (XLSX/CSV) link to the import review page.
// M3: dashboard shell, type picked from the file name, drafts list, no-facility notice.
export function FacilitySchedulesPage() {
  const { auth } = useAuth();
  const [properties, setProperties] = useState<Property[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [propertyId, setPropertyId] = useState("");
  const [schedules, setSchedules] = useState<FacilitySchedule[]>([]);
  const [imports, setImports] = useState<ScheduleImportListItem[]>([]);
  const [kind, setKind] = useState<"door" | "hardware">("door");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [replaceId, setReplaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [facilitiesError, setFacilitiesError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [changeMessage, setChangeMessage] = useState<string | null>(null);

  const loadFacilities = () => {
    setFacilitiesError(null);
    return listProperties().then((p) => { setProperties(p); setLoaded(true); if (p[0]) setPropertyId((cur) => cur || p[0].id); })
      .catch((err) => setFacilitiesError(facilitiesErrorMessage(err)));
  };
  useEffect(() => { loadFacilities(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = (id: string) => Promise.all([
    listFacilitySchedules(id, showArchived).then(setSchedules).catch(() => setMessage("Could not load schedules.")),
    listScheduleImports(id).then(setImports).catch(() => setImports([])),
  ]);
  useEffect(() => { if (propertyId) refresh(propertyId); }, [propertyId, showArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickFile(f: File | null) {
    setFile(f);
    const guess = f ? kindForFilename(f.name) : null;
    if (guess && guess !== kind) { setKind(guess); setReplaceId(""); }
  }

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

  // M3B: correct a type (warning if the file looks like the other type) and archive / unarchive.
  async function changeType(s: FacilitySchedule) {
    const target = s.kind === "door" ? "hardware" : "door";
    const head = s.versions.find((v) => v.version === s.head_version);
    const warning = kindChangeWarning(target, head?.original_filename);
    if (!window.confirm(warning ?? `Change "${s.title}" to a ${target} schedule? Draft imports using it must be started again.`)) return;
    const reason = window.prompt("Reason for the type change", "Uploaded with the wrong type");
    if (!reason || !reason.trim()) return;
    setChangeMessage(null);
    try {
      const r = await changeScheduleKind(s.id, { kind: target, reason: reason.trim(), ...(warning ? { acknowledge_mismatch: true } : {}) });
      setChangeMessage(`Type changed to ${target}.` + (r.stale_draft_import_ids.length ? ` ${r.stale_draft_import_ids.length} draft import(s) must be started again.` : ""));
      await refresh(propertyId);
    } catch (err) { setChangeMessage(scheduleChangeErrorMessage(err)); }
  }
  async function toggleArchive(s: FacilitySchedule) {
    if (!s.archived_at && !window.confirm(`Archive "${s.title}"? It is hidden from lists; its files and history are kept and you can unarchive it.`)) return;
    setChangeMessage(null);
    try {
      if (s.archived_at) await unarchiveSchedule(s.id); else await archiveSchedule(s.id);
      setChangeMessage(s.archived_at ? "Schedule unarchived." : "Schedule archived.");
      await refresh(propertyId);
    } catch (err) { setChangeMessage(scheduleChangeErrorMessage(err)); }
  }

  const sameKind = schedules.filter((s) => s.kind === kind && !s.archived_at);
  const noFacilities = loaded && properties.length === 0;
  return (
    <SchedulePage title="Door & hardware schedules" back={{ to: "/", label: "Back to dashboard" }}
      subtitle="Upload door and hardware schedules, then import a door schedule into a building.">
      {noFacilities && <p className="empty-state" role="status">{NO_FACILITIES_MESSAGE}</p>}
      {facilitiesError && <p className="error-text" role="alert">{facilitiesError}{" "}
        <button type="button" className="btn btn-secondary" onClick={() => loadFacilities()}>Retry</button></p>}
      <section className="panel">
        <h2>Upload a schedule</h2>
        <label>Facility{" "}
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} disabled={noFacilities}>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <ProviderHistorySharingToggle property={properties.find((p) => p.id === propertyId)} role={auth?.role}
          onChanged={(on) => setProperties((ps) => ps.map((p) => p.id === propertyId ? { ...p, share_provider_service_history: on } : p))} />
        <form onSubmit={submit} aria-label="Upload schedule">
          <label>File <input type="file" accept={ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} /></label>
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
          <button type="submit" className="btn btn-primary" disabled={!file || busy || !propertyId}>{busy ? "Uploading..." : "Upload"}</button>
        </form>
        {message && <p role="status">{message}</p>}
      </section>
      <section className="panel">
        <h2>Stored schedules</h2>
        <label><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {changeMessage && <p role="status">{changeMessage}</p>}
        <table>
          <thead><tr><th>Title</th><th>Type</th><th>Version</th><th>File</th><th>Size</th><th>Uploaded</th><th>SHA-256</th><th></th></tr></thead>
          <tbody>
            {schedules.flatMap((s) => s.versions.map((v) => (
              <tr key={v.id}>
                <td>{s.title}{s.archived_at ? " (archived)" : ""}</td><td>{s.kind === "door" ? "Door" : "Hardware"}</td>
                <td>v{v.version}{v.version === s.head_version ? " (current)" : ""}</td>
                <td>{v.original_filename}</td><td>{Math.ceil(v.byte_size / 1024)} KB</td>
                <td>{new Date(v.uploaded_at).toLocaleString()}</td><td><code>{v.sha256.slice(0, 12)}</code></td>
                <td>{s.kind === "door" && /(sheet|csv)/.test(v.content_type) && !v.content_type.includes("ms-excel")
                  && !s.archived_at ? <Link to={`/schedule-imports/new?property=${propertyId}&version=${v.id}`}>Import to building</Link> : null}
                  {v.version === s.head_version && <span className="schedule-actions">{" "}
                    {!s.archived_at && <button type="button" className="btn btn-secondary" onClick={() => changeType(s)}>Change type</button>}{" "}
                    <button type="button" className="btn btn-secondary" onClick={() => toggleArchive(s)}>{s.archived_at ? "Unarchive" : "Archive"}</button></span>}</td>
              </tr>
            )))}
            {schedules.length === 0 && <tr><td colSpan={8}>No schedules uploaded for this facility.</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Drafts and imports</h2>
        <table>
          <thead><tr><th>Building</th><th>Status</th><th>Started</th><th>Confirmed</th><th></th></tr></thead>
          <tbody>
            {imports.map((i) => (
              <tr key={i.id}>
                <td>{i.building_name}</td><td>{i.status === "confirmed" ? "Confirmed" : i.stale ? "Draft (schedule type changed - start again)" : "Draft"}</td>
                <td>{new Date(i.created_at).toLocaleString()}</td><td>{i.confirmed_at ? new Date(i.confirmed_at).toLocaleString() : ""}</td>
                <td><Link to={`/schedule-imports/${i.id}`}>{i.status === "confirmed" ? "View result" : "Open review"}</Link></td>
              </tr>
            ))}
            {imports.length === 0 && <tr><td colSpan={5}>No imports started for this facility.</td></tr>}
          </tbody>
        </table>
      </section>
      {propertyId && <ScheduleFollowUps propertyId={propertyId} />}
    </SchedulePage>
  );
}