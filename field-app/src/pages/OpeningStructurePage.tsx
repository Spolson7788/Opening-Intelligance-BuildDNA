import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { queueOpeningMutation } from "../lib/sync";
import { updateCachedOpening } from "../lib/db";
import { PhotoCapture } from "../components/PhotoCapture";

export function OpeningStructurePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const opening = (location.state as any)?.opening;
  const configuration = opening?.opening_configuration ?? "single";
  const roles = configuration === "pair" ? ["active", "inactive"] : ["single"];
  const [frameMaterial, setFrameMaterial] = useState(opening?.frame?.material ?? "");
  const [leafMaterial, setLeafMaterial] = useState("");
  const [handing, setHanding] = useState("");
  const [role, setRole] = useState(roles[0]);
  const [message, setMessage] = useState("");

  async function saveFrame() {
    setMessage("Saving frame…");
    try {
      await queueOpeningMutation("opening_frame", id!, { material: frameMaterial || undefined, condition: "unverified" });
      await updateCachedOpening(id!, (cached) => ({ ...cached, frame: { ...cached.frame, material: frameMaterial || null, condition: "unverified", pending_sync: true } }));
      setMessage("Frame saved locally. It will synchronize automatically.");
    } catch {
      setMessage("Frame was not saved. Check the connection and try again.");
    }
  }

  async function saveLeaf() {
    setMessage(`Saving ${role} leaf…`);
    try {
      await queueOpeningMutation("door_leaf", id!, {
        leaf_role: role,
        material: leafMaterial || undefined,
        handing: handing || undefined,
        condition: "unverified",
      });
      await updateCachedOpening(id!, (cached) => {
        const pending = { id: `local-${role}`, leaf_role: role, material: leafMaterial || null, handing: handing || null, condition: "unverified", pending_sync: true };
        const leaves = [...(cached.door_leaves || []).filter((leaf: any) => leaf.leaf_role !== role), pending];
        return { ...cached, door_leaves: leaves };
      });
      setMessage(`${role[0].toUpperCase()}${role.slice(1)} leaf saved locally. It will synchronize automatically.`);
    } catch {
      setMessage("Door leaf was not saved. Check the opening configuration and try again.");
    }
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
        <button className="btn btn-secondary" onClick={saveFrame}>Save frame</button>
        {opening?.frame?.id && <div style={{ marginTop: 10 }}><PhotoCapture openingId={id!} relatedEntityType="frame" relatedEntityId={opening.frame.id} onQueued={() => setMessage("Frame photograph saved locally.")} /></div>}
      </div>
      <div className="card">
        <div className="section-label">Door leaf</div>
        {configuration === "pair" && <div className="field"><label htmlFor="leaf-role">Leaf</label><select id="leaf-role" value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>}
        <div className="field"><label htmlFor="leaf-material">Material</label><input id="leaf-material" value={leafMaterial} onChange={(e) => setLeafMaterial(e.target.value)} /></div>
        <div className="field"><label htmlFor="handing">Handing</label><input id="handing" value={handing} onChange={(e) => setHanding(e.target.value)} /></div>
        <button className="btn btn-secondary" onClick={saveLeaf}>Save {role} leaf</button>
        {opening?.door_leaves?.filter((leaf: any) => leaf.leaf_role === role).map((leaf: any) => (
          <div key={leaf.id} style={{ marginTop: 10 }}><PhotoCapture openingId={id!} relatedEntityType="door_leaf" relatedEntityId={leaf.id} onQueued={() => setMessage(`${role} leaf photograph saved locally.`)} /></div>
        ))}
      </div>
      {message && <p>{message}</p>}
    </div>
  </div>;
}
