import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, confirmDoorHardware, identifyDoorHardware, reserveOfflinePhoto, confirmOfflinePhoto, uploadPrivatePhoto, type DoorHardwareItem, type DoorHardwareRun } from "../lib/api";
import { loadAuth } from "../lib/db";
import { MAX_IMAGE_BYTES } from "../lib/mediaLimits";
import { OFFLINE_SCHEMA_VERSION, SYNC_PROTOCOL_VERSION } from "../lib/offlineTypes";
import { prepareImageForUpload, reducedFilename } from "../lib/photoPreparation";
import { checksumBlob, getOrCreateDeviceId } from "../lib/sync";
import { SyncBadge } from "../components/SyncBadge";

const COMPONENT_TYPES = [
  ["lockset", "Lockset"], ["cylinder", "Cylinder"], ["closer", "Closer"], ["exit_device", "Exit device"],
  ["hinge", "Hinge"], ["automatic_operator", "Automatic operator"], ["panic_bar", "Panic bar"],
  ["access_control_reader", "Access control reader"], ["keypad", "Keypad"], ["electric_strike", "Electric strike"],
  ["power_transfer", "Power transfer"], ["maglock", "Maglock"], ["request_to_exit_device", "Request-to-exit"],
  ["other", "Other"],
] as const;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_PHOTOS = 3;
const MAX_PHOTOS = 9;

type Draft = { id: string; include: boolean; component_type: string; subtype: string; manufacturer: string; model_number: string; finish: string };
type LocalPhoto = { key: string; name: string; file: File; previewUrl: string };

const REASONS: Record<string, string> = {
  too_few_photos: "Add at least 3 photographs.",
  too_many_photos: "9 photographs is the maximum for one identification.",
  duplicate_photo: "Each photograph can be included once.",
  daily_limit_exceeded: "Your company has reached today’s identification limit.",
  hardware_recognition_unavailable: "Hardware identification is not available right now.",
  feature_disabled: "Hardware identification is not turned on for this site.",
  forbidden: "You do not have access to identify hardware on this opening.",
  opening_not_found: "This opening is not available.",
  stored_photo_not_found: "A photograph was not saved. Identification was not run.",
  photos_exceed_provider_limit: "Those photographs are too large to send. Try closer, simpler shots.",
  provider_result_unreadable: "The identification result could not be read. No hardware was saved.",
  provider_rejected: "Identification did not complete. No hardware was saved.",
  provider_call_outcome_unknown: "Identification did not finish. It may have been counted. Try again only if you need a new result.",
  stored_original_checksum_mismatch: "A saved photograph did not match its record. Identification was not run.",
  stored_original_unreadable: "A saved photograph could not be read. Identification was not run.",
  unsupported_photo_type: "Use JPEG, PNG, or WebP photographs.",
  photo_too_large: "A photograph is above the 2 MB upload limit and this device could not make a smaller copy.",
  photo_upload_unavailable: "Photograph upload is not available right now.",
  invalid_confirmation: "Review each item before saving.",
  invalid_component_type: "Choose a hardware type for each item you save.",
  run_not_awaiting_review: "This identification is no longer waiting for review.",
};

function explain(error: unknown): string {
  const code = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "";
  return REASONS[code] ?? "Hardware identification did not complete. No hardware was saved.";
}

function draftsFrom(items: DoorHardwareItem[]): Draft[] {
  return items.map((item) => ({
    id: item.id,
    include: true,
    component_type: item.component_type,
    subtype: item.subtype ?? "",
    manufacturer: item.manufacturer ?? "",
    model_number: item.exact_model ?? "",
    finish: item.finish ?? "",
  }));
}

async function uploadOne(openingId: string, file: File, principal: { userId: string; organizationId: string }): Promise<string> {
  const prepared = await prepareImageForUpload(file, MAX_IMAGE_BYTES);
  if (!prepared.withinLimit) throw new Error("photo_too_large");
  const contentType = prepared.contentType || file.type || "image/jpeg";
  if (!ALLOWED.has(contentType)) throw new Error("unsupported_photo_type");
  const photoId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const checksum = await checksumBlob(prepared.blob);
  const reservation = await reserveOfflinePhoto({
    photo_id: photoId,
    client_operation_id: operationId,
    opening_id: openingId,
    target_type: "opening",
    target_id: openingId,
    original_filename: (prepared.reduced ? reducedFilename(file.name) : file.name || "hardware.jpg").slice(0, 255),
    content_type: contentType,
    byte_size: prepared.blob.size,
    sha256_checksum: checksum,
    device_id: await getOrCreateDeviceId(),
  }, principal);
  if (reservation.status !== "verified") {
    if (!reservation.upload_url) throw new Error("photo_upload_unavailable");
    await uploadPrivatePhoto(reservation.upload_url, prepared.blob, contentType, checksum, photoId);
  }
  await confirmOfflinePhoto({
    photo_id: photoId,
    client_operation_id: operationId,
    schema_version: OFFLINE_SCHEMA_VERSION,
    app_version: "offline-protocol-1",
    protocol_version: SYNC_PROTOCOL_VERSION,
  }, principal);
  return photoId;
}

export function IdentifyHardwarePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [phase, setPhase] = useState<"capture" | "working" | "review" | "saved">("capture");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [run, setRun] = useState<DoorHardwareRun | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => { photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl)); }, []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setError("");
    setPhotos((current) => {
      const next = [...current];
      for (const file of Array.from(list)) {
        if (next.length >= MAX_PHOTOS) break;
        next.push({ key: crypto.randomUUID(), name: file.name || "Photograph", file, previewUrl: URL.createObjectURL(file) });
      }
      return next;
    });
    if (photos.length + list.length > MAX_PHOTOS) setError("9 photographs is the maximum. Extra photographs were not added.");
  }

  function removePhoto(key: string) {
    setPhotos((current) => {
      const photo = current.find((item) => item.key === key);
      if (photo) URL.revokeObjectURL(photo.previewUrl);
      return current.filter((item) => item.key !== key);
    });
  }

  async function done() {
    if (!id) return;
    if (photos.length < MIN_PHOTOS || photos.length > MAX_PHOTOS) {
      setError(photos.length < MIN_PHOTOS ? REASONS.too_few_photos : REASONS.too_many_photos);
      return;
    }
    setPhase("working");
    setError("");
    const requestId = crypto.randomUUID();
    try {
      const auth = await loadAuth();
      if (!auth) throw new ApiError(401, "missing_token");
      const principal = { userId: auth.userId, organizationId: auth.organizationId };
      const photoIds: string[] = [];
      for (const [index, photo] of photos.entries()) {
        setStatus(`Saving photograph ${index + 1} of ${photos.length}…`);
        photoIds.push(await uploadOne(id, photo.file, principal));
      }
      setStatus("Identifying hardware…");
      const response = await identifyDoorHardware(id, photoIds, requestId);
      setRun(response.run);
      setDrafts(draftsFrom(response.run.items ?? []));
      setPhase("review");
      setStatus("");
    } catch (err) {
      setPhase("capture");
      setStatus("");
      setError(explain(err));
    }
  }

  function updateDraft(itemId: string, patch: Partial<Draft>) {
    setDrafts((current) => current.map((draft) => draft.id === itemId ? { ...draft, ...patch } : draft));
  }

  async function save() {
    if (!run) return;
    setPhase("working");
    setError("");
    setStatus("Saving confirmed hardware…");
    try {
      const response = await confirmDoorHardware(run.id, drafts.map((draft) => ({
        id: draft.id,
        include: draft.include,
        component_type: draft.component_type,
        subtype: draft.subtype.trim() || null,
        manufacturer: draft.manufacturer.trim() || null,
        model_number: draft.model_number.trim() || null,
        finish: draft.finish.trim() || null,
      })));
      setSavedCount(response.hardware_components?.length ?? drafts.filter((draft) => draft.include).length);
      setPhase("saved");
      setStatus("");
    } catch (err) {
      setPhase("review");
      setStatus("");
      setError(explain(err));
    }
  }

  return (
    <div className="app-shell">
      <div className="top-bar">
        <Link to={id ? `/opening/${id}` : "/scan"} className="btn btn-secondary" style={{ width: "auto", minHeight: "auto", padding: "6px 10px", fontSize: 13, textDecoration: "none" }}>← Opening</Link>
        <SyncBadge />
      </div>
      <div className="screen">
        <h1 style={{ fontSize: 22 }}>Identify hardware</h1>
        <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
          Add 3 to 9 photographs: overall shots of the opening and close-ups of labels. Then tap Done. You confirm or edit each item before it is saved.
        </p>
        {error && <p role="alert" className="error-text">{error}</p>}
        {status && <p role="status">{status}</p>}

        {phase === "capture" && (
          <section className="card" aria-label="Photographs for identification">
            <p>{photos.length} of {MIN_PHOTOS}–{MAX_PHOTOS} photographs</p>
            <ul style={{ listStyle: "none", padding: 0, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {photos.map((photo, index) => (
                <li key={photo.key}>
                  <img src={photo.previewUrl} alt={`Photograph ${index + 1}`} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 6 }} />
                  <button type="button" className="btn btn-secondary" onClick={() => removePhoto(photo.key)}>Remove {index + 1}</button>
                </li>
              ))}
            </ul>
            <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
              {photos.length ? "Add another photograph" : "Add photographs"}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" hidden onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />
            </label>
            <button type="button" className="btn btn-primary" disabled={photos.length < MIN_PHOTOS} onClick={done}>Done</button>
          </section>
        )}

        {phase === "review" && run && (
          <section aria-label="Review identified hardware">
            {!run.items.length && <p>No hardware was identified from these photographs. Nothing was saved.</p>}
            {run.items.map((item) => {
              const draft = drafts.find((row) => row.id === item.id);
              if (!draft) return null;
              const showTip = item.model_unknown && !draft.model_number.trim() && item.next_photo;
              return (
                <article key={item.id} className="card" aria-label={`Item ${item.ordinal}`}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={draft.include} onChange={(event) => updateDraft(item.id, { include: event.target.checked })} />
                    Save this item
                  </label>
                  <label>Type
                    <select value={draft.component_type} onChange={(event) => updateDraft(item.id, { component_type: event.target.value })}>
                      {COMPONENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label>Subtype <input value={draft.subtype} onChange={(event) => updateDraft(item.id, { subtype: event.target.value })} /></label>
                  <label>Manufacturer <input value={draft.manufacturer} onChange={(event) => updateDraft(item.id, { manufacturer: event.target.value })} /></label>
                  <label>Model <input value={draft.model_number} onChange={(event) => updateDraft(item.id, { model_number: event.target.value })} /></label>
                  <label>Finish <input value={draft.finish} onChange={(event) => updateDraft(item.id, { finish: event.target.value })} /></label>
                  <p>Photographs: {item.supporting_photos.length ? item.supporting_photos.join(", ") : "not cited"}</p>
                  <p>Evidence: {item.visible_evidence || "None recorded"}</p>
                  <p>Confidence: {item.confidence || "not stated"}</p>
                  {showTip && <p role="status">Next photograph: {item.next_photo}</p>}
                </article>
              );
            })}
            {!!run.items.length && <button type="button" className="btn btn-primary" onClick={save}>Save hardware</button>}
          </section>
        )}

        {phase === "saved" && (
          <section className="card" role="status">
            <p>Saved {savedCount} hardware {savedCount === 1 ? "item" : "items"}. Confirmed photographs and labels are kept for training.</p>
            <button type="button" className="btn btn-primary" onClick={() => id && navigate(`/opening/${id}`)}>Back to opening</button>
          </section>
        )}
      </div>
    </div>
  );
}
