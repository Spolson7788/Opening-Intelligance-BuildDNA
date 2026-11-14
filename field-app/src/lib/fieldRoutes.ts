import { loadAuth } from "./db";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export interface FieldStop {
  id: string;
  position: number;
  status: string;
  work_kind: string;
  summary: string;
  opening_code: string | null;
  property_id: string;
  property_name: string;
  address: string;
  navigation_address: string | null;
  latitude: number | null;
  longitude: number | null;
  time_window: string | null;
  drive_minutes: number | null;
  done: boolean;
  maps: { apple: string; google: string };
}

export interface FieldRoute {
  id: string;
  service_date: string;
  assignee_name: string | null;
  total_minutes: number;
  stops: FieldStop[];
}

export interface NearbyWork {
  work_kind: string;
  work_id: string;
  property_name: string;
  address: string;
  summary: string;
  miles: number;
  schedule_only: boolean;
}

async function fieldFetch(path: string, options: RequestInit = {}) {
  const auth = await loadAuth();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers as Record<string, string> | undefined) };
  if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
  const signal = options.signal ?? (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(12_000) : undefined);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers, signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || "Could not reach the route.");
  return body;
}

export function fetchFieldRoute(date: string): Promise<{ route: FieldRoute | null; apple_maps: boolean }> {
  return fieldFetch(`/field-routes/today?date=${encodeURIComponent(date)}`);
}

export function markFieldStopDone(id: string) {
  return fieldFetch(`/field-routes/stops/${id}/done`, { method: "POST", body: "{}" });
}

export function fetchNearbyWork(): Promise<{ nearby: NearbyWork[]; radius_miles: number }> {
  return fieldFetch("/field-routes/nearby");
}

export function requestNearbyWork(work: { work_kind: string; work_id: string }) {
  return fieldFetch("/field-routes/nearby", { method: "POST", body: JSON.stringify(work) });
}
