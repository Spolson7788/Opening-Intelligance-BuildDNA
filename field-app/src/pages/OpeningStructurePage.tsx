import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchOpening, readMeasurementPhoto, setOpeningConfiguration } from "../lib/api";
import { queueOpeningMutation } from "../lib/sync";
import { updateCachedOpening } from "../lib/db";
import { PhotoCapture } from "../components/PhotoCapture";
import { useAuth } from "../lib/AuthContext";
import { dimensionDraft, dimensionPayload, parseInches, unevenPair } from "../lib/inchMeasure";
import { draftsFromSuggestions, measurementErrorCode, measurementReadPresentation, measurementSavedSummary, measurementTargets, parseEditedInches, planMeasurementSave, targetLabel, validateMeasurementDrafts } from "../lib/measurementSuggestions";
import type { MeasurementDraft } from "../lib/measurementSuggestions";
import { prepareMeasurementImage } from "../lib/photoPreparation";
import type { DimensionDraft } from "../lib/inchMeasure";

export function OpeningStructurePage() {
  const { id } = useParams();
  const { auth } = useAuth();
  if (!id || !auth) return <p role="alert">Sign in and open an authorized opening before editing its structure.</p>;
  return <LoadedStructure key={`${auth.organizationId}:${auth.userId}:${id}`} id={id} />;
}

function LoadedStructure({ id }: { id: string }) {
  const [opening, setOpening] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    fetchOpening(id).then(({ opening: record }) => {
      if (!active) return;
      if (record?.id !== id || !["single", "pair"].includes(record.opening_configuration)) {
        setFailed(true); return;
      }
      setOpening(record);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id]);
  if (failed) return <div role="alert">Opening structure could not be loaded. No changes were made. <Link to={`/opening/${id}`}>Return to opening</Link></div>;
  if (!opening) return <p role="status">Loading opening structure…</p>;
  return <StructureEditor key={`${opening.id}:${opening.opening_configuration}`} id={id} opening={opening} onOpening={setOpening} />;
}

function leafOf(opening: any, role: string) {
  return opening?.door_leaves?.find((leaf: any) => leaf.leaf_role === role);
}

function StructureEditor({ id, opening, onOpening }: { id: string; opening: any; onOpening: (opening: any) => void }) {
  const navigate = useNavigate();
  const { auth } = useAuth();
  const [principal] = useState(() => auth!);
  const configuration = opening?.opening_configuration === "pair" ? "pair" : "single";
  const roles = configuration === "pair" ? ["active", "inactive"] : ["single"];
  const [frameId] = useState(opening?.frame?.id ?? crypto.randomUUID());
  const [leafIds, setLeafIds] = useState<Record<string, string>>(() => Object.fromEntries(
    ["single", "active", "inactive"].map((leafRole) => [leafRole, leafOf(opening, leafRole)?.id ?? crypto.randomUUID()]),
  ));
  const [frameMaterial, setFrameMaterial] = useState(opening?.frame?.material ?? "");
  const [frameCondition, setFrameCondition] = useState(opening?.frame?.condition ?? "unverified");
  const [frameWidth, setFrameWidth] = useState<DimensionDraft>(() => dimensionDraft(opening?.frame?.width_in));
  const [frameHeight, setFrameHeight] = useState<DimensionDraft>(() => dimensionDraft(opening?.frame?.height_in));
  const [leafMaterial, setLeafMaterial] = useState<Record<string, string>>(() => Object.fromEntries(roles.map((role) => [role, leafOf(opening, role)?.material ?? ""])));
  const [leafHanding, setLeafHanding] = useState<Record<string, string>>(() => Object.fromEntries(roles.map((role) => [role, leafOf(opening, role)?.handing ?? ""])));
  const [leafCondition, setLeafCondition] = useState<Record<string, string>>(() => Object.fromEntries(roles.map((role) => [role, leafOf(opening, role)?.condition ?? "unverified"])));
  const [leafWidth, setLeafWidth] = useState<Record<string, DimensionDraft>>(() => Object.fromEntries(roles.map((role) => [role, dimensionDraft(leafOf(opening, role)?.width_in)])));
  const [leafHeight, setLeafHeight] = useState<Record<string, DimensionDraft>>(() => Object.fromEntries(roles.map((role) => [role, dimensionDraft(leafOf(opening, role)?.height_in)])));
  const [leafThickness, setLeafThickness] = useState<Record<string, DimensionDraft>>(() => Object.fromEntries(roles.map((role) => [role, dimensionDraft(leafOf(opening, role)?.thickness_in)])));
  const [savedTargets, setSavedTargets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [measurePreview, setMeasurePreview] = useState<string | null>(null);
  const [measureFile, setMeasureFile] = useState<File | null>(null);
  const [drafts, setDrafts] = useState<MeasurementDraft[]>([]);
  const [reading, setReading] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  const [supportCode, setSupportCode] = useState("");
  const [pendingNote, setPendingNote] = useState("");
  const savingLock = useRef(false);

  useEffect(() => {
    if (!savedNotice) return;
    document.getElementById("measurement-saved")?.scrollIntoView?.({ block: "start" });
  }, [savedNotice]);

  const activeIn = parseInches(leafWidth.active?.text ?? "");
  const inactiveIn = parseInches(leafWidth.inactive?.text ?? "");
  const uneven = configuration === "pair" && unevenPair(activeIn, inactiveIn);

  function sizeFields(draft: DimensionDraft, setDraft: (next: DimensionDraft) => void, idPrefix: string, label: string) {
    return <div className="field">
      <label htmlFor={idPrefix}>{label}</label>
      <input id={idPrefix} inputMode="decimal" value={draft.text} placeholder={'3\' 0" or 36'} onChange={(event) => setDraft({ text: event.target.value, clear: false })} />
      <button type="button" className="btn btn-secondary" style={{ marginTop: 6 }} onClick={() => setDraft({ text: "", clear: true })}>Clear {label.toLowerCase()}</button>
      {draft.clear && <p>This measurement will be cleared when you save.</p>}
    </div>;
  }

  function withDimensions(payload: Record<string, unknown>, drafts: Array<[string, DimensionDraft]>) {
    for (const [key, draft] of drafts) {
      const next = dimensionPayload(draft);
      if (next.set) payload[key] = next.value;
    }
    return payload;
  }

  async function saveFrame() {
    setSaving(true);
    setError("");
    setSupportCode("");
    setMessage("Saving frame…");
    try {
      const payload = withDimensions({
        id: frameId,
        expected_revision: opening?.frame?.revision == null ? null : Number(opening.frame.revision),
        material: frameMaterial || undefined,
        condition: frameCondition,
      }, [["width_in", frameWidth], ["height_in", frameHeight]]);
      await queueOpeningMutation("opening_frame", id, payload, undefined, principal);
      await updateCachedOpening(id, (cached) => ({ ...cached, frame: { ...cached.frame, id: frameId, material: frameMaterial || null, condition: frameCondition, width_in: payload.width_in ?? cached.frame?.width_in, height_in: payload.height_in ?? cached.frame?.height_in, pending_sync: true } }));
      setSavedTargets((targets) => [...targets, frameId]);
      setMessage("Frame saved locally. It will synchronize automatically.");
    } catch (caught) {
      setMessage("");
      setError(caught instanceof Error && caught.message === "unreadable_dimension" ? "A frame size could not be read. Use feet and inches, such as 3' 11 1/2\", or a decimal such as 47.5." : "Frame was not saved. Check the connection and try again.");
    } finally { setSaving(false); }
  }

  async function saveLeaf(role: string) {
    setSaving(true);
    setError("");
    setSupportCode("");
    setMessage(`Saving ${role} leaf…`);
    try {
      const payload = withDimensions({
        id: leafIds[role],
        expected_revision: leafOf(opening, role)?.revision == null ? null : Number(leafOf(opening, role).revision),
        leaf_role: role,
        material: leafMaterial[role] || undefined,
        handing: leafHanding[role] || undefined,
        condition: leafCondition[role] || "unverified",
      }, [["width_in", leafWidth[role]], ["height_in", leafHeight[role]], ["thickness_in", leafThickness[role]]]);
      await queueOpeningMutation("door_leaf", id, payload, undefined, principal);
      await updateCachedOpening(id, (cached) => {
        const pending = { id: leafIds[role], leaf_role: role, material: leafMaterial[role] || null, handing: leafHanding[role] || null, condition: leafCondition[role], width_in: payload.width_in ?? leafOf(cached, role)?.width_in, height_in: payload.height_in ?? leafOf(cached, role)?.height_in, thickness_in: payload.thickness_in ?? leafOf(cached, role)?.thickness_in, pending_sync: true };
        const leaves = [...(cached.door_leaves || []).filter((leaf: any) => leaf.leaf_role !== role), pending];
        return { ...cached, door_leaves: leaves };
      });
      setSavedTargets((targets) => [...targets, leafIds[role]]);
      setMessage(`${role[0].toUpperCase()}${role.slice(1)} leaf saved locally. It will synchronize automatically.`);
    } catch (caught) {
      setMessage("");
      setError(caught instanceof Error && caught.message === "unreadable_dimension" ? "A leaf size could not be read. Use feet and inches, such as 3' 0\", or a decimal such as 36." : "Door leaf was not saved. Check the opening configuration and try again.");
    } finally { setSaving(false); }
  }

  function pickMeasurement(file: File) {
    setSupportCode("");
    setMeasureFile(file);
    setMeasurePreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    setDrafts([]);
    setSavedNotice("");
  }

  async function readMeasurement() {
    if (!measureFile) return;
    setError("");
    setSupportCode("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const offline = measurementReadPresentation("measurement_offline");
      setMessage(offline.message);
      setSupportCode(offline.code);
      return;
    }
    setReading(true);
    try {
      const prepared = await prepareMeasurementImage(measureFile);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("measurement_image_unreadable"));
        reader.readAsDataURL(prepared.blob);
      });
      const encoded = dataUrl.split(",")[1] || "";
      if (!encoded) throw new Error("measurement_image_unreadable");
      const result = await readMeasurementPhoto(id, prepared.contentType, encoded);
      setDrafts(draftsFromSuggestions(result.suggestions, configuration, () => crypto.randomUUID()));
      setSavedNotice("");
      if (result.suggestions.length === 0) {
        const empty = measurementReadPresentation("measurement_none_found");
        setMessage(empty.message);
        setSupportCode(empty.code);
      } else {
        setMessage("Suggestions stay on this screen until you save. Nothing was written yet.");
      }
    } catch (caught) {
      const outcome = measurementReadPresentation(measurementErrorCode(caught));
      setMessage("");
      setError(outcome.message);
      setSupportCode(outcome.code);
    } finally { setReading(false); }
  }

  function updateDraft(draftId: string, patch: Partial<MeasurementDraft>) {
    setDrafts((current) => current.map((draft) => draft.id === draftId ? { ...draft, ...patch } : draft));
  }

  function addDraft() {
    const used = new Set(drafts.filter((draft) => draft.included).map((draft) => draft.field));
    const field = measurementTargets(configuration).find((target) => !used.has(target)) ?? "frame_width";
    setDrafts((current) => [...current, { id: crypto.randomUUID(), field, text: "", included: true, readInches: null, confidence: null, bounds: "" }]);
    setMessage("Suggestions stay on this screen until you save. Nothing was written yet.");
  }

  async function saveMeasurements() {
    if (savingLock.current) return;
    const checked = validateMeasurementDrafts(drafts, configuration);
    if (!checked.ok) {
      setMessage("");
      setPendingNote("");
      setError(checked.problems.join(" "));
      return;
    }
    savingLock.current = true;
    setSaving(true);
    setError("");
    setPendingNote("");
    setSupportCode("");
    setMessage("Saving to Door & Frame…");
    const plan = planMeasurementSave(checked.accepted, configuration);
    try {
      for (const group of plan) {
        if (group.kind === "opening_frame") {
          const payload: Record<string, unknown> = {
            id: frameId,
            expected_revision: opening?.frame?.revision == null ? null : Number(opening.frame.revision),
            material: frameMaterial || undefined,
            condition: frameCondition,
          };
          if (group.width_in != null) payload.width_in = group.width_in;
          if (group.height_in != null) payload.height_in = group.height_in;
          await queueOpeningMutation("opening_frame", id, payload, undefined, principal);
          if (group.width_in != null) setFrameWidth(dimensionDraft(group.width_in));
          if (group.height_in != null) setFrameHeight(dimensionDraft(group.height_in));
          await updateCachedOpening(id, (cached) => ({ ...cached, frame: { ...cached.frame, id: frameId, material: frameMaterial || null, condition: frameCondition, width_in: group.width_in ?? cached.frame?.width_in, height_in: group.height_in ?? cached.frame?.height_in, pending_sync: true } }));
        } else {
          const role = group.role || "single";
          const payload: Record<string, unknown> = {
            id: leafIds[role],
            expected_revision: leafOf(opening, role)?.revision == null ? null : Number(leafOf(opening, role).revision),
            leaf_role: role,
            material: leafMaterial[role] || undefined,
            handing: leafHanding[role] || undefined,
            condition: leafCondition[role] || "unverified",
          };
          if (group.width_in != null) payload.width_in = group.width_in;
          if (group.height_in != null) payload.height_in = group.height_in;
          await queueOpeningMutation("door_leaf", id, payload, undefined, principal);
          if (group.width_in != null) setLeafWidth((current) => ({ ...current, [role]: dimensionDraft(group.width_in) }));
          if (group.height_in != null) setLeafHeight((current) => ({ ...current, [role]: dimensionDraft(group.height_in) }));
          await updateCachedOpening(id, (cached) => {
            const pending = { id: leafIds[role], leaf_role: role, material: leafMaterial[role] || null, handing: leafHanding[role] || null, condition: leafCondition[role], width_in: group.width_in ?? leafOf(cached, role)?.width_in, height_in: group.height_in ?? leafOf(cached, role)?.height_in, thickness_in: leafOf(cached, role)?.thickness_in, pending_sync: true };
            return { ...cached, door_leaves: [...(cached.door_leaves || []).filter((leaf: any) => leaf.leaf_role !== role), pending] };
          });
        }
      }
      const waiting = typeof navigator !== "undefined" && navigator.onLine === false;
      setDrafts([]);
      setMessage("");
      setSavedNotice(measurementSavedSummary(checked.accepted, configuration, waiting));
    } catch (caught) {
      setMessage("");
      if (caught instanceof Error && caught.message === "structure_sync_pending_review") {
        setError("");
        setPendingNote("These sizes are already waiting to synchronize. They were not written again.");
      } else {
        setError(caught instanceof Error && caught.message === "unreadable_dimension"
          ? "A size could not be read. Use feet and inches, such as 3' 11\", or a number of inches."
          : "Door & Frame was not saved. Check the connection and try again.");
      }
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }

  async function changeConfiguration(next: "single" | "pair") {
    if (next === configuration) return;
    setError("");
    setSupportCode("");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setMessage("Changing single or pair needs a connection. Sizes and materials can still be saved on this phone.");
      return;
    }
    setSaving(true);
    try {
      const converted = await setOpeningConfiguration(id, next);
      const leaves = converted.door_leaves ?? [];
      setLeafIds((current) => {
        const ids = { ...current };
        for (const leaf of leaves) ids[leaf.leaf_role] = leaf.id;
        return ids;
      });
      onOpening({ ...opening, ...converted.opening, door_leaves: leaves, frame: opening.frame });
      setMessage(next === "pair" ? "This opening is now a pair. The existing leaf kept its id." : "This opening is now a single door. Leaf ids were kept.");
    } catch {
      setMessage("");
      setError("The opening configuration was not changed. No leaf was removed.");
    } finally { setSaving(false); }
  }

  return <div className="app-shell c04">
    <div className="top-bar"><button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button></div>
    <div className="screen">
      <h2>Door &amp; Frame</h2>
      {savedNotice && <p className="c04-band-green" role="status">{savedNotice}</p>}
      <p style={{ color: "#142C3C" }}>{configuration === "pair" ? "One frame with active and inactive door leaves." : "One frame with one door leaf."}</p>
      <div className="c04-band-blue">
        <div className="field">
          <label htmlFor="opening-configuration">Opening</label>
          <select id="opening-configuration" value={configuration} onChange={(event) => { void changeConfiguration(event.target.value as "single" | "pair"); }}>
            <option value="single">Single</option>
            <option value="pair">Pair</option>
          </select>
        </div>
        {uneven && <p><strong>Uneven pair</strong></p>}
      </div>
      <div className="c04-band">
        <div className="section-label">Frame</div>
        <div className="field"><label htmlFor="frame-material">Material</label><input id="frame-material" value={frameMaterial} onChange={(event) => setFrameMaterial(event.target.value)} /></div>
        <div className="field"><label htmlFor="frame-condition">Frame condition</label><select id="frame-condition" value={frameCondition} onChange={(event) => setFrameCondition(event.target.value)}>{["unverified", "good", "worn", "failed"].map((condition) => <option key={condition} value={condition}>{condition}</option>)}</select></div>
        {sizeFields(frameWidth, setFrameWidth, "frame-width", "Frame width")}
        {sizeFields(frameHeight, setFrameHeight, "frame-height", "Frame height")}
        <button className="btn btn-secondary" onClick={() => { void saveFrame(); }} disabled={saving || savedTargets.includes(frameId)}>Save frame</button>
        <div style={{ marginTop: 10 }}><PhotoCapture openingId={id} relatedEntityType="frame" relatedEntityId={frameId} onQueued={() => setMessage("Frame photograph saved locally.")} /></div>
      </div>
      {roles.map((role) => <div className="c04-band-green" key={role}>
        <div className="section-label">{role === "single" ? "Door leaf" : `${role[0].toUpperCase()}${role.slice(1)} leaf`}</div>
        <div className="field"><label htmlFor={`${role}-material`}>Material</label><input id={`${role}-material`} value={leafMaterial[role] ?? ""} onChange={(event) => setLeafMaterial((current) => ({ ...current, [role]: event.target.value }))} /></div>
        <div className="field"><label htmlFor={`${role}-handing`}>Handing</label><input id={`${role}-handing`} value={leafHanding[role] ?? ""} onChange={(event) => setLeafHanding((current) => ({ ...current, [role]: event.target.value }))} /></div>
        <div className="field"><label htmlFor={`${role}-condition`}>Leaf condition</label><select id={`${role}-condition`} value={leafCondition[role] ?? "unverified"} onChange={(event) => setLeafCondition((current) => ({ ...current, [role]: event.target.value }))}>{["unverified", "good", "worn", "failed"].map((condition) => <option key={condition} value={condition}>{condition}</option>)}</select></div>
        {sizeFields(leafWidth[role] ?? dimensionDraft(null), (next) => setLeafWidth((current) => ({ ...current, [role]: next })), `${role}-width`, "Leaf width")}
        {sizeFields(leafHeight[role] ?? dimensionDraft(null), (next) => setLeafHeight((current) => ({ ...current, [role]: next })), `${role}-height`, "Leaf height")}
        {sizeFields(leafThickness[role] ?? dimensionDraft(null), (next) => setLeafThickness((current) => ({ ...current, [role]: next })), `${role}-thickness`, "Leaf thickness")}
        <button className="btn btn-secondary" onClick={() => { void saveLeaf(role); }} disabled={saving || savedTargets.includes(leafIds[role])}>Save {role} leaf</button>
        <div style={{ marginTop: 10 }}><PhotoCapture openingId={id} relatedEntityType="door_leaf" relatedEntityId={leafIds[role]} onQueued={() => setMessage(`${role} leaf photograph saved locally.`)} /></div>
      </div>)}
      <div className="c04-band-blue">
        <div className="section-label">Measurement photo</div>
        <p>Choose a saved Apple Measure screenshot, or take a photo. Saving the photo works offline. Reading it needs a connection. Nothing is written until you save.</p>
        <p>On a pair, a line across both doors is the whole opening. Put that width on the frame, or on the leaves, then save.</p>
        {measurePreview && <img src={measurePreview} alt="Measurement photo" style={{ width: "100%", maxHeight: 220, objectFit: "contain", background: "#fff", borderRadius: 8 }} />}
        <PhotoCapture openingId={id} relatedEntityType="opening" relatedEntityId={id} sources="saved-or-camera" onQueued={() => { setSupportCode(""); setMessage("Measurement photo saved locally."); }} onPicked={pickMeasurement} />
        <button type="button" className="btn btn-secondary" disabled={!measureFile || reading || saving} onClick={() => { void readMeasurement(); }}>{reading ? "Reading…" : "Read measurements"}</button>
        {savedNotice && <p id="measurement-saved" className="c04-band-green" role="status">{savedNotice}</p>}
        {pendingNote && <p role="status">{pendingNote}</p>}
        {drafts.map((draft) => {
          const inches = parseEditedInches(draft.text);
          return <div key={draft.id} style={{ marginTop: 12, background: "#fff", borderRadius: 8, padding: 10 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#142C3C" }}>
              <input type="checkbox" checked={draft.included} aria-label={`Include ${targetLabel(draft.field, configuration)}`} onChange={(event) => updateDraft(draft.id, { included: event.target.checked })} />
              Include
            </label>
            <div className="field">
              <label htmlFor={`measure-target-${draft.id}`}>Save to</label>
              <select id={`measure-target-${draft.id}`} value={draft.field} onChange={(event) => updateDraft(draft.id, { field: event.target.value as MeasurementDraft["field"] })}>
                {measurementTargets(configuration).map((target) => <option key={target} value={target}>{targetLabel(target, configuration)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`measure-value-${draft.id}`}>Size</label>
              <input id={`measure-value-${draft.id}`} inputMode="decimal" value={draft.text} placeholder={'3\' 11" or 47'} onChange={(event) => updateDraft(draft.id, { text: event.target.value })} />
              <p>{inches == null ? "Use feet and inches, such as 3' 11\", 8', 47, or 47in." : `${inches} in`}</p>
            </div>
            {draft.confidence != null && <p>confidence {Math.round(draft.confidence * 100)}%</p>}
            {draft.bounds && <p>{draft.bounds}</p>}
            <button type="button" className="btn btn-secondary" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}>Remove</button>
          </div>;
        })}
        <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={addDraft}>Add a size</button>
        {drafts.length > 0 && <button type="button" className="btn c04-btn-green" style={{ marginTop: 8 }} disabled={saving} onClick={() => { void saveMeasurements(); }}>{saving ? "Saving…" : "Save to Door & Frame"}</button>}
      </div>
      {error && <p className="c04-step-alert" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {supportCode && <p style={{ fontSize: 12 }}>Support code: {supportCode}</p>}
    </div>
  </div>;
}
