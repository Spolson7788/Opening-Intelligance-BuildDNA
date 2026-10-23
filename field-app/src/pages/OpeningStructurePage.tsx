import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { queueOpeningMutation } from "../lib/sync";
import { updateCachedOpening } from "../lib/db";
import { PhotoCapture } from "../components/PhotoCapture";
import { useAuth } from '../lib/AuthContext';

export function OpeningStructurePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {auth}=useAuth();
  const [principal]=useState(()=>auth!);
  const opening = (location.state as any)?.opening;
  const configuration = opening?.opening_configuration ?? "single";
  const roles = configuration === "pair" ? ["active", "inactive"] : ["single"];
  const [frameId] = useState(opening?.frame?.id ?? crypto.randomUUID());
  const [leafIds] = useState<Record<string, string>>(() => Object.fromEntries(
    roles.map((leafRole) => [leafRole, opening?.door_leaves?.find((leaf: any) => leaf.leaf_role === leafRole)?.id ?? crypto.randomUUID()])
  ));
  const [frameMaterial, setFrameMaterial] = useState(opening?.frame?.material ?? "");
  const [frameCondition, setFrameCondition] = useState(opening?.frame?.condition ?? "unverified");
  const [leafCondition, setLeafCondition] = useState(opening?.door_leaves?.find((l:any)=>l.leaf_role===roles[0])?.condition ?? "unverified");
  const [leafMaterial, setLeafMaterial] = useState(opening?.door_leaves?.find((l:any)=>l.leaf_role===roles[0])?.material ?? "");
  const [handing, setHanding] = useState(opening?.door_leaves?.find((l:any)=>l.leaf_role===roles[0])?.handing ?? "");
  const [role, setRole] = useState(roles[0]);
  const [savedTargets, setSavedTargets] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function saveFrame() {
    setSaving(true);
    setMessage("Saving frame…");
    try {
      await queueOpeningMutation("opening_frame", id!, { id: frameId, expected_revision: opening?.frame?.revision == null ? null : Number(opening.frame.revision), material: frameMaterial || undefined, condition: frameCondition }, undefined, principal);
      await updateCachedOpening(id!, (cached) => ({ ...cached, frame: { ...cached.frame, id: frameId, material: frameMaterial || null, condition: frameCondition, pending_sync: true } }));
      setSavedTargets(targets => [...targets, frameId]);
      setMessage("Frame saved locally. It will synchronize automatically.");
    } catch {
      setMessage("Frame was not saved. Check the connection and try again.");
    } finally { setSaving(false); }
  }

  async function saveLeaf() {
    setSaving(true);
    setMessage(`Saving ${role} leaf…`);
    try {
      await queueOpeningMutation("door_leaf", id!, {
        id: leafIds[role],
        expected_revision: opening?.door_leaves?.find((leaf: any) => leaf.id === leafIds[role])?.revision == null ? null : Number(opening.door_leaves.find((leaf: any) => leaf.id === leafIds[role]).revision),
        leaf_role: role,
        material: leafMaterial || undefined,
        handing: handing || undefined,
        condition: leafCondition,
      }, undefined, principal);
      await updateCachedOpening(id!, (cached) => {
        const pending = { id: leafIds[role], leaf_role: role, material: leafMaterial || null, handing: handing || null, condition: leafCondition, pending_sync: true };
        const leaves = [...(cached.door_leaves || []).filter((leaf: any) => leaf.leaf_role !== role), pending];
        return { ...cached, door_leaves: leaves };
      });
      setSavedTargets(targets => [...targets, leafIds[role]]);
      setMessage(`${role[0].toUpperCase()}${role.slice(1)} leaf saved locally. It will synchronize automatically.`);
    } catch {
      setMessage("Door leaf was not saved. Check the opening configuration and try again.");
    } finally { setSaving(false); }
  }

  return <div className="app-shell">
    <div className="top-bar"><button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button></div>
    <div className="screen">
      <h2>Door &amp; Frame</h2>
      <p style={{ color: "var(--text-secondary)" }}>
        {configuration === "pair" ? "One frame with active and inactive door leaves." : "One frame with one door leaf."}
      </p>
      <div className="card">
        <div className="section-label">Frame</div>
        <div className="field"><label htmlFor="frame-material">Material</label><input id="frame-material" value={frameMaterial} onChange={(e) => setFrameMaterial(e.target.value)} /></div>
        <div className="field"><label htmlFor="frame-condition">Frame condition</label><select id="frame-condition" value={frameCondition} onChange={e=>setFrameCondition(e.target.value)}>{["unverified","good","worn","failed"].map(c=><option key={c} value={c}>{c}</option>)}</select></div>
        <button className="btn btn-secondary" onClick={saveFrame} disabled={saving || savedTargets.includes(frameId)}>Save frame</button>
        <div style={{ marginTop: 10 }}><PhotoCapture openingId={id!} relatedEntityType="frame" relatedEntityId={frameId} onQueued={() => setMessage("Frame photograph saved locally.")} /></div>
      </div>
      <div className="card">
        <div className="section-label">Door leaf</div>
        {configuration === "pair" && <div className="field"><label htmlFor="leaf-role">Leaf</label><select id="leaf-role" value={role} onChange={(e) => { const next=e.target.value; setRole(next); const leaf=opening?.door_leaves?.find((l:any)=>l.leaf_role===next); setLeafMaterial(leaf?.material??""); setHanding(leaf?.handing??""); setLeafCondition(leaf?.condition??"unverified"); }}>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>}
        <div className="field"><label htmlFor="leaf-material">Material</label><input id="leaf-material" value={leafMaterial} onChange={(e) => setLeafMaterial(e.target.value)} /></div>
        <div className="field"><label htmlFor="handing">Handing</label><input id="handing" value={handing} onChange={(e) => setHanding(e.target.value)} /></div>
        <div className="field"><label htmlFor="leaf-condition">Leaf condition</label><select id="leaf-condition" value={leafCondition} onChange={e=>setLeafCondition(e.target.value)}>{["unverified","good","worn","failed"].map(c=><option key={c} value={c}>{c}</option>)}</select></div>
        <button className="btn btn-secondary" onClick={saveLeaf} disabled={saving || savedTargets.includes(leafIds[role])}>Save {role} leaf</button>
        <div style={{ marginTop: 10 }}><PhotoCapture openingId={id!} relatedEntityType="door_leaf" relatedEntityId={leafIds[role]} onQueued={() => setMessage(`${role} leaf photograph saved locally.`)} /></div>
      </div>
      {message && <p>{message}</p>}
      {savedTargets.length > 0 && <p>Return to the opening and refresh saved records before editing these targets again.</p>}
    </div>
  </div>;
}
