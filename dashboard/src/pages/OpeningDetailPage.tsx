import { useEffect, useState } from "react";
import { formatSize, unevenPair } from "../lib/inchMeasure";
import type { FormEvent } from "react";
import { useParams, useNavigate, useLocation, Link } from "react-router-dom";
import { fetchOpening, fetchPurchasingEligibility, fetchDocumentsForOpening, uploadDocumentForOpening, deleteDocument, fetchPhotoAccessUrl, fetchAuthedBlob, emailInspectionReport, inspectionReportRecipients, saveInspectionToFacilityRecords, downloadAuthedFile } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import type { OpeningDetail, DocumentEntry, PurchasingEligibility, HardwareComponent, OpeningPhoto } from "../lib/api";
import { Sidebar } from "../components/Sidebar";
import { useLocations } from "../lib/LocationContext";
import { HealthPill } from "../components/HealthPill";
import { carrierTrackingUrl, SHIPMENT_STATUS_LABELS } from "../lib/tracking";
import { linkedInspectionId } from "../lib/inspectionLink";
import { componentLabel, splitServiceHistory } from "../lib/serviceHistory";
import type { ServiceEventRow } from "../lib/serviceHistory";

function ServiceTable({ events }: { events: ServiceEventRow[] }) {
  return (
    <div className="table-scroll"><table>
      <thead>
        <tr><th>Date</th><th>Work Performed</th><th>Cost</th></tr>
      </thead>
      <tbody>
        {events.map((ev) => (
          <tr key={ev.id} data-service-event={ev.id}>
            <td>{new Date(ev.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</td>
            <td>{ev.work_performed}</td>
            <td>{ev.cost ? `$${ev.cost}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

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
  if (photo.related_entity_type === "inspection_event") return "Inspection failure";
  return "Opening";
}

function PrivateMedia({ photo }: { photo: OpeningPhoto }) {
  const inline = photo.storage_url.startsWith("inline:");
  const stored = photo.storage_url.startsWith("private:");
  const [url, setUrl] = useState<string | null>(inline || stored ? null : photo.storage_url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setFailed(false);
    if (inline) {
      setUrl(null);
      fetchAuthedBlob(`/photos/${photo.id}/content`)
        .then((blob) => {
          objectUrl = URL.createObjectURL(blob);
          if (active) setUrl(objectUrl);
        })
        .catch(() => { if (active) setFailed(true); });
      return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }
    if (!stored) {
      setUrl(photo.storage_url);
      return () => { active = false; };
    }
    setUrl(null);
    fetchPhotoAccessUrl(photo.id)
      .then(({ url }) => { if (active) setUrl(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [photo.id, photo.storage_url, inline, stored]);

  if (failed) return <div role="status" style={{ color: "var(--danger)", fontSize: 12 }}>Photo unavailable</div>;
  if (!url) return <div style={{ aspectRatio: "1", display: "grid", placeItems: "center", fontSize: 12 }}>Loading…</div>;
  if (photo.media_type === "video") {
    return <video src={url} controls style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />;
  }
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={inline ? "Inspection failure photo" : "Opening photo"} onError={() => setFailed(true)} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", background: "#fff" }} /></a>;
}

function formatReason(reason: string) {
  return reason.replace(/_/g, " ");
}

export function OpeningDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const linkedInspection = linkedInspectionId(location.hash);
  const loc = useLocations();
  const { auth } = useAuth();
  const canSaveRecords = auth?.role === "admin" || auth?.role === "facilities_manager";
  const [opening, setOpening] = useState<OpeningDetail | null>(null);
  const [reportTo, setReportTo] = useState("");
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [recordMessage, setRecordMessage] = useState<Record<string, string>>({});
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

  useEffect(() => {
    if (!opening || !linkedInspection) return;
    document.getElementById(`inspection-${linkedInspection}`)?.scrollIntoView({ block: "start" });
  }, [opening, linkedInspection]);

  function loadDocuments() {
    fetchDocumentsForOpening(id!).then(setDocuments).catch(() => {
      // Non-fatal — the rest of the opening page still works without documents loading.
    });
  }

  function saveReport(inspectionId: string) {
    saveInspectionToFacilityRecords(inspectionId).then((result) => {
      setRecordMessage((current) => ({ ...current, [inspectionId]: result.already_saved ? "Already in facility records." : "Saved to facility records." }));
      loadDocuments();
    }).catch(() => {
      setRecordMessage((current) => ({ ...current, [inspectionId]: "Could not save the report." }));
    });
  }

  useEffect(() => {
    const inspection = opening?.inspection_events?.find((ev: any) => ev.inspection_type === "fire_door_nfpa80" && ev.checklist_result?.status === "complete");
    if (!inspection) return;
    inspectionReportRecipients(inspection.id).then((row) => setReportTo(row.to.join(", "))).catch(() => {});
  }, [opening?.id, opening?.inspection_events?.length]);

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
                <div className="location-tag" style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                  Location: {loc.label(opening)}
                  {loc.writeState(opening) === "view_only" && " · view only"}
                  {loc.writeState(opening) === "switch_to_edit" && " · switch to this company to make changes"}
                </div>
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
                <p><strong>Frame:</strong> {opening.frame.material || "Material not recorded"} · {opening.frame.frame_type || "Type not recorded"} · {formatSize(opening.frame.width_in, opening.frame.height_in)} · condition {opening.frame.condition}</p>
              )}
              {unevenPair(opening.door_leaves) && <p><strong>Uneven pair</strong></p>}
              {opening.door_leaves.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No door-leaf records have synchronized for this opening.</p>
              ) : (
                <div className="table-scroll"><table>
                  <thead><tr><th>Leaf</th><th>Handing</th><th>Material</th><th>Size</th><th>Condition</th></tr></thead>
                  <tbody>
                    {opening.door_leaves.map((leaf) => (
                      <tr key={leaf.id}>
                        <td style={{ textTransform: "capitalize" }}>{leaf.leaf_role}</td>
                        <td>{leaf.handing || "—"}</td>
                        <td>{leaf.material || "—"}</td>
                        <td>{formatSize(leaf.width_in, leaf.height_in, leaf.thickness_in)}</td>
                        <td style={{ textTransform: "capitalize" }}>{leaf.condition}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>

            {opening.photos.length > 0 && (
              <div className="panel">
                <h2>Photos &amp; Videos</h2>
                <div className="photo-grid">
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
                <div className="table-scroll"><table>
                  <thead>
                    <tr>
                      <th>Location</th>
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
                        <td>{loc.label(opening)}</td>
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
                </table></div>
              )}
            </div>

            <div className="panel" data-service-history>
              <h2>Service History</h2>
              {opening.service_events.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No service events recorded yet.</p>
              ) : (() => {
                const history = splitServiceHistory(opening as any);
                return (
                  <>
                    <div data-opening-service-history>
                      <h3 style={{ fontSize: 14, margin: "8px 0 4px" }}>Whole opening</h3>
                      {history.openingLevel.length === 0
                        ? <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No opening-level service recorded.</p>
                        : <ServiceTable events={history.openingLevel} />}
                    </div>
                    {history.unmatched.map(event => {
                      const retired = (opening as any).retired_hardware_components?.find((c: any) => c.id === event.hardware_component_id);
                      return <div key={event.id} data-historical-component={event.hardware_component_id}>
                        <h3>{retired ? componentLabel(retired, opening as any) + ' (retired)' : 'Historical component ' + event.hardware_component_id}</h3>
                        <ServiceTable events={[event]} />
                      </div>;
                    })}
                    {opening.hardware_components.map((hw) => (
                      <div key={hw.id} data-component-history={hw.id}>
                        <h3 style={{ fontSize: 14, margin: "14px 0 4px" }}>{componentLabel(hw as any, opening as any)}</h3>
                        {(history.byComponent.get(hw.id) || []).length === 0
                          ? <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No service recorded for this component.</p>
                          : <ServiceTable events={history.byComponent.get(hw.id) || []} />}
                      </div>
                    ))}
                  </>
                );
              })()}
            </div>

            <div className="panel">
              <h2>Inspection History</h2>
              {opening.inspection_events.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No inspections recorded yet.</p>
              ) : (
                <div className="inspection-list">
                  {opening.inspection_events.map((ev: any) => (
                    <article key={ev.id} id={`inspection-${ev.id}`} className={linkedInspection === ev.id ? "inspection-card is-linked" : "inspection-card"}>
                      <div className="inspection-card-head">
                        <strong>{new Date(ev.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</strong>
                        <span style={{ textTransform: "capitalize" }}>{String(ev.inspection_type).replace(/_/g, " ")}</span>
                        <span className={`health-pill ${ev.passed ? "health-good" : "health-poor"}`}>{ev.passed ? "Passed" : "Failed"}</span>
                      </div>
                      <p>{ev.notes || "No notes."}</p>
                      {ev.signed_by_name && <p>Inspector {ev.signed_by_name}{ev.inspector_qualification ? ` · ${ev.inspector_qualification}` : ""}{ev.inspector_license_number ? ` · License ${ev.inspector_license_number}` : ""}</p>}
                      {ev.signature_data && <img src={ev.signature_data} alt={`${ev.signed_by_name || "Inspector"} signature`} style={{ height: 48, background: "#fff", border: "1px solid var(--border)", borderRadius: 4 }} />}
                      {ev.inspection_type === "fire_door_nfpa80" && ev.checklist_result?.status === "complete" && (
                        <div className="inspection-actions">
                          <button className="btn btn-secondary" type="button" onClick={() => downloadAuthedFile(`/events/inspection-events/${ev.id}/report.pdf`, "fire-door-inspection.pdf").catch(() => setRecordMessage((current) => ({ ...current, [ev.id]: "Could not download the report." })))}>Download PDF</button>
                          {canSaveRecords && <button className="btn btn-secondary" type="button" onClick={() => saveReport(ev.id)}>Save to facility records</button>}
                          {canSaveRecords && ev.visit_id && <Link to={`/inspection-visits/${ev.visit_id}`}>Part of visit {String(ev.event_date).slice(0, 10)}</Link>}
                          {recordMessage[ev.id] && <p role={recordMessage[ev.id].startsWith("Could not") ? "alert" : "status"}>{recordMessage[ev.id]}</p>}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="panel">
              <h2>Sent to purchasing</h2>
              {(opening.purchasing_sends || []).length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Nothing has been sent to purchasing for this opening.</p>
              ) : (
                <table>
                  <thead><tr><th>When</th><th>To</th><th>How</th><th>Note</th></tr></thead>
                  <tbody>
                    {(opening.purchasing_sends || []).map((send) => (
                      <tr key={send.id}>
                        <td>{new Date(send.created_at).toLocaleString()}</td>
                        <td>{send.sent_to}</td>
                        <td>{send.delivery_mode}</td>
                        <td>{send.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel">
              <h2>Fire door deficiencies</h2>
              {(opening.fire_door_deficiencies || []).length === 0 ? (
                <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>No fire door deficiencies are on file.</p>
              ) : (
                <table>
                  <thead><tr><th>Item</th><th>Status</th><th>Note</th><th>Repair</th></tr></thead>
                  <tbody>
                    {(opening.fire_door_deficiencies || []).map((row) => (
                      <tr key={row.id}>
                        <td>{row.item_key}</td>
                        <td>{row.status}</td>
                        <td>{row.note}</td>
                        <td>{row.repair_note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {opening.inspection_events.some((ev: any) => ev.inspection_type === "fire_door_nfpa80" && ev.checklist_result?.status === "complete") && (
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const inspection = opening.inspection_events.find((ev: any) => ev.inspection_type === "fire_door_nfpa80" && ev.checklist_result?.status === "complete");
                  if (!inspection) return;
                  const to = reportTo.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
                  emailInspectionReport(inspection.id, to).then(() => setReportMessage("Report emailed.")).catch(() => setReportMessage("Could not email the report."));
                }} style={{ marginTop: 12 }}>
                  <label htmlFor="report-email">Email this report</label>
                  <textarea id="report-email" value={reportTo} onChange={(e) => setReportTo(e.target.value)} placeholder="facility contact, your email, anyone else" required />
                  <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Starts with the facility contact, when one is on file, and the email of the person who signed. Add or remove addresses before sending.</p>
                  <button className="btn btn-secondary" type="submit">Email this report</button>
                  {reportMessage && <p>{reportMessage}</p>}
                </form>
              )}
            </div>

            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <h2 style={{ margin: 0 }}>Documents</h2>
                {loc.writeState(opening) === "write" && <button className="btn btn-secondary" style={{ width: "auto", padding: "0 16px" }} onClick={() => setShowUploadForm((v) => !v)}>
                  {showUploadForm ? "Cancel" : "+ Upload Document"}
                </button>}
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
                        <td>{d.inspection_event_id
                          ? <button type="button" className="btn btn-secondary" style={{ width: "auto", padding: "0 10px", height: 28, fontSize: 12 }} onClick={() => downloadAuthedFile(`/documents/${d.id}/file`, `${d.title}.pdf`).catch(() => setUploadError("Could not download the report."))}>{d.title}</button>
                          : <a href={d.storage_url} target="_blank" rel="noreferrer">{d.title}</a>}
                        </td>
                        <td style={{ textTransform: "capitalize" }}>{d.document_type.replace(/_/g, " ")}</td>
                        <td>{new Date(d.created_at).toLocaleDateString()}</td>
                        <td>
                          {loc.writeState(opening) === "write" && <button
                            className="btn btn-secondary"
                            style={{ width: "auto", padding: "0 10px", height: 28, fontSize: 12 }}
                            onClick={() => onDeleteDocument(d.id)}
                          >
                            Delete
                          </button>}
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
