import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { fetchOpening, fetchOpeningByQr, fetchOpeningByCode, deletePhoto, fetchPhotoAccessUrl } from "../lib/api";
import { getAllOfflineMedia, updateCachedOpening } from "../lib/db";
import type { OfflineMediaRecord } from "../lib/offlineTypes";
import { onSyncStateChange, queueOpeningMutation } from "../lib/sync";
import { SyncBadge } from "../components/SyncBadge";
import { PhotoCapture } from "../components/PhotoCapture";
import { openingCompletionRequirements } from "../lib/openingCompletion";

function healthClass(score: number | null) {
  if (score === null || score === undefined) return "";
  if (score >= 75) return "health-good";
  if (score >= 50) return "health-fair";
  return "health-poor";
}

function SyncedMedia({ photo }: { photo: any }) {
  const [url, setUrl] = useState<string | null>(photo.storage_url?.startsWith("private:") ? null : photo.storage_url);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    if (!photo.storage_url?.startsWith("private:")) {
      setUrl(photo.storage_url);
      return () => { active = false; };
    }
    setUrl(null);
    fetchPhotoAccessUrl(photo.id)
      .then(({ url }) => { if (active) setUrl(url); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [photo.id, photo.storage_url]);

  if (failed) return <div className="error-text" role="status">Photo unavailable</div>;
  if (!url) return <div style={{ aspectRatio: "1", display: "grid", placeItems: "center" }}>Loading…</div>;
  if (photo.media_type === "video") {
    return <video src={url} controls style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />;
  }
  return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Opening photo" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} /></a>;
}

export function OpeningDetailPage() {
  const { id, qrToken, openingCode } = useParams();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<any | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [queuedPhotos, setQueuedPhotos] = useState<(OfflineMediaRecord & { previewUrl: string })[]>([]);
  const [photoToDelete, setPhotoToDelete] = useState<{ id: string; name: string } | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const openingIdRef = useRef<string | null>(id ?? null);

  useEffect(() => {
    reload();
    const unsubscribe = onSyncStateChange((state) => {
      if (!state.syncing) {
        reload();
        loadQueuedPhotos();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, qrToken, openingCode]);

  async function loadQueuedPhotos() {
    const openingId = openingIdRef.current;
    if (!openingId) return;
    const items = (await getAllOfflineMedia()).filter((item) => item.openingId === openingId && item.uploadState !== "verified");
    setQueuedPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.previewUrl)); // avoid leaking object URLs
      return items.map((item) => ({ ...item, previewUrl: URL.createObjectURL(item.blob) }));
    });
  }

  async function handleDeletePhoto() {
    if (!photoToDelete) return;
    setDeletingPhoto(true);
    setDeleteError(null);
    try {
      await deletePhoto(photoToDelete.id);
      setPhotoToDelete(null);
      reload();
    } catch {
      setDeleteError("Couldn't delete that photo. It remains attached; please try again.");
    } finally {
      setDeletingPhoto(false);
    }
  }

  async function handleCompleteOpening() {
    try {
      await queueOpeningMutation("complete_opening", opening.id, {});
      await updateCachedOpening(opening.id, (cached) => ({ ...cached, completion_state: "pending_sync" }));
      setOpening({ ...opening, completion_state: "pending_sync" });
    } catch (err: any) {
      window.alert(err?.message === "opening_incomplete" ? "Save the frame, every door leaf, and review all hardware first." : "Opening could not be completed.");
    }
  }

  function reload() {
    setLoading(true);
    setError(null);
    const load = qrToken
      ? fetchOpeningByQr(qrToken)
      : openingCode
      ? fetchOpeningByCode(openingCode)
      : fetchOpening(id!);
    load
      .then(({ opening, fromCache }) => {
        setOpening(opening);
        setFromCache(fromCache);
        openingIdRef.current = opening.id;
        loadQueuedPhotos();
      })
      .catch(() => setError("Couldn't find that opening. Check the code and try again."))
      .finally(() => setLoading(false));
  }

  if (loading) {
    return (
      <div className="app-shell">
        <div className="top-bar"><h1>Loading…</h1></div>
      </div>
    );
  }

  if (error || !opening) {
    return (
      <div className="app-shell">
        <div className="top-bar">
          <h1>Not Found</h1>
          <SyncBadge />
        </div>
        <div className="screen empty-state">
          <p>{error}</p>
          <button className="btn btn-secondary" onClick={() => navigate("/scan")}>Back to Scan</button>
        </div>
      </div>
    );
  }

  const completionRequirements = openingCompletionRequirements(opening);
  const completionBlocked = opening.completion_state !== "complete" && opening.completion_state !== "pending_sync" && completionRequirements.length > 0;

  return (
    <div className="app-shell">
      <div className="top-bar">
        <button className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13 }} onClick={() => navigate("/scan")}>
          ← Scan
        </button>
        <SyncBadge />
      </div>

      <div className="screen">
        <div className="asset-plate" style={{ marginBottom: 10 }}>{opening.opening_code}</div>
        {fromCache && (
          <p className="error-text" style={{ marginTop: 0 }}>Showing last-saved data — no connection right now.</p>
        )}

        <h2 style={{ fontSize: 20, marginBottom: 4 }}>
          {opening.location_description || opening.opening_type}
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 16 }}>
          {opening.opening_type.replace(/_/g, " ")} · Floor {opening.floor_label || "—"}
        </p>

        <div className={`card card-health ${healthClass(opening.health_score)}`}>
          <div className="section-label">Health Score</div>
          <div style={{ fontSize: 28, fontFamily: "var(--font-display)", fontWeight: 700 }}>
            {opening.health_score !== null && opening.health_score !== undefined
              ? Math.round(opening.health_score)
              : "—"}
            <span style={{ fontSize: 14, color: "var(--text-secondary)", fontWeight: 500 }}> / 100</span>
          </div>
          {opening.fire_rated && <span className="badge" style={{ marginTop: 8 }}>Fire Rated</span>}
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
          <Link to={`/opening/${opening.id}/log-service`} className="btn btn-primary" style={{ textDecoration: "none" }}>
            Log Service
          </Link>
          <Link to={`/opening/${opening.id}/log-inspection`} className="btn btn-secondary" style={{ textDecoration: "none" }}>
            Log Inspection
          </Link>
        </div>

        <div className="section-label">Opening Structure</div>
        <div className="card">
          <strong>{opening.opening_configuration === "pair" ? "Door pair" : "Single door"}</strong>
          <p style={{ margin: "6px 0", fontSize: 13, color: "var(--text-secondary)" }}>
            Frame: {opening.frame?.material || "not saved"} · Door leaves: {opening.door_leaves?.length || 0}
          </p>
          <Link to={`/opening/${opening.id}/structure`} state={{ opening }} className="btn btn-secondary" style={{ textDecoration: "none" }}>
            Door &amp; frame details
          </Link>
          {opening.completion_state === "complete" && !fromCache && <Link className="btn btn-secondary" to={`/opening/${opening.id}/label`}>Print / save label</Link>}
          {completionBlocked && (
            <div role="status" className="error-text" style={{ marginTop: 10 }}>
              <strong>Before finishing:</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {completionRequirements.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          )}
          <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={handleCompleteOpening}
            disabled={opening.completion_state === "complete" || opening.completion_state === "pending_sync" || completionBlocked}>
            {opening.completion_state === "complete" ? "Opening complete" : opening.completion_state === "pending_sync" ? "Completion pending sync" : "Finish the opening"}
          </button>
        </div>

        <div className="section-label" style={{ marginTop: 20 }}>Photos &amp; Videos</div>
        {((opening.photos && opening.photos.length > 0) || queuedPhotos.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 10 }}>
            {queuedPhotos.map((p) => (
              <div key={p.photoId} style={{ position: "relative" }}>
                {p.contentType.startsWith("video/") ? (
                  <video
                    src={p.previewUrl}
                    muted
                    style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", opacity: 0.6 }}
                  />
                ) : (
                  <img
                    src={p.previewUrl}
                    alt=""
                    style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", opacity: 0.6 }}
                  />
                )}
                <span
                  className="badge badge-offline"
                  style={{ position: "absolute", bottom: 4, left: 4, fontSize: 10, padding: "2px 6px" }}
                >
                  {p.uploadState === "retry_wait" ? "Retrying…" : p.uploadState === "conflict" ? "Conflict" : "Queued"}
                </span>
              </div>
            ))}
            {opening.photos && opening.photos.map((p: any) => (
              <div key={p.id} style={{ position: "relative" }}>
                <SyncedMedia photo={p} />
                <button
                  onClick={() => { setDeleteError(null); setPhotoToDelete({ id: p.id, name: p.original_filename || "this photo" }); }}
                  aria-label="Delete photo"
                  style={{
                    position: "absolute", top: 4, right: 4, width: 24, height: 24,
                    borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.65)",
                    color: "#fff", fontSize: 16, lineHeight: "24px", textAlign: "center",
                    cursor: "pointer", padding: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <PhotoCapture openingId={opening.id} onQueued={loadQueuedPhotos} />

        {photoToDelete && (
          <div role="dialog" aria-modal="true" aria-labelledby="delete-photo-title" className="card"
            style={{ borderColor: "var(--danger)", marginTop: 10 }}>
            <strong id="delete-photo-title">Delete photo?</strong>
            <p style={{ margin: "6px 0 10px", fontSize: 14 }}>
              {photoToDelete.name} will be removed from this opening. This cannot be undone in the field app.
            </p>
            {deleteError && <p role="alert" className="error-text">{deleteError}</p>}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-secondary" disabled={deletingPhoto} onClick={() => { setPhotoToDelete(null); setDeleteError(null); }}>Cancel</button>
              <button className="btn btn-primary" disabled={deletingPhoto} onClick={handleDeletePhoto}>
                {deletingPhoto ? "Deleting…" : "Delete photo"}
              </button>
            </div>
          </div>
        )}

        {opening.hardware_components && opening.hardware_components.length > 0 && (
          <>
            <div className="section-label">Hardware</div>
            {opening.hardware_components.map((hw: any) => (
              <div key={hw.id} className="card">
              <Link to={`/opening/${opening.id}/edit-hardware/${hw.id}`} state={{ hardware: hw }} style={{ display: "block", textDecoration: "none", color: "inherit" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <strong style={{ textTransform: "capitalize" }}>{hw.component_type.replace(/_/g, " ")}</strong>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
                      {hw.manufacturer} {hw.model_number}
                    </p>
                    {(hw.unit_cost || hw.supplier_name) && (
                      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--accent)" }}>
                        {hw.unit_cost ? `$${Number(hw.unit_cost).toFixed(2)}` : ""}
                        {hw.unit_cost && hw.supplier_name ? " · " : ""}
                        {hw.supplier_name || ""}
                      </p>
                    )}
                    {hw.supplier_contact && (
                      <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-secondary)" }}>
                        {hw.supplier_contact}
                      </p>
                    )}
                    <p style={{ margin: "4px 0 0", display: "flex", gap: 6, alignItems: "center" }}>
                      {hw.tracker_id && (
                        <span className="asset-plate" style={{ fontSize: 10, padding: "2px 6px" }}>{hw.tracker_id}</span>
                      )}
                      {hw.shipment_status && hw.shipment_status !== "not_shipped" && (
                        <span className="badge" style={{ fontSize: 10 }}>{hw.shipment_status.replace(/_/g, " ")}</span>
                      )}
                    </p>
                  </div>
                  <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>Edit ›</span>
                </div>
              </Link>
              <div style={{ marginTop: 10 }}>
                <PhotoCapture openingId={opening.id} relatedEntityType="hardware_component" relatedEntityId={hw.id} onQueued={loadQueuedPhotos} />
              </div>
              </div>
            ))}
          </>
        )}
        <Link
          to={`/opening/${opening.id}/add-hardware`}
          className="btn btn-secondary"
          style={{ textDecoration: "none", marginBottom: 20, fontSize: 13 }}
        >
          + Add Hardware
        </Link>

        {opening.service_events && opening.service_events.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 20 }}>Recent Service</div>
            {opening.service_events.slice(0, 5).map((ev: any) => (
              <div className="card" key={ev.id}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong style={{ fontSize: 13 }}>{new Date(ev.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</strong>
                </div>
                <p style={{ margin: "4px 0 0", fontSize: 14 }}>{ev.work_performed}</p>
              </div>
            ))}
          </>
        )}

        {opening.inspection_events && opening.inspection_events.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 20 }}>Recent Inspections</div>
            {opening.inspection_events.slice(0, 5).map((ev: any) => (
              <div className="card" key={ev.id}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>{new Date(ev.event_date).toLocaleDateString(undefined, { timeZone: "UTC" })}</strong>
                  <span
                    className="badge"
                    style={{ color: ev.passed ? "var(--success)" : "var(--danger)", borderColor: ev.passed ? "var(--success)" : "var(--danger)" }}
                  >
                    {ev.passed ? "Passed" : "Failed"}
                  </span>
                </div>
                {ev.notes && <p style={{ margin: "4px 0 0", fontSize: 14 }}>{ev.notes}</p>}
              </div>
            ))}
          </>
        )}

        {(!opening.service_events || opening.service_events.length === 0) &&
          (!opening.inspection_events || opening.inspection_events.length === 0) && (
            <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>No service or inspection history yet.</p>
          )}
      </div>
    </div>
  );
}
