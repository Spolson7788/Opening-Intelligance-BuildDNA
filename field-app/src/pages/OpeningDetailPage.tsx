import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { fetchOpening, fetchOpeningByQr, fetchOpeningByCode, deletePhoto } from "../lib/api";
import { getPhotoOutboxForOpening } from "../lib/db";
import type { PhotoOutboxItem } from "../lib/db";
import { onSyncStateChange } from "../lib/sync";
import { SyncBadge } from "../components/SyncBadge";
import { PhotoCapture } from "../components/PhotoCapture";

function healthClass(score: number | null) {
  if (score === null || score === undefined) return "";
  if (score >= 75) return "health-good";
  if (score >= 50) return "health-fair";
  return "health-poor";
}

export function OpeningDetailPage() {
  const { id, qrToken, openingCode } = useParams();
  const navigate = useNavigate();
  const [opening, setOpening] = useState<any | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [queuedPhotos, setQueuedPhotos] = useState<(PhotoOutboxItem & { previewUrl: string })[]>([]);
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
    const items = await getPhotoOutboxForOpening(openingId);
    setQueuedPhotos((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.previewUrl)); // avoid leaking object URLs
      return items.map((item) => ({ ...item, previewUrl: URL.createObjectURL(item.blob) }));
    });
  }

  async function handleDeletePhoto(photoId: string) {
    if (!window.confirm("Delete this photo? This can't be undone.")) return;
    try {
      await deletePhoto(photoId);
      reload(); // re-fetch so the grid reflects the deletion
    } catch {
      window.alert("Couldn't delete that photo — please try again.");
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

        <div className="section-label" style={{ marginTop: 20 }}>Photos &amp; Videos</div>
        {((opening.photos && opening.photos.length > 0) || queuedPhotos.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 10 }}>
            {queuedPhotos.map((p) => (
              <div key={p.id} style={{ position: "relative" }}>
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
                  {p.attempts > 0 ? "Retrying…" : "Queued"}
                </span>
              </div>
            ))}
            {opening.photos && opening.photos.map((p: any) => (
              <div key={p.id} style={{ position: "relative" }}>
                {p.media_type === "video" ? (
                  <video
                    src={p.storage_url}
                    controls
                    style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }}
                  />
                ) : (
                  <a href={p.storage_url} target="_blank" rel="noreferrer">
                    <img
                      src={p.storage_url}
                      alt=""
                      style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }}
                    />
                  </a>
                )}
                <button
                  onClick={() => handleDeletePhoto(p.id)}
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

        {opening.hardware_components && opening.hardware_components.length > 0 && (
          <>
            <div className="section-label">Hardware</div>
            {opening.hardware_components.map((hw: any) => (
              <Link
                to={`/opening/${opening.id}/edit-hardware/${hw.id}`}
                state={{ hardware: hw }}
                key={hw.id}
                className="card"
                style={{ display: "block", textDecoration: "none", color: "inherit" }}
              >
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
                  <strong style={{ fontSize: 13 }}>{new Date(ev.event_date).toLocaleDateString()}</strong>
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
                  <strong style={{ fontSize: 13 }}>{new Date(ev.event_date).toLocaleDateString()}</strong>
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
