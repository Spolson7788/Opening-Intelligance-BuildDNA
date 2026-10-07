import {requireRecognitionResult} from './recognitionResponse';
import {OFFLINE_SCHEMA_VERSION,SYNC_PROTOCOL_VERSION} from './offlineTypes';
import { loadAuth, cacheOpening, getCachedOpening } from "./db";
import {isUnverifiedSiteAccess, readResponseBody, requestPreviewAccess} from './previewAccess';

// Point this at your deployed API. Left as a relative path + env var so it works
// both in local dev (via Vite proxy) and once deployed.
const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export async function recognizeHardware(openingId:string,images:string[],mediaType:string,attributes:Record<string,string>={},onRecovery?:()=>void,photoIds?:string[]) {
  const principal=await loadAuth();if(!principal)throw new ApiError(401,'missing_token');
  const requestId=crypto.randomUUID();
  try{return requireRecognitionResult(await authedFetch('/recognition',{method:'POST',body:JSON.stringify({request_id:requestId,opening_id:openingId,...(photoIds?{photo_ids:photoIds}:{images}),media_type:mediaType,technician_attributes:attributes})},principal));}
  catch(error){
    if(!(error instanceof ApiError)||error.status!==504||error.hostingAccessRequired)throw error;
    onRecovery?.();
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const result=await authedFetch(`/recognition/request/${requestId}?opening_id=${encodeURIComponent(openingId)}`,{signal:AbortSignal.timeout(5000)},principal);
      if(result?.run_id&&result.request_id===requestId)return requireRecognitionResult(result);
      if(result?.status!=='awaiting_saved_result')throw new ApiError(502,'recognition_recovery_invalid_response');
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    throw new ApiError(504,'recognition_saved_result_not_found');
  }
}
export const fetchReferencePage=(hash:string,n:number)=>authedFetch(`/references/${encodeURIComponent(hash)}/pages/${n}`);
export const fetchRecognitionRuns=(openingId:string)=>authedFetch(`/recognition/opening/${encodeURIComponent(openingId)}`);
export const fetchProductCatalog=()=>authedFetch('/hardware/catalog') as Promise<{products:{manufacturer:string;model_number:string;series:string|null}[]}>;
export const fetchPurchasingRequests=(openingId:string)=>authedFetch(`/purchasing/requests/opening/${encodeURIComponent(openingId)}`);
export const preparePurchasingRequest=(body:{request_id:string;opening_id:string;recipient_email:string;acknowledged:true})=>authedFetch('/purchasing/requests',{method:'POST',body:JSON.stringify(body)});
export const confirmPurchasingEmailSent=(id:string)=>authedFetch(`/purchasing/requests/${encodeURIComponent(id)}/email-sent`,{method:'POST',body:JSON.stringify({email_sent:true})});

export class ApiError extends Error {
  status: number;
  reference?: string;
  providerDiagnostic?: string;
  hostingAccessRequired: boolean;
  constructor(status: number, message: string, reference?: string, hostingAccessRequired = false) {
    super(message);
    this.status = status;
    this.reference = reference;
    this.hostingAccessRequired = hostingAccessRequired;
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

export interface ExpectedPrincipal { userId: string; organizationId: string }

async function authedFetch(path: string, options: RequestInit = {}, expectedPrincipal?: ExpectedPrincipal) {
  const auth = await loadAuth();
  if (expectedPrincipal && (!auth || auth.userId !== expectedPrincipal.userId || auth.organizationId !== expectedPrincipal.organizationId)) {
    throw new PrincipalChangedError();
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (auth?.token) headers["Authorization"] = `Bearer ${auth.token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    throw await responseFailure(res);
  }
  const current=await loadAuth();
  if(!auth||!current||current.userId!==auth.userId||current.organizationId!==auth.organizationId)throw new PrincipalChangedError();
  if (res.status === 204) return null; // DELETE endpoints return no body
  return res.json();
}

export async function login(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw await responseFailure(res);
  }
  return res.json() as Promise<{ token: string; expiresIn: string }>;
}

async function responseFailure(response: Response): Promise<ApiError> {
  const body = await readResponseBody(response);
  const hosting = isUnverifiedSiteAccess(response, body);
  if (hosting) requestPreviewAccess();
  const error=new ApiError(response.status,
    hosting ? 'Staging website access needs renewal. Use Renew staging access above.' : body?.error || `request_failed_${response.status}`,
    typeof body?.reference === 'string' && /^[0-9a-f-]{36}$/i.test(body.reference) ? body.reference : undefined,
    hosting);
  if(typeof body?.provider_diagnostic==='string')error.providerDiagnostic=body.provider_diagnostic.slice(0,400);
  return error;
}

// Check the actual protected server, not the service worker's cached app shell.
// No password is sent, and no failed POST is retried automatically.
export async function checkPreviewAccess() {
  const response = await fetch('/health', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw await responseFailure(response);
  const body = await readResponseBody(response);
  if (body?.status !== 'ok') throw new ApiError(503, 'Website access check is unavailable.');
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

export const fetchRecognitionAvailability=()=>authedFetch('/recognition/availability');
export const checkSavedRecognitionOriginals=(openingId:string)=>authedFetch('/recognition/originals/check',{method:'POST',body:JSON.stringify({opening_id:openingId})});

export async function uploadRecognitionOriginals(openingId:string,files:File[],deviceId:string,onProgress?:(message:string)=>void){
 const principal=await loadAuth();if(!principal)throw new ApiError(401,'missing_token');
 const ids:string[]=[];
 for(const [index,file] of files.entries()){
  onProgress?.(`Preserving original photograph ${index+1} of ${files.length}…`);
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  const checksum=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  const photoId=crypto.randomUUID(),operationId=crypto.randomUUID();
  const reservation=await reserveOfflinePhoto({photo_id:photoId,client_operation_id:operationId,opening_id:openingId,target_type:'opening',target_id:openingId,original_filename:file.name,content_type:file.type,byte_size:file.size,sha256_checksum:checksum,device_id:deviceId},principal);
  if(reservation.upload_url)await uploadPrivatePhoto(reservation.upload_url,file,file.type,checksum,photoId);
  await confirmOfflinePhoto({photo_id:photoId,client_operation_id:operationId,schema_version:OFFLINE_SCHEMA_VERSION,app_version:'recognition-original-input-1',protocol_version:SYNC_PROTOCOL_VERSION},principal);
  ids.push(photoId);
 }
 return ids;
}
