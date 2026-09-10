const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function getToken() {
  return localStorage.getItem("oi_token");
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem("oi_token", token);
  else localStorage.removeItem("oi_token");
}

async function authedFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || `request_failed_${res.status}`);
  }
  if (res.status === 204) return null; // no current caller uses this yet, but avoids the same crash the field app had
  return res.json();
}

export async function signup(payload: {
  organization_name: string;
  email: string;
  password: string;
  full_name: string;
}) {
  const res = await fetch(`${API_BASE}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error || "signup_failed");
  }
  return res.json() as Promise<{ token: string; expiresIn: string; organizationId: string }>;
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
  buildings: Building[];
}

export interface TeamMember {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "facilities_manager" | "technician" | "inspector" | "viewer";
  is_active: boolean;
  created_at: string;
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  return authedFetch("/auth/users");
}

export async function inviteTeamMember(payload: {
  email: string;
  password: string;
  full_name: string;
  role: string;
}): Promise<TeamMember> {
  return authedFetch("/auth/register", { method: "POST", body: JSON.stringify(payload) });
}

export async function updateTeamMember(id: string, payload: { role?: string; is_active?: boolean }): Promise<TeamMember> {
  return authedFetch(`/auth/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

export interface AuditLogEntry {
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
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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
    headers: token ? { Authorization: `Bearer ${token}` } : {},
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
  id: string;
  opening_code: string;
  opening_type: string;
  floor_label: string | null;
  location_description: string | null;
  qr_data_url: string;
}

export async function fetchQrCodesForBuilding(buildingId: string): Promise<{ count: number; items: QrLabelItem[] }> {
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
  hardware_components: any[];
  service_events: any[];
  inspection_events: any[];
  photos: any[];
}

export async function fetchOpening(id: string): Promise<OpeningDetail> {
  return authedFetch(`/openings/${id}`);
}

export async function listOpenings(params: Record<string, string> = {}): Promise<Opening[]> {
  const qs = new URLSearchParams(params).toString();
  return authedFetch(`/openings${qs ? `?${qs}` : ""}`);
}

export function decodeTokenPayload(token: string): { userId: string; organizationId: string; role: string } {
  const payload = JSON.parse(atob(token.split(".")[1]));
  return { userId: payload.userId, organizationId: payload.organizationId, role: payload.role };
}
