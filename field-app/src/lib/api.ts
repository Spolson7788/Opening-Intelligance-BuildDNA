import { loadAuth, cacheOpening, getCachedOpening, wipeAllOiData, clearAuth } from "./db";
import { isNetlifyAccessResponse, SITE_ACCESS_REQUIRED } from "./siteAccess";
import {diagnosticActor,diagnosticAvailable,PROBES,readBoundedProbe,runPhotoProbes} from './photoDiagnostic';
import type {Principal,ProbeResponse} from './photoDiagnostic';
import { assertSyncDispatchAllowed } from './syncNavigation';

// Point this at your deployed API. Left as a relative path + env var so it works
// both in local dev (via Vite proxy) and once deployed.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

// The old /recognition route (client base64) is retired (410). Recognition runs on stored, verified
// photographs only and every attempt is a recorded run (budget-guarded, tracked downscale).
export type RecognitionRun = { id: string; status: string; failure_code: string | null; result: Record<string, unknown> | null;
  result_level: string | null; manufacturer: string | null; series: string | null; model: string | null; downscale_used?: boolean };
export async function startRecognitionRun(openingId: string, photoIds: string[], clientRequestId: string): Promise<{ run: RecognitionRun; replayed?: boolean }> {
  return authedFetch('/recognition/runs', { method: 'POST', body: JSON.stringify({ opening_id: openingId, photo_ids: photoIds, client_request_id: clientRequestId }) });
}

export type DoorHardwareItem = {
  id: string;
  ordinal: number;
  hardware_type: string;
  component_type: string;
  subtype: string | null;
  manufacturer: string | null;
  exact_model: string | null;
  finish: string | null;
  supporting_photos: number[];
  visible_evidence: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  next_photo: string | null;
  model_unknown: boolean;
  review_state?: string;
  hardware_component_id?: string | null;
};
export type DoorHardwareRun = {
  id: string;
  opening_id: string;
  status: string;
  failure_code: string | null;
  photo_count: number;
  items: DoorHardwareItem[];
};
export async function identifyDoorHardware(openingId: string, photoIds: string[], clientRequestId: string): Promise<{ run: DoorHardwareRun; replayed?: boolean }> {
  return authedFetch('/hardware-recognition/runs', { method: 'POST', body: JSON.stringify({ opening_id: openingId, photo_ids: photoIds, client_request_id: clientRequestId }) });
}
export async function confirmDoorHardware(runId: string, items: { id: string; include: boolean; component_type: string; subtype: string | null; manufacturer: string | null; model_number: string | null; finish: string | null }[]): Promise<{ run: DoorHardwareRun; training_labels?: number; hardware_components?: { id: string; tracker_id: string; component_type: string }[]; replayed?: boolean }> {
  return authedFetch(`/hardware-recognition/runs/${runId}/confirm`, { method: 'POST', body: JSON.stringify({ items }) });
}
export type StoredPhoto = { id: string; media_type: string; upload_state: string; content_type: string | null; byte_size: number | null; created_at: string; original_filename?: string | null };
export async function listOpeningPhotos(openingId: string): Promise<StoredPhoto[]> {
  return authedFetch(`/photos/by-opening/${encodeURIComponent(openingId)}`);
}

export class ApiError extends Error {
  status: number;
  reference?: string;
  constructor(status: number, message: string, reference?: string) {
    super(message);
    this.status = status;
    this.reference = reference;
  }
}

// Raised by this app, never by the server: the signed-in account on this device changed while a
// request for another account was being prepared or was in flight (the server may already have
// applied it). Kept distinct from server 401/403 refusals so it can be resumed safely, and only
// after that same account signs in again (see requeueAfterFreshSignIn).
export const ACTIVE_PRINCIPAL_CHANGED = "active_principal_changed";
export class PrincipalChangedError extends ApiError {
  readonly clientPrincipalChange = true as const;
  constructor() { super(401, ACTIVE_PRINCIPAL_CHANGED); }
}
export function isClientPrincipalChange(error: unknown): error is PrincipalChangedError {
  return error instanceof PrincipalChangedError;
}

// C2: raised after the server ended this account's access (401 session_revoked or 403
// account_deactivated) and all OI data on this device was wiped. Nothing is retried or stored.
export class SessionEndedError extends ApiError {
  readonly sessionEnded = true as const;
}
export function isSessionEnded(error: unknown): error is SessionEndedError {
  return error instanceof SessionEndedError;
}

export interface ExpectedPrincipal { userId: string; organizationId: string }

async function authedFetch(path: string, options: RequestInit = {}, expectedPrincipal?: ExpectedPrincipal, diagnostic=false) {
  const auth = await loadAuth();
  if (expectedPrincipal && (!auth || auth.userId !== expectedPrincipal.userId || auth.organizationId !== expectedPrincipal.organizationId)) {
    throw new PrincipalChangedError();
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (auth?.token) headers["Authorization"] = `Bearer ${auth.token}`;

  if (expectedPrincipal && options.method && !['GET','HEAD'].includes(options.method.toUpperCase())) assertSyncDispatchAllowed();
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if(diagnostic){
    const response=await readBoundedProbe(res);
    const current=await loadAuth();
    if(!auth||!current||current.userId!==auth.userId||current.organizationId!==auth.organizationId||current.role!==auth.role)throw new PrincipalChangedError();
    return response;
  }
  if (!res.ok) {
    if ((res.headers.get("content-type") || "").toLowerCase().startsWith("text/html")) {
      const text = await res.text();
      throw new ApiError(res.status, isNetlifyAccessResponse(res.status, res.headers.get("content-type") || "", text)
        ? SITE_ACCESS_REQUIRED : "unexpected_response");
    }
    const body = await res.json().catch(() => ({}));
    const endedReference = typeof body.reference === "string" && /^[0-9a-f-]{36}$/.test(body.reference) ? body.reference : undefined;
    if (res.status === 403 && body.error === "mfa_required") {
      const now = await loadAuth();
      if (auth && now && now.userId === auth.userId && now.organizationId === auth.organizationId && now.token === auth.token) await clearAuth();
    }
    if (endedReference && ((res.status === 401 && body.error === "session_revoked") || (res.status === 403 && body.error === "account_deactivated"))) {
      // C2: the API ended this account's access. Wipe all OI data on this device, but only while the
      // same account is still the one signed in here (never another person's data).
      const now = await loadAuth();
      if (auth && now && now.userId === auth.userId && now.organizationId === auth.organizationId && now.token === auth.token) {
        await wipeAllOiData();
        throw new SessionEndedError(res.status, body.error, endedReference);
      }
    }
    throw new ApiError(res.status, body.error || `request_failed_${res.status}`, typeof body.reference === "string" && /^[0-9a-f-]{36}$/.test(body.reference) ? body.reference : undefined);
  }
  const current=await loadAuth();
  if(!auth||!current||current.userId!==auth.userId||current.organizationId!==auth.organizationId)throw new PrincipalChangedError();
  if (res.status === 204) return null; // DELETE endpoints return no body
  return res.json();
}

// Only the candidate diagnostic imports this export. No new auth mechanism.
export async function runCandidatePhotoDiagnostic(principal:Principal){
  if(!diagnosticAvailable(__PHOTO_ISOLATION_ENABLED__,window.location.origin,API_BASE))throw Error('diagnostic_disabled');
  const current=await loadAuth();
  const actor=diagnosticActor(principal);
  if(!actor||!current||current.userId!==principal.userId||current.organizationId!==principal.organizationId||current.role!==principal.role)throw new PrincipalChangedError();
  return runPhotoProbes(actor,async path=>{
    if(!PROBES.includes(path))throw Error('diagnostic_path_refused');
    const before=await loadAuth();
    if(!before||before.userId!==principal.userId||before.organizationId!==principal.organizationId||before.role!==principal.role)throw new PrincipalChangedError();
    return authedFetch(path,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)},principal,true) as Promise<ProbeResponse>;
  });
}

export async function login(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || "login_failed", typeof body.reference === "string" && /^[0-9a-f-]{36}$/.test(body.reference) ? body.reference : undefined);
  }
  return res.json() as Promise<{ token?: string; expiresIn: string; mfa_required?: boolean; mfa_token?: string; resend_after_seconds?: number }>;
}

async function staffMfaFetch(mfaToken: string, path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${mfaToken}` },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, payload.error || "mfa_failed");
  return payload;
}

export function resendStaffSignInCode(mfaToken: string): Promise<{ sent: true; resend_after_seconds: number }> {
  return staffMfaFetch(mfaToken, "/auth/mfa/resend", {});
}

export function verifyStaffMfa(mfaToken: string, body: { code: string }): Promise<{ token: string }> {
  return staffMfaFetch(mfaToken, "/auth/mfa/verify", body);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/password-reset/request`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || "reset_request_failed");
}

// Decode the JWT payload client-side just to read organizationId/role for local
// storage - this is NOT a security boundary, the server verifies the signature.
export function decodeTokenPayload(token: string): { userId: string; organizationId: string; role: string; mustChangePassword: boolean } {
  const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { userId: payload.userId, organizationId: payload.organizationId, role: payload.role, mustChangePassword: payload.mustChangePassword === true };
}

// M4: companies this person may work in, and switching the active company (new token from the server).
export async function fetchCompanies(): Promise<{ active_organization_id: string; companies: import("./companySwitch").CompanyOption[] }> {
  const r = await authedFetch("/auth/companies", { method: "GET", cache: "no-store" });
  return { active_organization_id: r?.active_organization_id, companies: Array.isArray(r?.companies) ? r.companies : Array.isArray(r) ? r : [] };
}
export async function requestCompanySwitch(organizationId: string): Promise<{ token: string }> {
  return authedFetch("/auth/switch-company", { method: "POST", body: JSON.stringify({ organization_id: organizationId }) });
}

/** M5: UI hint only; the API enforces a required password change from the database. */
export function tokenRequiresPasswordChange(token: string | null | undefined): boolean {
  if (!token) return false;
  try { return decodeTokenPayload(token).mustChangePassword; } catch { return false; }
}

// M5: own profile (default facility) and password change.
export async function fetchMe(): Promise<{ id: string; role: string; must_change_password: boolean; default_property_id: string | null }> {
  return authedFetch("/auth/me", { method: "GET", cache: "no-store" });
}
export async function changePassword(current_password: string, new_password: string): Promise<{ token: string }> {
  return authedFetch("/auth/change-password", { method: "POST", body: JSON.stringify({ current_password, new_password }) });
}
export function changePasswordErrorMessage(code: string | undefined): string {
  switch (code) {
    case "password_too_short": return "Use at least 12 characters.";
    case "password_too_long": return "Use at most 72 characters.";
    case "password_unchanged": return "Choose a password different from the current one.";
    case "current_password_incorrect": return "Your current password isn't right.";
    default: return "Couldn't change the password. Check your connection and try again.";
  }
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
      // Network-level failure - try the cache. (Cache is keyed by opening id, not
      // qr_token, so this only helps if the opening was already viewed before.)
      throw err;
    }
    throw err;
  }
}

// For manual entry - a technician types the human-readable code printed on
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

// Uploads directly to storage using the presigned URL - bypasses our own API
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

export async function fetchHardwareForOpening(openingId: string, principal?: ExpectedPrincipal) {
  return authedFetch(`/hardware/by-opening/${openingId}`, {}, principal);
}

export async function editHardwareComponent(id: string, payload: any, principal?: ExpectedPrincipal) {
  return authedFetch(`/hardware/${id}`, { method: "PATCH", body: JSON.stringify(payload) }, principal);
}

export async function deleteHardwareComponent(id: string, principal?: ExpectedPrincipal) {
  return authedFetch(`/hardware/${id}`, { method: "DELETE" }, principal);
}

export async function listOpeningDocuments(openingId: string, principal?: ExpectedPrincipal) {
  return authedFetch(`/documents/by-opening/${openingId}`, {}, principal);
}

export async function sendHardwareToPurchasing(payload: {
  opening_id: string;
  hardware_component_id: string;
  note?: string;
  document_ids?: string[];
  uploads?: { filename: string; content_base64: string }[];
}, principal?: ExpectedPrincipal) {
  return authedFetch("/purchasing/send", { method: "POST", body: JSON.stringify(payload) }, principal);
}

export function fetchLabelConfig(principal: ExpectedPrincipal) { return authedFetch('/labels/config', {}, principal); }
export function fetchServiceRequestContext(id: string, principal: ExpectedPrincipal) { return authedFetch(`/service-requests/context/${id}`, {}, principal); }
export function submitServiceRequest(payload: Record<string, unknown>, principal: ExpectedPrincipal) {
  return authedFetch('/service-requests', {method:'POST',body:JSON.stringify(payload)}, principal);
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

// This requires connectivity - unlike service/inspection logging, work
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
export async function fetchLifecycle(openingId:string,principal:ExpectedPrincipal){return authedFetch('/lifecycle/'+encodeURIComponent(openingId),{},principal);}
export async function saveInstallationFact(command:unknown,principal:ExpectedPrincipal){return authedFetch('/lifecycle/installation-facts',{method:'POST',body:JSON.stringify(command)},principal);}
export async function saveLifecycleRecord(kind:string,command:unknown,principal:ExpectedPrincipal){return authedFetch('/lifecycle/'+kind,{method:'POST',body:JSON.stringify(command)},principal);}
export async function fetchConditionHistory(openingId:string,principal:ExpectedPrincipal){return authedFetch('/condition-history/'+encodeURIComponent(openingId),{},principal);}
export async function saveConditionObservation(command:unknown,principal:ExpectedPrincipal){return authedFetch('/condition-history/observations',{method:'POST',body:JSON.stringify(command)},principal);}

export interface FieldFacilitySchedule {
  id: string;
  kind: "door" | "hardware";
  title: string;
  head_version: number;
  versions: { id: string; version: number; original_filename: string; uploaded_at: string }[];
}

// Read-only: the facility's uploaded door / hardware schedules for an opening.
export async function fetchFacilitySchedulesForOpening(openingId: string): Promise<FieldFacilitySchedule[]> {
  return authedFetch(`/facility-schedules/by-opening/${encodeURIComponent(openingId)}`);
}

// Server-reported optional features; fails closed (off) on any error.
export async function serverFeatures(): Promise<{ recognition: boolean }> {
  try { const f = await authedFetch('/features'); return { recognition: f?.recognition === true }; } catch { return { recognition: false }; }
}
