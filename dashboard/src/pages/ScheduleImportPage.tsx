import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError, type FacilitySchedule, type Property, type ScheduleImportPreview, type ScheduleImportResolutions,
  confirmScheduleImport, createScheduleImport, fetchScheduleImport, listFacilitySchedules, listProperties, previewScheduleImport,
} from "../lib/api";

// M2: parse a stored door schedule (plus optional hardware schedule) for one
// building, review issues and the change plan, resolve, then confirm.
export function ScheduleImportStartPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const propertyId = params.get("property") ?? "";
  const doorVersionId = params.get("version") ?? "";
  const [property, setProperty] = useState<Property | null>(null);
  const [schedules, setSchedules] = useState<FacilitySchedule[]>([]);
  const [buildingId, setBuildingId] = useState("");
  const [hardwareVersionId, setHardwareVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    listProperties().then((ps) => { const p = ps.find((x) => x.id === propertyId) ?? null; setProperty(p); if (p?.buildings[0]) setBuildingId(p.buildings[0].id); }).catch(() => setMessage("Could not load facility."));
    if (propertyId) listFacilitySchedules(propertyId).then(setSchedules).catch(() => setMessage("Could not load schedules."));
  }, [propertyId]);
  const hardwareVersions = schedules.filter((s) => s.kind === "hardware").flatMap((s) => s.versions.map((v) => ({ ...v, title: s.title })));
  async function start() {
    setBusy(true); setMessage(null);
    try {
      const r = await createScheduleImport({ building_id: buildingId, door_version_id: doorVersionId, ...(hardwareVersionId ? { hardware_version_id: hardwareVersionId } : {}) });
      navigate(`/schedule-imports/${r.id}`);
    } catch (err) {
      const code = err instanceof ApiError ? err.message : "";
      setMessage(code === "door_schedule_format_not_parsed" ? "Only XLSX and CSV door schedules can be imported. PDF and XLS files are stored but not parsed."
        : code === "hardware_schedule_format_not_parsed" ? "Only DOCX hardware schedules can be imported."
        : code === "insufficient_role_for_action" ? "Your role cannot import schedules." : "Could not read the schedule. Nothing was changed.");
    } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <p><Link to="/facility-schedules">Back to schedules</Link></p>
      <h1>Import door schedule</h1>
      <p>{property ? property.name : "Facility"}</p>
      <label>Building{" "}
        <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
          {(property?.buildings ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label>Hardware schedule{" "}
        <select value={hardwareVersionId} onChange={(e) => setHardwareVersionId(e.target.value)}>
          <option value="">(none)</option>
          {hardwareVersions.map((v) => <option key={v.id} value={v.id}>{v.title} v{v.version} ({v.original_filename})</option>)}
        </select>
      </label>
      <button disabled={!buildingId || !doorVersionId || busy} onClick={start}>{busy ? "Reading..." : "Read schedule"}</button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function ScheduleImportPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<ScheduleImportPreview | null>(null);
  const [res, setRes] = useState<ScheduleImportResolutions>({ rows: {}, set_map: {}, accept_items: [], overwrite: [] });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetchScheduleImport(id).then(setData).catch(() => setMessage("Could not load import.")); }, [id]);
  useEffect(() => {
    if (!data || data.import.status === "confirmed") return;
    const t = setTimeout(() => previewScheduleImport(id, res).then(setData).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [res]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowById = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.id, r])), [data]);
  const setKeys = (data?.sets ?? []).map((s) => s.set_key);
  if (!data) return <div className="page"><p>{message ?? "Loading..."}</p></div>;
  if (data.import.status === "confirmed") return (
    <div className="page"><p><Link to="/facility-schedules">Back to schedules</Link></p><h1>Schedule import confirmed</h1>
      <pre>{JSON.stringify(data.result, null, 2)}</pre></div>
  );
  const plan = data.plan!;
  const toggle = (list: string[] | undefined, v: string) => (list ?? []).includes(v) ? (list ?? []).filter((x) => x !== v) : [...(list ?? []), v];
  async function doConfirm() {
    setBusy(true); setMessage(null);
    try { await confirmScheduleImport(id, res); setData(await fetchScheduleImport(id)); }
    catch (err) { setMessage(err instanceof ApiError && err.message === "unresolved_blockers" ? "Resolve the blocking issues first." : "Confirm failed. Nothing was changed."); }
    finally { setBusy(false); }
  }
  return (
    <div className="page">
      <p><Link to="/facility-schedules">Back to schedules</Link></p>
      <h1>Review schedule import</h1>
      <h2>Issues</h2>
      <ul>
        {plan.issues.map((i, n) => (
          <li key={n} data-severity={i.severity}>
            <strong>{i.severity}</strong> {i.message}
            {i.code === "duplicate_mark" && (i.row_ids ?? []).map((rid) => (
              <div key={rid}>Row {rowById.get(rid)?.source_row} ({rowById.get(rid)?.room_name ?? ""}){" "}
                <label><input type="checkbox" checked={!!res.rows?.[rid]?.skip} onChange={(e) => setRes({ ...res, rows: { ...res.rows, [rid]: { skip: e.target.checked } } })} /> skip</label>{" "}
                <input placeholder="new mark" value={res.rows?.[rid]?.mark ?? ""} onChange={(e) => setRes({ ...res, rows: { ...res.rows, [rid]: e.target.value ? { mark: e.target.value } : {} } })} />
              </div>
            ))}
            {(i.code === "unknown_group" || i.code === "ambiguous_group") && i.key && (
              <select value={res.set_map?.[i.key] === undefined ? "" : res.set_map[i.key] ?? "__none"} onChange={(e) => {
                const m = { ...res.set_map }; if (e.target.value === "") delete m[i.key!]; else m[i.key!] = e.target.value === "__none" ? null : e.target.value; setRes({ ...res, set_map: m });
              }}>
                <option value="">(unresolved)</option><option value="__none">No hardware</option>
                {setKeys.map((k) => <option key={k} value={k}>Set {k}</option>)}
              </select>
            )}
            {i.code === "unmatched_items" && (i.item_ids ?? []).map((iid) => {
              const it = data.sets?.flatMap((s) => s.items).find((x) => x.id === iid);
              return <div key={iid}><label><input type="checkbox" checked={(res.accept_items ?? []).includes(iid)} onChange={() => setRes({ ...res, accept_items: toggle(res.accept_items, iid) })} />
                accept "{it?.description}" {it?.catalog_raw ?? ""} {it?.manufacturer_raw ?? ""} ({(it?.review_reasons ?? []).join(", ")})</label></div>;
            })}
          </li>
        ))}
      </ul>
      <h2>Change preview</h2>
      <p>{Object.entries(plan.summary).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</p>
      <table>
        <thead><tr><th>Row</th><th>Mark</th><th>Action</th><th>Changes</th><th>Hardware</th></tr></thead>
        <tbody>
          {plan.openings.map((o) => (
            <tr key={o.row_id}>
              <td>{o.source_row}</td><td>{o.mark ?? "-"}</td><td>{o.action}{o.skip_reason ? ` (${o.skip_reason})` : ""}</td>
              <td>{o.fields.filter((f) => f.status !== "same").map((f, n) => (
                <div key={n}>{f.entity} {f.field}: {String(f.from ?? "")} → {String(f.to)} [{f.status}]
                  {f.overwrite_key && <label> <input type="checkbox" checked={(res.overwrite ?? []).includes(f.overwrite_key)} onChange={() => setRes({ ...res, overwrite: toggle(res.overwrite, f.overwrite_key!) })} /> overwrite field-verified value</label>}
                </div>))}</td>
              <td>{o.hardware.map((h) => <div key={h.item_id}>{h.description} [{h.action}]</div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {message && <p role="status">{message}</p>}
      <button disabled={plan.blocked || busy} onClick={doConfirm}>{busy ? "Applying..." : plan.blocked ? "Resolve blocking issues to confirm" : "Confirm import"}</button>
    </div>
  );
}
