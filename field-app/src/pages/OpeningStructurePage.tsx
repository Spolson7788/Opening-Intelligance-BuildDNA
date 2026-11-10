import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchOpening, setOpeningConfiguration } from "../lib/api";
import { queueOpeningMutation } from "../lib/sync";
import { updateCachedOpening } from "../lib/db";
import { PhotoCapture } from "../components/PhotoCapture";
import { useAuth } from "../lib/AuthContext";
import { dimensionDraft, dimensionPayload, parseInches, unevenPair } from "../lib/inchMeasure";
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

  async function changeConfiguration(next: "single" | "pair") {
    if (next === configuration) return;
    setError("");
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
      {error && <p className="c04-step-alert" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {savedTargets.length > 0 && <p>Return to the opening and refresh saved records before editing these targets again.</p>}
    </div>
  </div>;
}
