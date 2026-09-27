import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { fetchOpening, fetchPurchasingEligibility, fetchDocumentsForOpening, uploadDocumentForOpening, deleteDocument, fetchPhotoAccessUrl } from "../lib/api";
import type { OpeningDetail, DocumentEntry, PurchasingEligibility, HardwareComponent, OpeningPhoto } from "../lib/api";
import { Sidebar } from "../components/Sidebar";
import { HealthPill } from "../components/HealthPill";
import { carrierTrackingUrl, SHIPMENT_STATUS_LABELS } from "../lib/tracking";

function hardwarePlacement(component: HardwareComponent, opening: OpeningDetail) {
  if (component.mounting_scope === "frame") return "Frame";
  if (component.mounting_scope === "door_leaf") {
    const leaf = opening.door_leaves.find((item) => item.id === component.door_leaf_id);
    return `${leaf ? `${leaf.leaf_role} leaf` : "Door leaf"}${component.position_label ? ` · ${component.position_label}` : ""}`;
  }
  return `Opening${component.position_label ? ` · ${component.position_label}` : ""}`;
}

function photoScopeLabel(photo: OpeningPhoto, opening: OpeningDetail) {
  if (photo.hardware_component_id) {
    const component = opening.hardware_components.find((item) => item.id === photo.hardware_component_id);
    return component ? `Component · ${component.component_type.replace(/_/g, " ")}` : "Component";
  }
  if (photo.door_leaf_id) {
    const leaf = opening.door_leaves.find((item) => item.id === photo.door_leaf_id);
    return leaf ? `${leaf.leaf_role} leaf` : "Door leaf";
  }
  if (photo.frame_id) return "Frame";
  return "Opening";
}

function PrivateMedia({ photo }: { photo: OpeningPhoto }) {
  const [url, setUrl] = useState<string | null>(photo.storage_url.startsWith("private:") ? null : photo.storage_url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    if (!photo.storage_url.startsWith("private:")) {
      setUrl(photo.storage_url);
      return () => { active = false; };
    }
    setUrl(null);
    fetchPhotoAccessUrl(photo.id)
      .then(({ url }) => { if (active) setUrl(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [photo.id, photo.storage_url]);

  if (failed) return <div role="status" style={{ color: "var(--danger)", fontSize: 12 }}>Photo unavailable</div>;
  if (!url) return <div style={{ aspectRatio: "1", display: "grid", placeItems: "center", fontSize: 12 }}>Loading…</div>;
  if (photo.media_type === "video") {
    return <video src={url} controls style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />;
  }
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Opening photo" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} /></a>;
}

function formatReason(reason: string) {
  return reason.replace(/_/g, " ");
}

export function OpeningDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<OpeningDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState<PurchasingEligibility | null>(null);

  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadType, setUploadType] = useState("warranty");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  function loadDocuments() {
    fetchDocumentsForOpening(id!).then(setDocuments).catch(() => {
      // Non-fatal — the rest of the opening page still works without documents loading.
    });
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchOpening(id!), fetchPurchasingEligibility(id!)])
      .then(([openingResult, purchasingResult]) => {
        setOpening(openingResult);
        setPurchasing(purchasingResult);
      })
      .catch(() => setError("Couldn't load this opening."))
      .finally(() => setLoading(false));
    loadDocuments();
  }, [id]);

  async function onUploadDocument(e: FormEvent) {
    e.preventDefault();
    if (!uploadFile) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadDocumentForOpening(id!, uploadFile, uploadType, uploadTitle);
      setUploadFile(null);
      setUploadTitle("");
      setUploadType("warranty");
      setShowUploadForm(false);
      loadDocuments();
    } catch {
      setUploadError("Couldn't upload the document. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteDocument(docId: string) {
    try {
      await deleteDocument(docId);
      loadDocuments();
    } catch {
      setUploadError("Couldn't delete that document. Check your connection and try again.");
    }
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main">
        <button
          onClick={() => navigate("/")}
          style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 13, padding: 0, marginBottom: 16 }}
        >
          ← Back to Portfolio
        </button>

        {loading ? (
          <p style={{ color: "var(--text-secondary)" }}>Loading…</p>
        ) : error || !opening ? (
          <div className="empty-state">{error}</div>
        ) : (
          <>
            <div className="page-header">
              <div>
                <span className="asset-plate" style={{ marginBottom: 8, display: "inline-flex" }}>{opening.opening_code}</span>
                <h1 style={{ marginTop: 8 }}>{opening.location_description || opening.opening_type.replace(/_/g, " ")}</h1>
                <p style={{ textTransform: "capitalize" }}>
                  {opening.opening_type.replace(/_/g, " ")} · Floor {opening.floor_label || "—"}
                  {opening.fire_rated && <span className="badge-fire" style={{ marginLeft: 8 }}>FIRE RATED</span>}
                </p>
              </div>
              <HealthPill score={opening.health_score} />
            </div>

            <div className="panel">
              <h2>Opening Summary</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(120px, 1fr))", gap: 12 }}>
                <div><strong>Configuration</strong><div style={{ textTransform: "capitalize" }}>{opening.opening_configuration}</div></div>
                <div><strong>Completion</strong><div style={{ textTransform: "capitalize" }}>{opening.completion_state}</div></div>
                <div><strong>Door leaves</strong><div>{opening.door_leaves.length}</div></div>
                <div><strong>Components</strong><div>{opening.hardware_components.length}</div></div>
                <div><strong>Eligible replacements</strong><div>{purchasing?.decisions.filter((d) => d.eligible).length ?? "—"}</div></div>
              </div>
            </div>

            <div className="panel">
              <h2>Door and Frame</h2>
              {!opening.frame ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No frame record has synchronized for this opening.</p>
              ) : (
                <p><strong>Frame:</strong> {opening.frame.material || "Material not recorded"} · {opening.frame.frame_type || "Type not recorded"} · condition {opening.frame.condition}</p>
              )}
              {opening.door_leaves.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No door-leaf records have synchronized for this opening.</p>
              ) : (
                <table>
                  <thead><tr><th>Leaf</th><th>Handing</th><th>Material</th><th>Size</th><th>Condition</th></tr></thead>
                  <tbody>
                    {opening.door_leaves.map((leaf) => (
                      <tr key={leaf.id}>
                        <td style={{ textTransform: "capitalize" }}>{leaf.leaf_role}</td>
                        <td>{leaf.handing || "—"}</td>
                        <td>{leaf.material || "—"}</td>
                        <td>{leaf.width_in && leaf.height_in ? `${leaf.width_in} × ${leaf.height_in} in` : "—"}</td>
                        <td style={{ textTransform: "capitalize" }}>{leaf.condition}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {opening.photos.length > 0 && (
              <div className="panel">
                <h2>Photos &amp; Videos</h2>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8 }}>
                  {opening.photos.map((p) =>
                    <div key={p.id}>
                      <PrivateMedia photo={p} />
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{photoScopeLabel(p, opening)}</div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="panel">
              <h2>Hardware</h2>
              {opening.hardware_components.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No hardware recorded yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Tracker</th>
                      <th>Component</th>
                      <th>Placement</th>
                      <th>Condition</th>
                      <th>Purchasing</th>
                      <th>Manufacturer</th>
                      <th>Model</th>
                      <th>Install Date</th>
                      <th>Cost</th>
                      <th>Supplier</th>
                      <th>Shipment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opening.hardware_components.map((hw) => {
                      const trackingUrl = carrierTrackingUrl(hw.carrier, hw.tracking_number);
                      const decision = purchasing?.decisions.find((d) => d.component_id === hw.id);
                      return (
                        <tr key={hw.id}>
                          <td>
                            {hw.tracker_id && <span className="asset-plate">{hw.tracker_id}</span>}
                            {hw.serial_number && (
                              <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>SN: {hw.serial_number}</div>
                            )}
                          </td>
                          <td style={{ textTransform: "capitalize" }}>{hw.component_type.replace(/_/g, " ")}</td>
                          <td>{hardwarePlacement(hw, opening)}</td>
                          <td style={{ textTransform: "capitalize" }}>{hw.condition} · {hw.review_state}</td>
                          <td>{decision?.eligible ? "Eligible" : decision ? decision.reasons.map(formatReason).join("; ") : "—"}</td>
                          <td>{hw.manufacturer || "—"}</td>
                          <td>{hw.model_number || "—"}</td>
                          <td>{hw.install_date ? new Date(hw.install_date).toLocaleDateString() : "—"}</td>
                          <td>{hw.unit_cost ? `$${Number(hw.unit_cost).toFixed(2)}` : "—"}</td>
                          <td>
                            {hw.supplier_name || "—"}
                            {hw.supplier_contact && (
                              <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>{hw.supplier_contact}</div>
                            )}
                          </td>
                          <td>
                            {hw.shipment_status && hw.shipment_status !== "not_shipped" ? (
                              <>
                                <span className="badge">{SHIPMENT_STATUS_LABELS[hw.shipment_status] || hw.shipment_status}</span>
                                {trackingUrl && (
                                  <div style={{ marginTop: 4 }}>
                                    <a href={trackingUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>Track ↗</a>
                                  </div>
                                )}
                              </>
                            ) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <h2>Service History</h2>
              {opening.service_events.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No service events recorded yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>Date</th><th>Work Performed</th><th>Cost</th></tr>
                  </thead>
                  <tbody>
                    {opening.service_events.map((ev: any) => (
                      <tr key={ev.id}>
                        <td>{new Date(ev.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</td>
                        <td>{ev.work_performed}</td>
                        <td>{ev.cost ? `$${ev.cost}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <h2>Inspection History</h2>
              {opening.inspection_events.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No inspections recorded yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>Date</th><th>Type</th><th>Result</th><th>Notes</th><th>Signed By</th></tr>
                  </thead>
                  <tbody>
                    {opening.inspection_events.map((ev: any) => (
                      <tr key={ev.id}>
                        <td>{new Date(ev.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</td>
                        <td style={{ textTransform: "capitalize" }}>{ev.inspection_type.replace(/_/g, " ")}</td>
                        <td>
                          <span className={`health-pill ${ev.passed ? "health-good" : "health-poor"}`}>
                            {ev.passed ? "Passed" : "Failed"}
                          </span>
                        </td>
                        <td>{ev.notes || "—"}</td>
                        <td>
                          {ev.signed_by_name ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 12.5 }}>{ev.signed_by_name}</span>
                              {ev.signature_data && (
                                <img
                                  src={ev.signature_data}
                                  alt={`${ev.signed_by_name}'s signature`}
                                  style={{ height: 24, background: "#fff", border: "1px solid var(--border)", borderRadius: 4, padding: 2 }}
                                />
                              )}
                            </div>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <h2 style={{ margin: 0 }}>Documents</h2>
                <button className="btn btn-secondary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setShowUploadForm((v) => !v)}>
                  {showUploadForm ? "Cancel" : "+ Upload Document"}
                </button>
              </div>

              {showUploadForm && (
                <form onSubmit={onUploadDocument} style={{ marginTop: 12, marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid var(--border)" }}>
                  <div className="field">
                    <label htmlFor="doc-title">Title</label>
                    <input id="doc-title" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="e.g. Schlage Lockset Warranty" required />
                  </div>
                  <div className="field">
                    <label htmlFor="doc-type">Type</label>
                    <select id="doc-type" value={uploadType} onChange={(e) => setUploadType(e.target.value)}>
                      <option value="warranty">Warranty</option>
                      <option value="service_contract">Service Contract</option>
                      <option value="insurance">Insurance</option>
                      <option value="inspection_report">Inspection Report</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="doc-file">File (PDF or Word doc)</label>
                    <input
                      id="doc-file"
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                      required
                    />
                  </div>
                  {uploadError && <p className="error-text">{uploadError}</p>}
                  <button type="submit" className="btn btn-primary" disabled={uploading || !uploadFile}>
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                </form>
              )}

              {documents.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No documents uploaded yet.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>Title</th><th>Type</th><th>Uploaded</th><th></th></tr>
                  </thead>
                  <tbody>
                    {documents.map((d) => (
                      <tr key={d.id}>
                        <td><a href={d.storage_url} target="_blank" rel="noreferrer">{d.title}</a></td>
                        <td style={{ textTransform: "capitalize" }}>{d.document_type.replace(/_/g, " ")}</td>
                        <td>{new Date(d.created_at).toLocaleDateString()}</td>
                        <td>
                          <button
                            className="btn btn-secondary"
                            style={{ width: "auto", padding: "0 10px", height: 28, fontSize: 12 }}
                            onClick={() => onDeleteDocument(d.id)}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
