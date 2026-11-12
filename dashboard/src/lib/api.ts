import { handleUnauthorized } from "./session";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export class ApiError extends Error {
  status: number;
  reference?: string;
  constructor(status: number, message: string, reference?: string) {
    super(message);
    this.status = status;
    this.reference = reference;
  }
}

function getToken() {
  return localStorage.getItem("oi_token");
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem("oi_token", token);
  else localStorage.removeItem("oi_token");
}

// M3: combined (parent company) view. When on, every READ asks the API for the company tree
// (X-OI-Scope: tree). Writes never carry it: the API always writes to the one active company.
let treeScope = false;
export function setTreeScope(on: boolean) { treeScope = on; }
export function isTreeScope() { return treeScope; }
export function scopeHeaders(method = "GET"): Record<string, string> {
  return treeScope && (method === "GET" || method === "HEAD") ? { "X-OI-Scope": "tree" } : {};
}

async function authedFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...scopeHeaders((options.method ?? "GET").toUpperCase()),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    // The app rejected the session (expired, revoked or invalid): clear it and go to sign-in.
    handleUnauthorized(typeof localStorage !== "undefined" ? localStorage : null,
      typeof window !== "undefined" ? { pathname: window.location.pathname, assign: (u) => window.location.assign(u) } : null,
      import.meta.env.BASE_URL || "/");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && body.error === "mfa_required") {
      handleUnauthorized(typeof localStorage !== "undefined" ? localStorage : null,
        typeof window !== "undefined" ? { pathname: window.location.pathname, assign: (u) => window.location.assign(u) } : null,
        import.meta.env.BASE_URL || "/");
    }
    throw new ApiError(res.status, body.error || `request_failed_${res.status}`);
  }
  if (res.status === 204) return null; // no current caller uses this yet, but avoids the same crash the field app had
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
    // The app's login route always returns a UUID reference; the hosting gate never does.
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

export interface Opening {
  id: string;
  opening_code: string;
  building_id: string;
  floor_label: string | null;
  location_description: string | null;
  opening_type: string;
  fire_rated: boolean;
  life_safety_critical: boolean;
  is_electrified: boolean;
  health_score: number | null;
  status: string;
  opening_configuration: "single" | "pair";
  completion_state: "draft" | "complete";
}

export interface Building {
  id: string;
  name: string;
}

export interface Property {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  state_code?: string | null;
  county_fips?: string | null;
  state_name?: string | null;
  county_name?: string | null;
  buildings: Building[];
  /** True when the caller's organization owns this facility (server-computed). */
  is_owner?: boolean;
  /** Absent before migration 20261029100000; treated as off. */
  share_provider_service_history?: boolean;
}

export async function setProviderHistorySharing(propertyId: string, enabled: boolean): Promise<{ id: string; share_provider_service_history: boolean }> {
  return authedFetch(`/portfolio/properties/${propertyId}/provider-history-sharing`, { method: "PUT", body: JSON.stringify({ enabled }) });
}

export interface TeamMember {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "facilities_manager" | "technician" | "inspector" | "viewer";
  is_active: boolean;
  created_at: string;
  must_change_password?: boolean;
  is_test_account?: boolean;
  default_property_id?: string | null;
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  return authedFetch("/auth/users");
}

export async function updateTeamMember(id: string, payload: { role?: string; is_active?: boolean }): Promise<TeamMember> {
  return authedFetch(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export interface AuditLogEntry {
  organization_id?: string;
  id: string;
  action: string;
  method: string;
  path: string;
  request_body: Record<string, unknown> | null;
  status_code: number;
  created_at: string;
  user_id: string;
  user_full_name: string;
  user_email: string;
}

export async function fetchAuditLog(limit = 100): Promise<AuditLogEntry[]> {
  return authedFetch(`/audit-log?limit=${limit}`);
}

export interface DocumentEntry {
  id: string;
  property_id: string | null;
  opening_id: string | null;
  document_type: "warranty" | "service_contract" | "insurance" | "inspection_report" | "other";
  title: string;
  storage_url: string;
  file_size_bytes: number | null;
  created_at: string;
  inspection_event_id?: string | null;
}

export async function fetchDocumentsForOpening(openingId: string): Promise<DocumentEntry[]> {
  return authedFetch(`/documents/by-opening/${openingId}`);
}

export async function uploadDocumentForOpening(
  openingId: string,
  file: File,
  documentType: string,
  title: string
): Promise<DocumentEntry> {
  const presign = await authedFetch("/documents/presign", {
    method: "POST",
    body: JSON.stringify({ opening_id: openingId, content_type: file.type }),
  });
  const putRes = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!putRes.ok) throw new ApiError(putRes.status, "upload_failed");
  return authedFetch("/documents", {
    method: "POST",
    body: JSON.stringify({
      opening_id: openingId,
      document_type: documentType,
      title,
      storage_url: presign.storageUrl,
      file_size_bytes: file.size,
    }),
  });
}

export async function deleteDocument(id: string): Promise<void> {
  return authedFetch(`/documents/${id}`, { method: "DELETE" });
}

export async function fetchPhotoAccessUrl(id: string): Promise<{ url: string; expires_in_seconds: number }> {
  return authedFetch(`/photos/${id}/access`);
}

export interface WorkOrder {
  id: string;
  opening_id: string;
  opening_code: string;
  building_name: string;
  property_name: string;
  property_id: string;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due_date: string | null;
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  assigned_to_email: string | null;
  created_by_name: string;
  created_at: string;
  completed_at: string | null;
}

export async function listWorkOrders(params: Record<string, string> = {}): Promise<WorkOrder[]> {
  const qs = new URLSearchParams(params).toString();
  return authedFetch(`/work-orders${qs ? `?${qs}` : ""}`);
}

export async function createWorkOrder(payload: {
  opening_id: string;
  title: string;
  description?: string;
  priority?: string;
  due_date?: string;
  assigned_to_user_id?: string;
}): Promise<WorkOrder> {
  return authedFetch("/work-orders", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateWorkOrder(id: string, payload: Record<string, unknown>): Promise<WorkOrder> {
  return authedFetch(`/work-orders/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export async function updateWorkOrderStatus(id: string, status: string): Promise<WorkOrder> {
  return authedFetch(`/work-orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

export interface MaintenanceSchedule {
  id: string;
  opening_id: string;
  opening_code: string;
  building_name: string;
  property_name: string;
  title: string;
  description: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  assigned_to_user_id: string | null;
  assigned_to_name: string | null;
  interval_unit: "days" | "weeks" | "months" | "years";
  interval_count: number;
  next_due_date: string;
  is_active: boolean;
  last_generated_at: string | null;
}

export async function listMaintenanceSchedules(): Promise<MaintenanceSchedule[]> {
  return authedFetch("/maintenance-schedules");
}

export async function createMaintenanceSchedule(payload: {
  opening_id: string;
  title: string;
  description?: string;
  priority?: string;
  assigned_to_user_id?: string;
  interval_unit: string;
  interval_count: number;
  start_date?: string;
}): Promise<MaintenanceSchedule> {
  return authedFetch("/maintenance-schedules", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateMaintenanceSchedule(id: string, payload: Record<string, unknown>): Promise<MaintenanceSchedule> {
  return authedFetch(`/maintenance-schedules/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export async function triggerDueMaintenance(): Promise<{ generated: number }> {
  return authedFetch("/maintenance-schedules/generate-due", { method: "POST" });
}

export async function downloadOpeningsCsv(params: Record<string, string> = {}) {
  const qs = new URLSearchParams(params).toString();
  const token = getToken();
  const res = await fetch(`${API_BASE}/export/openings.csv${qs ? `?${qs}` : ""}`, {
    headers: { ...scopeHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new ApiError(res.status, "export_failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `openings-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function downloadComplianceReport(propertyId: string, scope: "fire_safety" | "all" = "fire_safety") {
  const token = getToken();
  const params = scope === "all" ? "&scope=all" : "";
  const res = await fetch(`${API_BASE}/export/compliance-report.pdf?property_id=${propertyId}${params}`, {
    headers: { ...scopeHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || "report_failed");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `compliance-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function downloadCapitalForecastPdf(propertyId: string | null, costs: Record<string, number>) {
  const token = getToken();
  const params = new URLSearchParams();
  if (propertyId) params.set("property_id", propertyId);
  params.set("costs", JSON.stringify(costs));
  const res = await fetch(`${API_BASE}/export/capital-forecast.pdf?${params.toString()}`, {
    headers: { ...scopeHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || "report_failed");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `capital-forecast-${propertyId ? "" : "portfolio-"}${new Date().toISOString().slice(0, 10)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function listProperties(): Promise<Property[]> {
  return authedFetch("/portfolio/properties");
}

export interface Portfolio {
  id: string;
  name: string;
}

export async function listPortfolios(): Promise<Portfolio[]> {
  return authedFetch("/portfolio/portfolios");
}

export async function createProperty(payload: {
  portfolio_id: string;
  name: string;
  address_line1?: string;
  city?: string;
  state?: string;
  state_code?: string;
  county_fips?: string;
  postal_code?: string;
  property_type?: string;
}) {
  return authedFetch("/portfolio/properties", { method: "POST", body: JSON.stringify(payload) });
}

export async function createBuilding(payload: { property_id: string; name: string }) {
  return authedFetch("/portfolio/buildings", { method: "POST", body: JSON.stringify(payload) });
}

export async function createOpening(payload: {
  opening_code: string;
  building_id: string;
  opening_type: string;
  floor_label?: string;
  location_description?: string;
  fire_rated?: boolean;
  life_safety_critical?: boolean;
  is_electrified?: boolean;
  install_date?: string;
  opening_configuration?: "single" | "pair";
}) {
  return authedFetch("/openings", { method: "POST", body: JSON.stringify(payload) });
}

export interface BulkImportRow {
  opening_code: string;
  opening_type: string;
  floor_label?: string;
  location_description?: string;
  fire_rated?: boolean;
  life_safety_critical?: boolean;
  is_electrified?: boolean;
  install_date?: string;
}

export interface BulkImportResult {
  total: number;
  created: number;
  failed: number;
  results: Array<{ row: number; opening_code: string; status: "created" | "error"; id?: string; error?: string }>;
}

export async function bulkImportOpenings(buildingId: string, rows: BulkImportRow[]): Promise<BulkImportResult> {
  return authedFetch("/openings/bulk-import", {
    method: "POST",
    body: JSON.stringify({ building_id: buildingId, rows }),
  });
}

export interface BulkImportHardwareRow {
  opening_code: string;
  component_type: string;
  manufacturer?: string;
  model_number?: string;
  finish?: string;
  install_date?: string;
  warranty_expiration?: string;
  notes?: string;
  unit_cost?: number;
  supplier_name?: string;
  supplier_contact?: string;
  serial_number?: string;
  carrier?: string;
  tracking_number?: string;
  shipment_status?: string;
  expected_delivery_date?: string;
  shipped_date?: string;
  delivered_date?: string;
}

export interface BulkImportHardwareResult {
  total: number;
  created: number;
  failed: number;
  results: Array<{ row: number; opening_code: string; component_type: string; status: "created" | "error"; id?: string; error?: string }>;
}

export async function bulkImportHardware(rows: BulkImportHardwareRow[]): Promise<BulkImportHardwareResult> {
  return authedFetch("/hardware/bulk-import", {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}

export interface QrLabelItem {
  facility_name: string;
  building_name: string;
  payload: string;
  id: string;
  opening_code: string;
  opening_type: string;
  floor_label: string | null;
  location_description: string | null;
  qr_data_url: string;
}

export async function fetchQrCodesForBuilding(buildingId: string): Promise<{ count: number; items: QrLabelItem[]; blocked: { id: string; opening_code: string; missing: string[] }[] }> {
  return authedFetch(`/openings/qr-codes?building_id=${buildingId}`);
}

export interface CapitalForecastBucket {
  label: string;
  total: number;
  by_type: Record<string, number>;
  needing_estimate_by_type: Record<string, number>;
  known_cost_total: number;
}

export interface CapitalForecastResult {
  property_name: string;
  total_openings: number;
  buckets: Record<"urgent" | "near_term" | "healthy" | "unassessed", CapitalForecastBucket>;
}

export async function fetchCapitalForecast(propertyId: string): Promise<CapitalForecastResult> {
  return authedFetch(`/portfolio/capital-forecast?property_id=${propertyId}`);
}

export interface CapitalForecastRollupProperty extends CapitalForecastResult {
  property_id: string;
}

export async function fetchCapitalForecastRollup(): Promise<{ properties: CapitalForecastRollupProperty[] }> {
  return authedFetch("/portfolio/capital-forecast/rollup");
}

export interface ComplianceAlert {
  id: string;
  opening_code: string;
  floor_label: string | null;
  location_description: string | null;
  fire_rated: boolean;
  life_safety_critical: boolean;
  building_name: string;
  property_name: string;
  property_id: string;
  last_inspection_date: string | null;
  alert_level: "never_inspected" | "overdue" | "due_soon";
}

export interface ComplianceAlertsResult {
  total_flagged: number;
  counts: { never_inspected: number; overdue: number; due_soon: number };
  alerts: ComplianceAlert[];
}

export async function fetchComplianceAlerts(propertyId?: string): Promise<ComplianceAlertsResult> {
  const qs = propertyId ? `?property_id=${propertyId}` : "";
  return authedFetch(`/portfolio/compliance-alerts${qs}`);
}

export interface WarrantyAlert {
  hardware_id: string;
  component_type: string;
  manufacturer: string | null;
  model_number: string | null;
  tracker_id: string;
  warranty_expiration: string;
  opening_id: string;
  opening_code: string;
  building_name: string;
  property_name: string;
  property_id: string;
  alert_level: "expired" | "expiring_soon";
}

export interface WarrantyAlertsResult {
  total_flagged: number;
  counts: { expired: number; expiring_soon: number };
  alerts: WarrantyAlert[];
}

export async function fetchWarrantyAlerts(propertyId?: string): Promise<WarrantyAlertsResult> {
  const qs = propertyId ? `?property_id=${propertyId}` : "";
  return authedFetch(`/portfolio/warranty-alerts${qs}`);
}

export interface OpeningDetail extends Opening {
  completed_at: string | null;
  frame: OpeningFrame | null;
  door_leaves: DoorLeaf[];
  hardware_components: HardwareComponent[];
  service_events: any[];
  inspection_events: any[];
  photos: OpeningPhoto[];
  purchasing_sends?: Array<{ id: string; sent_to: string; note: string | null; delivery_mode: string; created_at: string }>;
  fire_door_deficiencies?: Array<{ id: string; item_key: string; note: string; status: string; repair_note: string | null }>;
}

export interface OpeningFrame {
  id: string;
  material: string | null;
  frame_type: string | null;
  width_in: number | null;
  height_in: number | null;
  condition: string;
}

export interface DoorLeaf {
  id: string;
  leaf_role: "single" | "active" | "inactive";
  handing: string | null;
  material: string | null;
  width_in: number | null;
  height_in: number | null;
  thickness_in: number | null;
  condition: string;
}

export interface HardwareComponent {
  id: string;
  tracker_id: string | null;
  serial_number: string | null;
  component_type: string;
  manufacturer: string | null;
  model_number: string | null;
  install_date: string | null;
  unit_cost: number | null;
  supplier_name: string | null;
  supplier_contact: string | null;
  shipment_status: string | null;
  carrier: string | null;
  tracking_number: string | null;
  mounting_scope: "opening" | "frame" | "door_leaf";
  door_leaf_id: string | null;
  frame_id: string | null;
  position_label: string | null;
  condition: "good" | "worn" | "failed" | "unverified";
  identity_status: "established" | "unresolved";
  review_state: "pending" | "reviewed";
  replacement_required: boolean;
}

export interface OpeningPhoto {
  id: string;
  media_type: "photo" | "video";
  storage_url: string;
  entity_type: string;
  related_entity_type?: string | null;
  frame_id: string | null;
  door_leaf_id: string | null;
  hardware_component_id: string | null;
}

export interface PurchasingEligibility {
  opening_id: string;
  opening_complete: boolean;
  decisions: Array<{ component_id: string; eligible: boolean; reasons: string[] }>;
}

export async function fetchOpening(id: string): Promise<OpeningDetail> {
  return authedFetch(`/openings/${id}`);
}

export async function fetchPurchasingEligibility(id: string): Promise<PurchasingEligibility> {
  return authedFetch(`/openings/${id}/purchasing-eligibility`);
}

export async function listOpenings(params: Record<string, string> = {}): Promise<Opening[]> {
  const qs = new URLSearchParams(params).toString();
  return authedFetch(`/openings${qs ? `?${qs}` : ""}`);
}

export function decodeTokenPayload(token: string): { userId: string; organizationId: string; role: string; mustChangePassword: boolean } {
  const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { userId: payload.userId, organizationId: payload.organizationId, role: payload.role, mustChangePassword: payload.mustChangePassword === true };
}

export interface FacilityScheduleVersion {
  id: string;
  version: number;
  original_filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  uploaded_by_organization_id: string;
  uploaded_at: string;
}

export interface FacilitySchedule {
  id: string;
  kind: "door" | "hardware";
  title: string;
  head_version: number;
  created_at: string;
  archived_at?: string | null;
  versions: FacilityScheduleVersion[];
}

export const FACILITY_SCHEDULE_MAX_BYTES = 25 * 1024 * 1024;

export async function listFacilitySchedules(propertyId: string, includeArchived = false): Promise<FacilitySchedule[]> {
  return authedFetch(`/facility-schedules/by-property/${propertyId}${includeArchived ? "?include_archived=1" : ""}`);
}

// M3B: correct a schedule's type, archive / unarchive it.
export async function changeScheduleKind(id: string, body: { kind: "door" | "hardware"; reason: string; acknowledge_mismatch?: boolean }):
  Promise<{ id: string; kind: string; previous_kind: string; stale_draft_import_ids: string[] }> {
  return authedFetch(`/facility-schedules/${id}/kind`, { method: "POST", body: JSON.stringify(body) });
}
export async function archiveSchedule(id: string, reason?: string) {
  return authedFetch(`/facility-schedules/${id}/archive`, { method: "POST", body: JSON.stringify(reason ? { reason } : {}) });
}
export async function unarchiveSchedule(id: string) {
  return authedFetch(`/facility-schedules/${id}/unarchive`, { method: "POST", body: JSON.stringify({}) });
}

export interface ScheduleImportListItem {
  id: string; building_id: string; building_name: string; door_version_id: string; hardware_version_id: string | null;
  status: string; created_at: string; confirmed_at: string | null; stale?: boolean;
}

export async function listScheduleImports(propertyId: string): Promise<ScheduleImportListItem[]> {
  return authedFetch(`/schedule-imports/by-property/${propertyId}`);
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same two-step presigned pattern as documents: bytes go straight to storage.
export async function uploadFacilitySchedule(input: {
  propertyId: string;
  kind: "door" | "hardware";
  title: string;
  file: File;
  scheduleId?: string;
}) {
  const sha256 = await sha256Hex(input.file);
  const contentType = input.file.type || (input.file.name.toLowerCase().endsWith(".csv") ? "text/csv" : "");
  const base = { property_id: input.propertyId, kind: input.kind, content_type: contentType, byte_size: input.file.size, sha256 };
  const presign = await authedFetch("/facility-schedules/presign", { method: "POST", body: JSON.stringify(base) });
  const putRes = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: input.file });
  if (!putRes.ok) throw new ApiError(putRes.status, "upload_failed");
  return authedFetch("/facility-schedules", {
    method: "POST",
    body: JSON.stringify({ ...base, title: input.title, original_filename: input.file.name, storage_key: presign.key,
      ...(input.scheduleId ? { schedule_id: input.scheduleId } : {}) }),
  });
}

// M2 schedule imports
export type ScheduleImportResolutions = {
  rows?: Record<string, { skip?: boolean; mark?: string }>;
  set_map?: Record<string, string | null>;
  row_sets?: Record<string, string | null>;
  accept_items?: string[];
  overwrite?: string[];
};
export interface ScheduleImportIssue { code: string; severity: "blocker" | "warning" | "info"; message: string; row_ids?: string[]; item_ids?: string[]; key?: string; variants?: string[]; unresolved_row_ids?: string[] }
export interface ScheduleFieldChange { entity: string; entity_id: string | null; field: string; from: unknown; to: unknown; status: string; overwrite_key: string | null }
export interface ScheduleOpeningPlan { row_id: string; source_row: number; mark: string | null; action: string; skip_reason?: string; opening_id: string | null;
  fields: ScheduleFieldChange[]; hardware: { item_id: string; description: string; action: string; component_type: string; qty: number | null }[];
  set_key?: string | null;
  variant_choice: { group: string; options: string[]; chosen: string | null; pending: boolean } | null;
  follow_up: { reason: string; detail: string | null } | null }
export interface ScheduleImportPreview {
  import: { id: string; status: "draft" | "confirmed"; building_id: string; property_id: string; stale?: boolean };
  rows?: { id: string; source_row: number; room_name: string | null; door_mark: string | null }[];
  sets?: { set_key: string; items: { id: string; description: string; catalog_raw: string | null; manufacturer_raw: string | null; review_reasons: string[] }[] }[];
  plan?: { issues: ScheduleImportIssue[]; openings: ScheduleOpeningPlan[]; summary: Record<string, number>; blocked: boolean };
  result?: Record<string, unknown>;
}
export async function createScheduleImport(body: { building_id: string; door_version_id: string; hardware_version_id?: string }): Promise<{ id: string }> {
  return authedFetch("/schedule-imports", { method: "POST", body: JSON.stringify(body) });
}
export async function fetchScheduleImport(id: string): Promise<ScheduleImportPreview> {
  return authedFetch(`/schedule-imports/${id}`);
}
export async function previewScheduleImport(id: string, resolutions: ScheduleImportResolutions): Promise<ScheduleImportPreview> {
  return authedFetch(`/schedule-imports/${id}/preview`, { method: "POST", body: JSON.stringify({ resolutions }) });
}
export async function confirmScheduleImport(id: string, resolutions: ScheduleImportResolutions) {
  return authedFetch(`/schedule-imports/${id}/confirm`, { method: "POST", body: JSON.stringify({ resolutions }) });
}

// M2C schedule follow-ups
export interface ScheduleFollowUp {
  id: string; import_id: string; row_id: string; opening_id: string; reason: string; detail: string | null; status: "open" | "resolved";
  created_at: string; resolved_at: string | null; resolved_by_user_id: string | null; resolution_note: string | null;
  door_mark: string | null; opening_code: string; building_id: string; building_name: string; import_confirmed_at: string | null;
}
export async function listScheduleFollowUps(propertyId: string, status: "open" | "resolved" | "all" = "open"): Promise<ScheduleFollowUp[]> {
  return authedFetch(`/schedule-imports/follow-ups/by-property/${propertyId}?status=${status}`);
}
export async function resolveScheduleFollowUp(id: string, note: string): Promise<ScheduleFollowUp> {
  return authedFetch(`/schedule-imports/follow-ups/${id}/resolve`, { method: "POST", body: JSON.stringify({ note }) });
}

// M4: schedule vs field comparison snapshots (read-only once saved).
export interface ComparisonSnapshotListItem { id: string; import_id: string; engine_version: number; summary: Record<string, number>; opening_count: number; line_count: number;
  created_at: string; created_by_role: string; created_by_name: string | null; building_name?: string }
export interface ComparisonSnapshot extends ComparisonSnapshotListItem { building_name: string; results: import("./comparisonUi").ComparisonOpening[] }
export async function listComparisonSnapshots(importId: string): Promise<{ import: { id: string; status: string; building_name: string }; snapshots: ComparisonSnapshotListItem[] }> {
  return authedFetch(`/schedule-comparisons/by-import/${importId}`);
}
export interface ComparisonReportItem { import_id: string; confirmed_at: string | null; property_name: string; building_id: string; building_name: string;
  latest_snapshot_id: string | null; latest_snapshot_at: string | null; latest_summary: Record<string, number> | null; latest_engine_version: number | null }
export async function listComparisonReports(): Promise<{ imports: ComparisonReportItem[] }> {
  return authedFetch("/schedule-comparisons");
}
export async function runComparison(importId: string): Promise<ComparisonSnapshotListItem> {
  return authedFetch(`/schedule-comparisons/by-import/${importId}`, { method: "POST", body: "{}" });
}
export async function fetchComparisonSnapshot(id: string): Promise<ComparisonSnapshot> {
  return authedFetch(`/schedule-comparisons/${id}`);
}
export async function downloadComparisonCsv(id: string) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/schedule-comparisons/${id}/csv`, { headers: { ...scopeHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!res.ok) throw new ApiError(res.status, "export_failed");
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "schedule-comparison.csv";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
// ---- M5: add team member, email invites, change password ----
export interface TeamInvite {
  id: string;
  email: string;
  full_name: string;
  role: TeamMember["role"];
  default_property_id: string | null;
  expires_at: string;
  created_at: string;
  last_sent_at: string | null;
  email_status: "pending" | "sent" | "not_configured" | "failed";
  expired?: boolean;
}
export interface InviteSendResult { invite: TeamInvite; email: { sent: boolean; status: TeamInvite["email_status"] } }

export async function addTeamMember(payload: {
  full_name: string; email: string; role: string; temporary_password: string; is_test_account: boolean; default_property_id?: string | null;
}): Promise<TeamMember> {
  return authedFetch("/members", { method: "POST", body: JSON.stringify(payload) });
}
export async function listTeamInvites(): Promise<{ invites: TeamInvite[]; email_configured: boolean }> {
  return authedFetch("/members/invites");
}
export async function createTeamInvite(payload: { full_name: string; email: string; role: string; default_property_id?: string | null }): Promise<InviteSendResult> {
  return authedFetch("/members/invites", { method: "POST", body: JSON.stringify(payload) });
}
export async function resendTeamInvite(id: string): Promise<InviteSendResult> {
  return authedFetch(`/members/invites/${id}/resend`, { method: "POST", body: "{}" });
}
export async function revokeTeamInvite(id: string): Promise<TeamInvite> {
  return authedFetch(`/members/invites/${id}/revoke`, { method: "POST", body: "{}" });
}
export async function fetchMe(): Promise<{ id: string; email: string; full_name: string; role: string; must_change_password: boolean; is_test_account: boolean; default_property_id: string | null }> {
  return authedFetch("/auth/me");
}
export async function changePassword(current_password: string, new_password: string): Promise<{ token: string }> {
  return authedFetch("/auth/change-password", { method: "POST", body: JSON.stringify({ current_password, new_password }) });
}
export async function requestPasswordReset(email: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/password-reset/request`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || "reset_request_failed");
}
export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/password-reset/confirm`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }),
  });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || "reset_confirmation_failed");
}
async function publicPost(path: string, body: unknown) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error || `request_failed_${res.status}`);
  return json;
}
export async function previewInvite(token: string): Promise<{ email: string; full_name: string; role: string; organization_name: string; expires_at: string }> {
  return publicPost("/invites/preview", { token });
}
export async function acceptInvite(token: string, password: string): Promise<{ token: string }> {
  return publicPost("/invites/accept", { token, password });
}
export const PASSWORD_RULE = "12 to 72 characters.";
export function passwordErrorMessage(code: string | undefined): string {
  switch (code) {
    case "password_too_short": return "Use at least 12 characters.";
    case "password_too_long": return "Use at most 72 characters.";
    case "password_unchanged": return "Choose a password different from the current one.";
    case "current_password_incorrect": return "Your current password isn't right.";
    case "invite_invalid_or_expired": return "This invite link is invalid, used, revoked or expired. Ask your admin to resend it.";
    case "email_already_registered": return "That email is already registered.";
    default: return "Something went wrong. Check your connection and try again.";
  }
}
// ---- M3: companies and locations ----
export interface CompanyChoice { organization_id: string; name: string; role: string; is_home: boolean; access?: string }
export interface LocationCompany { id: string; name: string; parent_organization_id: string | null; access: "member" | "tree_admin" | "tree_view"; role: string }
export interface LocationFacility { id: string; name: string; organization_id: string | null; building_ids: string[]; state_code?: string | null; county_fips?: string | null; state_name?: string | null; county_name?: string | null }

export async function listStates(): Promise<{ code: string; name: string }[]> {
  return authedFetch("/geo/states");
}
export async function listCounties(stateCode: string): Promise<{ fips: string; state_code: string; name: string }[]> {
  return authedFetch(`/geo/counties?state_code=${encodeURIComponent(stateCode)}`);
}
export async function fetchCoverage(): Promise<{
  facilities: Property[];
  branches: { id: string; name: string; default_state: string; areas: { id: string; state_code: string; county_fips: string | null; state_name: string; county_name: string | null }[] }[];
  technicians: { id: string; full_name: string; branch_id: string | null; areas: { id: string; state_code: string; county_fips: string | null; state_name: string; county_name: string | null }[] }[];
  assignments: { property_id: string; property_name: string; provider_organization_id: string; provider_name: string; state_name: string | null; county_name: string | null }[];
}> {
  return authedFetch("/geo/coverage");
}
export async function saveFacilityCounty(id: string, state_code: string | null, county_fips: string | null) {
  return authedFetch(`/geo/facilities/${id}`, { method: "PATCH", body: JSON.stringify({ state_code, county_fips }) });
}
export async function addBranchArea(branchId: string, state_code: string, county_fips: string | null) {
  return authedFetch(`/geo/branches/${branchId}/areas`, { method: "POST", body: JSON.stringify({ state_code, county_fips }) });
}
export async function addTechnicianArea(userId: string, state_code: string, county_fips: string | null) {
  return authedFetch(`/geo/technicians/${userId}/areas`, { method: "POST", body: JSON.stringify({ state_code, county_fips }) });
}
export async function assignProvider(propertyId: string, providerId: string, active: boolean) {
  return authedFetch(`/provider-assignments/${propertyId}/${providerId}`, { method: "PUT", body: JSON.stringify({ active }) });
}
export interface LocationsResponse { active_organization_id: string; tree: boolean; can_export_tree: boolean; companies: LocationCompany[]; facilities: LocationFacility[] }
export async function listCompanies(): Promise<CompanyChoice[]> {
  const r = await authedFetch("/auth/companies");
  return Array.isArray(r) ? r : (r?.companies ?? []);
}
export async function switchCompany(organizationId: string): Promise<{ token: string }> {
  return authedFetch("/auth/switch-company", { method: "POST", body: JSON.stringify({ organization_id: organizationId }) });
}
export async function getLocations(): Promise<LocationsResponse> {
  // Always the full visible tree, independent of the current filter.
  return authedFetch("/locations", { headers: { "X-OI-Scope": "tree" } });
}

// ---- M5: OI staff tools (the server re-checks staff status on every request) ----
export interface PlatformFacility { property_id: string; property_name: string; state: string | null; owner_organization_id: string; owner_name: string; top_organization_id: string | null; active_provider_ids: string[]; building_count: number; opening_count: number }
export interface PlatformProvider { provider_organization_id: string; provider_name: string; active_facility_count: number; active_property_ids: string[] }
export interface PlatformOrganization { id: string; name: string; org_type: "customer" | "service_partner" | "internal"; parent_organization_id: string | null; active_users: number }
export interface PlatformOrgUser { id: string; email: string; full_name: string; role: string; is_active: boolean; is_home: boolean }
export interface ProviderRequest { id: string; property_id: string; property_name: string; provider_organization_id: string; provider_name: string; action: "assign" | "unassign"; reason: string; status: string; requested_at: string; requested_by_user_id: string; requested_by_name?: string; facility_organization_name?: string; reviewed_at?: string | null; review_note?: string | null }
export interface PlatformStaffRow { user_id: string; email: string; full_name: string; granted_at: string; grant_reason: string; revoked_at: string | null; revoke_reason: string | null; active: boolean }
const post = (path: string, body: unknown, method = "POST") => authedFetch(path, { method, body: JSON.stringify(body) });
// Server-reported optional features; fails closed (off) on any error.
export async function serverFeatures(): Promise<{ recognition: boolean }> {
  try { const f = await authedFetch("/features"); return { recognition: f?.recognition === true }; } catch { return { recognition: false }; }
}
export async function platformMe(): Promise<{ staff: boolean; user_id?: string }> {
  try { return await authedFetch("/platform/me"); } catch { return { staff: false }; }
}
export const platformFacilities = (): Promise<PlatformFacility[]> => authedFetch("/platform/facilities");
export const platformProviders = (): Promise<PlatformProvider[]> => authedFetch("/platform/providers");
export const platformOrganizations = (): Promise<PlatformOrganization[]> => authedFetch("/platform/organizations");
export const platformOrgUsers = (orgId: string): Promise<PlatformOrgUser[]> => authedFetch(`/platform/organizations/${orgId}/users`);
export const setOrganizationParent = (orgId: string, body: { parent_organization_id: string | null; reason: string; confirm_provider_link?: true }):
  Promise<{ id: string; parent_organization_id: string | null; tree: PlatformOrganization[] }> => post(`/platform/organizations/${orgId}/parent`, body, "PUT");
export const platformProviderRequests = (status = "pending"): Promise<ProviderRequest[]> => authedFetch(`/platform/provider-requests?status=${encodeURIComponent(status)}`);
export const reviewProviderRequest = (id: string, decision: "approve" | "decline", reason: string) => post(`/platform/provider-requests/${id}/${decision}`, { reason });
export const createCompanyWithAdmin = (body: { name: string; org_type: "customer" | "service_partner"; admin_email: string; admin_full_name: string; reason: string; create_provider_facility?: boolean }):
  Promise<{ organization: { id: string; name: string; org_type: string }; admin: { id: string; email: string }; temporary_password: string; temporary_password_notice: string }> => post("/platform/companies", body);
export const grantMembership = (body: { email: string; role: string; organization_id: string; reason: string }) => post("/members/memberships", body);
export const platformStaff = (): Promise<PlatformStaffRow[]> => authedFetch("/platform/staff");
export const grantStaff = (email: string, reason: string) => post("/platform/staff", { email, reason });
export const revokeStaff = (userId: string, reason: string) => post(`/platform/staff/${userId}`, { reason }, "DELETE");
export const unlockStaffMfa = (userId: string, reason: string) => post(`/platform/staff/${userId}/mfa-unlock`, { reason });
// Facility admins: request a provider (OI staff decide).
export const providerRequestOptions = (): Promise<{ providers: { id: string; name: string }[]; assigned: { property_id: string; provider_organization_id: string }[] }> => authedFetch("/provider-requests/options");
export const myProviderRequests = (): Promise<ProviderRequest[]> => authedFetch("/provider-requests");
export const requestProvider = (body: { property_id: string; provider_organization_id: string; action: "assign" | "unassign"; reason: string }) => post("/provider-requests", body);
export const withdrawProviderRequest = (id: string) => post(`/provider-requests/${id}/withdraw`, {});

// OI staff only: recognition usage by company and month (billing $0.75/opening/month to provider AND facility).
export interface RecognitionUsageCompany { organization_id: string; organization_name: string; org_type: string; owned_openings: number; provider_openings: number; billable_openings: number; revenue_cents: number; photos_recognized: number; runs: number; oi_recognition_cost_usd: number | null; margin_usd: number | null; safety_cap_photos: number; cap_used_ratio: number; cap_warning: boolean }
export interface RecognitionUsageReport { month: string; settings: { opening_price_cents_per_month: number; cost_per_photo_usd: number | null; default_monthly_photo_cap: number; cap_warning_ratio: number }; companies: RecognitionUsageCompany[]; totals: { active_openings: number; billable_openings: number; revenue_cents: number; photos_recognized: number; runs: number; oi_recognition_cost_usd: number | null; margin_usd: number | null } }
export const platformRecognitionUsage = (month: string): Promise<RecognitionUsageReport> => authedFetch(`/platform/recognition-usage?month=${encodeURIComponent(month)}`);
// OI staff: create a service provider's own facility (not tied to a customer facility).
export type UsageSettings = { opening_price_cents_per_month: number; cost_per_photo_usd: number | null; default_monthly_photo_cap: number; cap_warning_ratio: number; updated_at?: string; updated_reason?: string };
export type SafetyCapRow = { organization_id: string; organization_name: string; monthly_photo_cap: number; set_reason: string; updated_at: string };
export const platformUsageSettings = (): Promise<{ settings: UsageSettings; caps: SafetyCapRow[] }> => authedFetch("/platform/recognition-usage/settings");
export const updateUsageSettings = (change: Partial<Omit<UsageSettings, "updated_at" | "updated_reason">> & { reason: string }): Promise<{ settings: UsageSettings }> => post("/platform/recognition-usage/settings", change, "PUT");
export const setSafetyCap = (orgId: string, monthly_photo_cap: number | null, reason: string): Promise<unknown> => post(`/platform/recognition-usage/caps/${orgId}`, { monthly_photo_cap, reason }, "PUT");
export const createProviderFacility = (providerId: string, name: string, reason: string): Promise<{ facility: { id: string; name: string } }> => post(`/platform/providers/${providerId}/facilities`, { name, reason });

export const fetchPurchasingEmail = (): Promise<{ purchasing_email: string | null }> => authedFetch("/purchasing/company-email");
export const savePurchasingEmail = (purchasing_email: string | null): Promise<{ purchasing_email: string | null }> => post("/purchasing/company-email", { purchasing_email }, "PUT");
export const fetchPurchasingBranchEmails = (): Promise<{ branches: Array<{ id: string; name: string; purchasing_email: string | null }> }> => authedFetch("/purchasing/branch-emails");
export const savePurchasingBranchEmail = (id: string, purchasing_email: string | null) => post(`/purchasing/branches/${id}/email`, { purchasing_email }, "PUT");
export const fetchBranches = (): Promise<{ branches: Array<{ id: string; name: string; default_state: string; default_territory: string | null; is_active: boolean; purchasing_email: string | null }> }> => authedFetch("/branches");
export const saveBranch = (id: string, body: { name: string; default_state: string; default_territory: string | null; is_active: boolean; purchasing_email: string | null }) => post(`/branches/${id}`, body, "PUT");
export const inspectionReportRecipients = (id: string): Promise<{ to: string[]; facility_contact_email: string | null; inspector_email: string }> => authedFetch(`/events/inspection-events/${id}/email-defaults`);
export const emailInspectionReport = (id: string, to: string[]): Promise<{ sent: boolean; delivery_mode: string }> => post(`/events/inspection-events/${id}/email`, { to });
export interface InspectionVisitRow { id: string; property_id: string; facility_name: string; visit_date: string; inspector_name: string; report_sent: boolean; inspected: number; passed: number; failed: number }
export const fetchInspectionVisits = (propertyId?: string): Promise<{ visits: InspectionVisitRow[] }> => authedFetch(`/portfolio/inspection-visits${propertyId ? `?property_id=${propertyId}` : ""}`);
export const fetchInspectionVisit = (id: string): Promise<{ id: string; facility_name: string; event_date: string; inspector_name: string | null; summary: string; inspected: number; passed: number; failed: number; report_sent: boolean; report_stored: boolean; doors: Array<{ opening_id: string; opening_code: string; location: string | null; passed: boolean; notes: string | null; repeat_note?: string | null; deficiencies: Array<{ section: string; description: string; note: string }> }> }> => authedFetch(`/portfolio/inspection-visits/${id}`);
export const saveInspectionToFacilityRecords = (id: string): Promise<{ document: { id: string; title: string }; already_saved: boolean }> => post(`/events/inspection-events/${id}/facility-record`, {});

export async function fetchAuthedBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    handleUnauthorized(typeof localStorage !== "undefined" ? localStorage : null,
      typeof window !== "undefined" ? { pathname: window.location.pathname, assign: (u) => window.location.assign(u) } : null,
      import.meta.env.BASE_URL || "/");
  }
  if (!res.ok) throw new ApiError(res.status, "download_failed");
  return res.blob();
}

export interface CompanyCounts { open_work_orders: number; failed_or_overdue: number; inspections_due_30_days: number; quotes: number }
export interface CompanyCustomer {
  id: string; name: string; kind: "facility" | "small" | "walkin"; kind_label: string;
  opening_count: number; attention_count: number; attention: string;
  last_visit: string | null; next_due: string | null; property_ids: string[];
}
export interface CompanyHome { company_name: string; classification_note: string; counts: CompanyCounts; customers: CompanyCustomer[] }
export interface CompanyCustomerDetail {
  id: string; name: string; kind: CompanyCustomer["kind"]; kind_label: string; classification_note: string;
  sites: Array<{ id: string; name: string; address: string; opening_count: number; attention: string; last_visit: string | null; next_due: string | null }>;
}
export interface CompanySite {
  id: string; name: string; address: string; kind: CompanyCustomer["kind"]; kind_label: string;
  customer_id: string; customer_name: string;
  openings: Array<{ id: string; opening_code: string; location_description: string | null; opening_type: string; fire_rated: boolean; health_score: number | null; building_name: string; needs_attention: boolean }>;
  visits: Array<{ id: string; visit_date: string; report_stored: boolean }>;
  work_orders: Array<{ id: string; title: string; status: string; due_date: string | null; opening_code: string }>;
  quotes: Array<{ id: string; opening_id: string; opening_code: string; total_minor: number | null; approval_status: string }>;
}
export interface CompanyOpening {
  id: string; opening_code: string; location_description: string | null; opening_type: string; fire_rated: boolean;
  health_score: number | null; needs_attention: boolean; building_name: string; property_id: string; property_name: string;
  address: string; kind: CompanyCustomer["kind"]; kind_label: string; customer_id: string; customer_name: string;
  work_records: Array<{ id: string; kind: string; label: string; performed_on: string | null; advised_on: string | null }>;
  quotes: Array<{ id: string; total_minor: number | null; approval_status: string }>;
}
export const setQuoteApproval = (id: string, approval_status: "awaiting_approval" | "approved" | "declined") =>
  post(`/company-dashboard/quotes/${id}/approval`, { approval_status });
export const fetchCompanyHome = (): Promise<CompanyHome> => authedFetch("/company-dashboard");
export const fetchCompanyCustomer = (id: string): Promise<CompanyCustomerDetail> => authedFetch(`/company-dashboard/customers/${encodeURIComponent(id)}`);
export const fetchCompanySite = (id: string): Promise<CompanySite> => authedFetch(`/company-dashboard/sites/${id}`);
export const fetchCompanyOpening = (id: string): Promise<CompanyOpening> => authedFetch(`/company-dashboard/openings/${id}`);
export const facilityDashboardAccess = (): Promise<{ allowed: boolean }> => authedFetch("/portfolio/facility-dashboard-access");

export interface RouteCandidate {
  work_id: string; work_kind: string; summary: string; opening_code: string | null; property_id: string;
  property_name: string; address: string; due_date: string | null; latitude: number | null; longitude: number | null;
}
export interface RouteStop {
  id: string; position: number; status: string; work_kind: string; work_id: string; summary: string;
  opening_code: string | null; property_name: string; address: string; time_window: string | null;
  drive_minutes: number | null; done: boolean;
}
export interface ServiceRoute {
  id: string; service_date: string; assigned_user_id: string; assignee_name: string | null;
  total_minutes: number; stops: RouteStop[];
}
export const fetchRouteAssignees = (): Promise<{ people: Array<{ id: string; full_name: string; role: string }> }> =>
  authedFetch("/company-dashboard/routes/assignees");
export const fetchRouteCandidates = (date: string): Promise<{ candidates: RouteCandidate[] }> =>
  authedFetch(`/company-dashboard/routes/candidates?date=${encodeURIComponent(date)}`);
export const fetchServiceRoutes = (date: string): Promise<{ routes: ServiceRoute[]; drive_label?: string }> =>
  authedFetch(`/company-dashboard/routes?date=${encodeURIComponent(date)}`);
export const buildServiceRoute = (body: { service_date: string; assigned_user_id: string; stops: Array<{ work_kind: string; work_id: string; time_window?: string }> }) =>
  post("/company-dashboard/routes", body) as Promise<{ route: ServiceRoute; drive_source: string; drive_label: string; total_minutes: number }>;
export const decideRouteStop = (id: string, decision: "approve" | "decline") =>
  post(`/company-dashboard/routes/stops/${id}/decision`, { decision }) as Promise<{ route: ServiceRoute }>;

export async function downloadAuthedFile(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    handleUnauthorized(typeof localStorage !== "undefined" ? localStorage : null,
      typeof window !== "undefined" ? { pathname: window.location.pathname, assign: (u) => window.location.assign(u) } : null,
      import.meta.env.BASE_URL || "/");
  }
  if (!res.ok) throw new ApiError(res.status, "download_failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
