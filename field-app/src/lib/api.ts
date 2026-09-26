import { loadAuth, cacheOpening, getCachedOpening } from "./db";

// Point this at your deployed API. Left as a relative path + env var so it works
// both in local dev (via Vite proxy) and once deployed.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ExpectedPrincipal { userId: string; organizationId: string }

async function authedFetch(path: string, options: RequestInit = {}, expectedPrincipal?: ExpectedPrincipal) {
  const auth = await loadAuth();
  if (expectedPrincipal && (!auth || auth.userId !== expectedPrincipal.userId || auth.organizationId !== expectedPrincipal.organizationId)) {
    throw new ApiError(401, "active_principal_changed");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (auth?.token) headers["Authorization"] = `Bearer ${auth.token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || `request_failed_${res.status}`);
  }
  const current=await loadAuth();
  if(!auth||!current||current.userId!==auth.userId||current.organizationId!==auth.organizationId)throw new ApiError(401,"active_principal_changed");
  if (res.status === 204) return null; // DELETE endpoints return no body
  return res.json();
}

export async function login(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || "login_failed");
  }
  return res.json() as Promise<{ token: string; expiresIn: string }>;
}

// Decode the JWT payload client-side just to read organizationId/role for local
// storage — this is NOT a security boundary, the server verifies the signature.
export function decodeTokenPayload(token: string): { userId: string; organizationId: string; role: string } {
  const payload = JSON.parse(atob(token.split(".")[1]));
  return { userId: payload.userId, organizationId: payload.organizationId, role: payload.role };
}

// Resolve a scanned/entered QR token to its opening. Falls back to cache if offline.
export async function fetchOpeningByQr(qrToken: string) {
  const principal=await loadAuth();
  if(!principal)throw new ApiError(401,"missing_token");
  try {
    const opening = await authedFetch(`/openings/by-qr/${encodeURIComponent(qrToken)}`,{},principal);
    await cacheOpening(opening,principal);
    return { opening, fromCache: false };
  } catch (err) {
    if (err instanceof TypeError || (err instanceof ApiError && err.status >= 500)) {
      // Network-level failure — try the cache. (Cache is keyed by opening id, not
      // qr_token, so this only helps if the opening was already viewed before.)
      throw err;
    }
    throw err;
  }
}

// For manual entry — a technician types the human-readable code printed on
// the door tag, not the internal qr_token embedded in the QR image itself.
export async function fetchOpeningByCode(openingCode: string) {
  const principal=await loadAuth();
  if(!principal)throw new ApiError(401,"missing_token");
  const opening = await authedFetch(`/openings/by-code/${encodeURIComponent(openingCode)}`,{},principal);
  await cacheOpening(opening,principal);
  return { opening, fromCache: false };
}

export async function fetchOpening(id: string) {
  const principal=await loadAuth();
  if(!principal)throw new ApiError(401,"missing_token");
  try {
    const opening = await authedFetch(`/openings/${id}`,{},principal);
    await cacheOpening(opening,principal);
    return { opening, fromCache: false };
  } catch (err) {
    if (!(err instanceof TypeError || (err instanceof ApiError && err.status >= 500))) throw err;
    const cached = await getCachedOpening(id);
    if (cached) return { opening: cached, fromCache: true };
    throw err;
  }
}

export async function listOpenings(params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  return authedFetch(`/openings${qs ? `?${qs}` : ""}`);
}

export async function presignPhotoUpload(openingId: string, contentType: string, clientOperationId: string) {
  return authedFetch("/photos/presign", {
    method: "POST",
    body: JSON.stringify({ opening_id: openingId, content_type: contentType, client_operation_id: clientOperationId }),
  });
}

export async function confirmPhotoUpload(payload: {
  opening_id: string;
  storage_object_key: string;
  content_type: string;
  client_operation_id: string;
  related_entity_type?: "opening" | "frame" | "door_leaf" | "hardware_component";
  related_entity_id?: string;
  frame_id?: string;
  door_leaf_id?: string;
  hardware_component_id?: string;
  latitude?: number;
  longitude?: number;
}) {
  return authedFetch("/photos", { method: "POST", body: JSON.stringify(payload) });
}

export async function deletePhoto(id: string) {
  return authedFetch(`/photos/${id}`, { method: "DELETE" });
}

export async function fetchPhotoAccessUrl(id: string): Promise<{ url: string; expires_in_seconds: number }> {
  return authedFetch(`/photos/${id}/access`);
}

// Uploads directly to storage using the presigned URL — bypasses our own API
// entirely for the actual bytes, per authedFetch not being used here.
export async function uploadToPresignedUrl(uploadUrl: string, blob: Blob, contentType: string) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload_failed_${res.status}`);
}

export async function reserveOfflinePhoto(payload: {
  photo_id: string;
  client_operation_id: string;
  opening_id: string;
  target_type: "opening" | "frame" | "door_leaf" | "hardware_component" | "service_event" | "inspection_event";
  target_id: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  sha256_checksum: string;
  device_id: string;
  latitude?: number;
  longitude?: number;
}, expectedPrincipal?: ExpectedPrincipal) {
  return authedFetch("/photos/offline/reserve", { method: "POST", body: JSON.stringify(payload) }, expectedPrincipal);
}

export async function recoverOfflinePhotoReservation(payload: {
  photo_id: string;
  opening_id: string;
  target_type: "opening" | "frame" | "door_leaf" | "hardware_component" | "service_event" | "inspection_event";
  target_id: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  sha256_checksum: string;
  device_id: string;
  latitude?: number;
  longitude?: number;
}, expectedPrincipal?: ExpectedPrincipal) {
  return authedFetch("/photos/offline/recover-reservation",
    { method: "POST", body: JSON.stringify(payload) }, expectedPrincipal);
}

export async function uploadPrivatePhoto(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
  checksum: string,
  photoId: string,
) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-amz-meta-oi-sha256": checksum,
      "x-amz-meta-oi-photo-id": photoId,
    },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload_failed_${res.status}`);
}

export async function confirmOfflinePhoto(payload: {
  photo_id: string;
  client_operation_id: string;
  schema_version: number;
  app_version: string;
  protocol_version: number;
}, expectedPrincipal?: ExpectedPrincipal) {
  return authedFetch("/photos/offline/confirm", { method: "POST", body: JSON.stringify(payload) }, expectedPrincipal);
}

export async function submitOfflineComponent(payload: Record<string, unknown>, expectedPrincipal?: ExpectedPrincipal) {
  return authedFetch("/sync/components", { method: "POST", body: JSON.stringify(payload) }, expectedPrincipal);
}

export async function submitOfflineOperation(payload: Record<string, unknown>, expectedPrincipal?: ExpectedPrincipal) {
  return authedFetch("/sync/operations", { method: "POST", body: JSON.stringify(payload) }, expectedPrincipal);
}

export async function fetchHardwareForOpening(openingId: string) {
  return authedFetch(`/hardware/by-opening/${openingId}`);
}

export async function editHardwareComponent(id: string, payload: any) {
  return authedFetch(`/hardware/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export async function deleteHardwareComponent(id: string) {
  return authedFetch(`/hardware/${id}`, { method: "DELETE" });
}

export async function addHardwareComponent(payload: any) {
  return authedFetch("/hardware", { method: "POST", body: JSON.stringify(payload) });
}

export async function saveOpeningFrame(openingId: string, payload: any) {
  return authedFetch(`/openings/${openingId}/frame`, { method: "PUT", body: JSON.stringify(payload) });
}

export async function saveDoorLeaf(openingId: string, payload: any) {
  return authedFetch(`/openings/${openingId}/door-leaves`, { method: "POST", body: JSON.stringify(payload) });
}

export async function completeOpening(openingId: string) {
  return authedFetch(`/openings/${openingId}/complete`, { method: "POST" });
}

export async function submitServiceEvent(payload: any) {
  return authedFetch("/events/service-events", { method: "POST", body: JSON.stringify(payload) });
}

export async function submitInspectionEvent(payload: any) {
  return authedFetch("/events/inspection-events", { method: "POST", body: JSON.stringify(payload) });
}

export async function recomputeHealthScore(openingId: string) {
  return authedFetch(`/openings/${openingId}/recompute-health-score`, { method: "POST" });
}

export interface FieldWorkOrder {
  id: string;
  opening_id: string;
  opening_code: string;
  building_name: string;
  property_name: string;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due_date: string | null;
}

// This requires connectivity — unlike service/inspection logging, work
// order assignments aren't something a technician creates themselves, so
// there's nothing meaningful to queue offline for. Same reasoning as
// hardware capture.
export async function fetchMyWorkOrders(userId: string): Promise<FieldWorkOrder[]> {
  return authedFetch(`/work-orders?assigned_to_user_id=${userId}`);
}

export async function updateMyWorkOrderStatus(id: string, status: string): Promise<FieldWorkOrder> {
  return authedFetch(`/work-orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

export const listFieldPortfolios = () => authedFetch("/portfolio/portfolios");
export const listFieldProperties = () => authedFetch("/portfolio/properties");
export const createFieldProperty = (payload: {portfolio_id:string;name:string;property_type:string}) => authedFetch("/portfolio/properties", {method:"POST", body:JSON.stringify(payload)});
export const createFieldBuilding = (payload: {property_id:string;name:string}) => authedFetch("/portfolio/buildings", {method:"POST", body:JSON.stringify(payload)});
export const createFieldOpening = (payload: {building_id:string;opening_code:string;opening_type:string;opening_configuration:string;fire_rated:boolean}) => authedFetch("/openings", {method:"POST", body:JSON.stringify(payload)});
export const fetchOpeningLabel = (id:string) => authedFetch(`/openings/${encodeURIComponent(id)}/qr-code`);

export const searchFieldFacilities = (params:Record<string,string>={}) => authedFetch(`/portfolio/facility-search?${new URLSearchParams(params)}`);

export const listBranches = () => authedFetch("/branches");
export const saveBranch = (id:string,body:unknown) => authedFetch(`/branches/${id}`,{method:"PUT",body:JSON.stringify(body)});
export const assignBranch = (id:string,branch_id:string|null) => authedFetch(`/branches/assignments/${id}`,{method:"PUT",body:JSON.stringify({branch_id})});
