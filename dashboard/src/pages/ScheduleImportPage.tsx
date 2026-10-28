import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ApiError, type FacilitySchedule, type Property, type ScheduleImportPreview, type ScheduleImportResolutions,
  confirmScheduleImport, createScheduleImport, fetchScheduleImport, listFacilitySchedules, listProperties, previewScheduleImport,
} from "../lib/api";
import { SchedulePage } from "../components/SchedulePage";
import { NO_FACILITIES_MESSAGE, facilitiesErrorMessage, clearImportDraft, isEmptyResolutions, loadImportDraft, saveImportDraft, STALE_IMPORT_MESSAGE } from "../lib/scheduleUi";

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
  const [noFacilities, setNoFacilities] = useState(false);
  const [facilitiesError, setFacilitiesError] = useState<string | null>(null);
  const loadFacility = () => {
    setFacilitiesError(null);
    return listProperties().then((ps) => { setNoFacilities(ps.length === 0); const p = ps.find((x) => x.id === propertyId) ?? null; setProperty(p); if (p?.buildings[0]) setBuildingId((cur) => cur || p.buildings[0].id); })
      .catch((err) => setFacilitiesError(facilitiesErrorMessage(err)));
  };
  useEffect(() => {
    loadFacility();
    if (propertyId) listFacilitySchedules(propertyId).then(setSchedules).catch(() => setMessage("Could not load schedules."));
  }, [propertyId]); // eslint-disable-line react-hooks/exhaustive-deps
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
    <SchedulePage title="Import door schedule" subtitle={property ? property.name : "Facility"} back={{ to: "/facility-schedules", label: "Back to schedules" }}>
      {noFacilities && <p className="empty-state" role="status">{NO_FACILITIES_MESSAGE}</p>}
      {facilitiesError && <p className="error-text" role="alert">{facilitiesError}{" "}
        <button type="button" className="btn btn-secondary" onClick={() => loadFacility()}>Retry</button></p>}
      <section className="panel">
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
      <button className="btn btn-primary" disabled={!buildingId || !doorVersionId || busy} onClick={start}>{busy ? "Reading..." : "Read schedule"}</button>
      {message && <p role="status">{message}</p>}
      </section>
    </SchedulePage>
  );
}

export function ScheduleImportPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<ScheduleImportPreview | null>(null);
  const [restored] = useState(() => loadImportDraft(id));
  const [res, setRes] = useState<ScheduleImportResolutions>(() => restored ?? { rows: {}, set_map: {}, row_sets: {}, accept_items: [], overwrite: [] });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetchScheduleImport(id).then((d) => {
      setData(d);
      if (d.import.status === "confirmed") { clearImportDraft(id); return; }
      // Re-plan with choices restored from this device so the preview matches them.
      if (restored && !isEmptyResolutions(restored)) previewScheduleImport(id, restored).then(setData).catch(() => {});
    }).catch(() => setMessage("Could not load import."));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!data || data.import.status === "confirmed") return;
    saveImportDraft(id, res);
    const t = setTimeout(() => previewScheduleImport(id, res).then(setData).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [res]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowById = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.id, r])), [data]);
  const setKeys = (data?.sets ?? []).map((s) => s.set_key);
  if (!data) return <SchedulePage title="Review schedule import" back={{ to: "/facility-schedules", label: "Back to schedules" }}><p className="empty-state">{message ?? "Loading..."}</p></SchedulePage>;
  if (data.import.status === "confirmed") return (
    <SchedulePage title="Schedule import confirmed" back={{ to: "/facility-schedules", label: "Back to schedules" }}>
      <section className="panel"><p><Link className="btn btn-primary" to={`/schedule-imports/${id}/comparison`}>Compare with field</Link></p>
        <pre>{JSON.stringify(data.result, null, 2)}</pre></section></SchedulePage>
  );
  const plan = data.plan!;
  const FOLLOW_UP_LABEL: Record<string, string> = { hw_varies: "Hardware <varies>", hw_group_x: "Group X", hw_group_undefined: "Group not in hardware schedule",
    hw_variant_none: "No variant applies", hw_none_chosen: "No hardware chosen" };
  const chooseRow = (rid: string, v: string) => { const m = { ...res.row_sets }; if (v === "") delete m[rid]; else m[rid] = v === "__none" ? null : v; setRes({ ...res, row_sets: m }); };
  const applyToAllSimilar = (key: string, rowIds: string[], v: string) => {
    const m = { ...res.set_map }; const rs = { ...res.row_sets }; rowIds.forEach((r) => delete rs[r]);
    if (v === "") delete m[key]; else m[key] = v === "__none" ? null : v; setRes({ ...res, set_map: m, row_sets: rs });
  };
  const toggle = (list: string[] | undefined, v: string) => (list ?? []).includes(v) ? (list ?? []).filter((x) => x !== v) : [...(list ?? []), v];
  async function doConfirm() {
    if (data?.import.stale) { setMessage(STALE_IMPORT_MESSAGE); return; }
    setBusy(true); setMessage(null);
    try { await confirmScheduleImport(id, res); clearImportDraft(id); setData(await fetchScheduleImport(id)); }
    catch (err) { setMessage(confirmErrorMessage(err)); }
    finally { setBusy(false); }
  }
  return (
    <SchedulePage title="Review schedule import" back={{ to: "/facility-schedules", label: "Back to schedules" }}
      subtitle="Resolve the issues, check the change preview, then use Confirm import at the bottom of the page.">
      {data.import.stale && <p role="alert" className="error-text">{STALE_IMPORT_MESSAGE}{" "}
        <Link to={`/schedule-imports/new?property=${data.import.property_id}`}>Start again</Link></p>}
      {restored && !isEmptyResolutions(restored) && <p role="note" className="schedule-note">Restored your unsaved choices from this device.</p>}
      <section className="panel">
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
            {i.code === "ambiguous_group" && i.key && (
              <div>
                <label>Apply to all similar (Group {i.key}){" "}
                  <select value={res.set_map?.[i.key] === undefined ? "" : res.set_map[i.key] ?? "__none"} onChange={(e) => applyToAllSimilar(i.key!, i.row_ids ?? [], e.target.value)}>
                    <option value="">(choose per door)</option><option value="__none">No hardware (follow-up)</option>
                    {(i.variants ?? []).map((k) => <option key={k} value={k}>Set {k}</option>)}
                  </select>
                </label>
                {(i.row_ids ?? []).map((rid) => {
                  const row = rowById.get(rid); const open = (i.unresolved_row_ids ?? []).includes(rid);
                  return <div key={rid} data-pending={open}>Door {row?.door_mark ?? "?"} (row {row?.source_row}) {row?.room_name ?? ""}{" "}
                    <select value={res.row_sets?.[rid] === undefined ? "" : res.row_sets[rid] ?? "__none"} onChange={(e) => chooseRow(rid, e.target.value)}>
                      <option value="">{res.set_map?.[i.key!] !== undefined ? "(same as all similar)" : "(choose variant)"}</option><option value="__none">No hardware (follow-up)</option>
                      {(i.variants ?? []).map((k) => <option key={k} value={k}>Set {k}</option>)}
                    </select>{open && <strong> choice required</strong>}</div>;
                })}
              </div>
            )}
            {i.code === "unknown_group" && i.key && (
              <select value={res.set_map?.[i.key] === undefined ? "" : res.set_map[i.key] ?? "__none"} onChange={(e) => {
                const m = { ...res.set_map }; if (e.target.value === "") delete m[i.key!]; else m[i.key!] = e.target.value === "__none" ? null : e.target.value; setRes({ ...res, set_map: m });
              }}>
                <option value="">(no hardware, follow-up)</option><option value="__none">No hardware, follow-up</option>
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
      </section>
      <section className="panel">
      <h2>Change preview</h2>
      <p>{Object.entries(plan.summary).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</p>
      <table>
        <thead><tr><th>Row</th><th>Mark</th><th>Action</th><th>Changes</th><th>Hardware (qty)</th><th>Follow-up</th></tr></thead>
        <tbody>
          {plan.openings.map((o) => (
            <tr key={o.row_id}>
              <td>{o.source_row}</td><td>{o.mark ?? "-"}</td><td>{o.action}{o.skip_reason ? ` (${o.skip_reason})` : ""}</td>
              <td>{o.fields.filter((f) => f.status !== "same").map((f, n) => (
                <div key={n}>{f.entity} {f.field}: {String(f.from ?? "")} → {String(f.to)} [{f.status}]
                  {f.overwrite_key && <label> <input type="checkbox" checked={(res.overwrite ?? []).includes(f.overwrite_key)} onChange={() => setRes({ ...res, overwrite: toggle(res.overwrite, f.overwrite_key!) })} /> overwrite field-verified value</label>}
                </div>))}</td>
              <td>{o.variant_choice && <div>Group {o.variant_choice.group}: {o.variant_choice.pending ? <strong>choose a variant</strong> : o.variant_choice.chosen ? `set ${o.variant_choice.chosen}` : "none"}</div>}
                {o.hardware.map((h) => <div key={h.item_id}>{h.qty ?? "?"} × {h.description} [{h.action}]</div>)}</td>
              <td>{o.follow_up ? <strong data-follow-up={o.follow_up.reason}>Follow up: {FOLLOW_UP_LABEL[o.follow_up.reason] ?? o.follow_up.reason}{o.follow_up.detail ? ` (${o.follow_up.detail})` : ""}</strong> : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </section>
      <div className="schedule-confirm-bar">
      {message && <p role="status">{message}</p>}
      <button className="btn btn-primary" disabled={plan.blocked || busy || !!data.import.stale} onClick={doConfirm}>{busy ? "Applying..." : data.import.stale ? "Start the import again to confirm" : plan.blocked ? "Resolve blocking issues to confirm" : "Confirm import"}</button>
      </div>
    </SchedulePage>
  );
}

/** Confirm failure text; a gateway timeout (502/504) rolls the whole transaction back. */
export function confirmErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.message === "unresolved_blockers") return "Resolve the blocking issues first.";
  if (err instanceof ApiError && err.message === "import_stale_schedule_type_changed") return STALE_IMPORT_MESSAGE;
  if (err instanceof ApiError && (err.status === 502 || err.status === 504)) return "Import timed out. Nothing was changed. Try again.";
  return "Confirm failed. Nothing was changed.";
}
