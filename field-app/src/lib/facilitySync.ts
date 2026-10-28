// M4 v3: facility download. When a signed-in user selects a facility, every opening in
// every building of that facility (with its hardware, leaves and frame, via the normal
// opening detail fetch that already caches into IndexedDB) is saved on the device.
// Pure engine with injected dependencies so it is testable without a browser.
// Edits are unaffected: they still go through the existing offline queue and
// expected_revision checks; this only reads.
import { facilityOpeningsCacheKey, type FacilityOpening, type FacilityProperty } from "./facilityOpenings";

export interface Principal { userId: string; organizationId: string }
export const selectedFacilityKey = (p: Principal) => `selected-facility:${p.userId}:${p.organizationId}`;
export const facilitySyncKey = (p: Principal, propertyId: string) => `facility-sync:${p.userId}:${p.organizationId}:${propertyId}`;

/** Stored choice if still accessible, else the only facility, else none (ask the user). */
export function chooseFacility(properties: FacilityProperty[], storedId?: string | null): string | null {
  if (storedId && properties.some((p) => p.id === storedId)) return storedId;
  return properties.length === 1 ? properties[0].id : null;
}
/** Refresh on resume or reconnect, but not more often than minMs. Reselect always refreshes. */
export function shouldRefresh(lastFinishedAt: string | null | undefined, now: number, minMs = 60_000): boolean {
  if (!lastFinishedAt) return true;
  const t = Date.parse(lastFinishedAt);
  return !Number.isFinite(t) || now - t >= minMs;
}

export interface FacilitySyncProgress { phase: "listing" | "downloading" | "done"; buildingsDone: number; buildingsTotal: number; openingsDone: number; openingsTotal: number; failed: number; attempt: number }
export interface FacilitySyncResult { status: "complete" | "partial" | "failed" | "cancelled"; propertyId: string; openings: number; saved: number; failed: number; failedIds: string[]; buildingsFailed: string[]; finishedAt: string }
export interface FacilitySyncDeps {
  listOpenings(buildingId: string): Promise<FacilityOpening[]>;
  fetchOpening(id: string): Promise<unknown>;
  putSetting(key: string, value: unknown): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
}
const defaultSleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

async function withRetry<T>(fn: () => Promise<T>, retries: number, backoffMs: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error("cancelled");
    try { return await fn(); } catch (e: any) {
      lastErr = e;
      // A 401/403/404 will not get better by retrying.
      if (e && typeof e.status === "number" && [401, 403, 404].includes(e.status)) break;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function syncFacility(deps: FacilitySyncDeps, principal: Principal, property: FacilityProperty,
  opts: { retries?: number; backoffMs?: number; concurrency?: number; onProgress?: (p: FacilitySyncProgress) => void; signal?: AbortSignal } = {}): Promise<FacilitySyncResult> {
  const retries = opts.retries ?? 2, backoff = opts.backoffMs ?? 500, concurrency = Math.max(1, opts.concurrency ?? 3);
  const sleep = deps.sleep ?? defaultSleep, now = deps.now ?? (() => new Date());
  const buildings = property.buildings ?? [];
  const p: FacilitySyncProgress = { phase: "listing", buildingsDone: 0, buildingsTotal: buildings.length, openingsDone: 0, openingsTotal: 0, failed: 0, attempt: 1 };
  const emit = () => opts.onProgress?.({ ...p });
  emit();
  const ids: string[] = [], buildingsFailed: string[] = [];
  for (const b of buildings) {
    if (opts.signal?.aborted) break;
    try {
      const rows = await withRetry(() => deps.listOpenings(b.id), retries, backoff, sleep, opts.signal);
      await deps.putSetting(facilityOpeningsCacheKey(principal, b.id), rows);
      for (const o of rows) if (!ids.includes(o.id)) ids.push(o.id);
    } catch { buildingsFailed.push(b.id); }
    p.buildingsDone++; p.openingsTotal = ids.length; emit();
  }
  p.phase = "downloading"; emit();
  const failedIds: string[] = [];
  let next = 0, saved = 0;
  const worker = async () => {
    while (next < ids.length && !opts.signal?.aborted) {
      const id = ids[next++];
      try { await withRetry(() => deps.fetchOpening(id), retries, backoff, sleep, opts.signal); saved++; }
      catch { failedIds.push(id); p.failed++; }
      p.openingsDone++; emit();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, ids.length)) }, worker));
  const cancelled = !!opts.signal?.aborted;
  const failed = failedIds.length;
  const status: FacilitySyncResult["status"] = cancelled ? "cancelled"
    : (buildings.length > 0 && buildingsFailed.length === buildings.length) ? "failed"
    : (failed || buildingsFailed.length) ? (saved ? "partial" : (ids.length ? "failed" : "partial")) : "complete";
  const result: FacilitySyncResult = { status, propertyId: property.id, openings: ids.length, saved, failed, failedIds, buildingsFailed, finishedAt: now().toISOString() };
  p.phase = "done"; emit();
  if (!cancelled) await deps.putSetting(facilitySyncKey(principal, property.id), result).catch(() => {});
  return result;
}

/** Download only the openings that failed last time (the "Retry failed" button). */
export async function retryFailedOpenings(deps: FacilitySyncDeps, principal: Principal, previous: FacilitySyncResult,
  opts: { retries?: number; backoffMs?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<FacilitySyncResult> {
  const sleep = deps.sleep ?? defaultSleep, now = deps.now ?? (() => new Date());
  const still: string[] = []; let done = 0, saved = 0;
  for (const id of previous.failedIds) {
    try { await withRetry(() => deps.fetchOpening(id), opts.retries ?? 2, opts.backoffMs ?? 500, sleep); saved++; } catch { still.push(id); }
    opts.onProgress?.(++done, previous.failedIds.length);
  }
  const failed = still.length, totalSaved = previous.saved + saved;
  const result: FacilitySyncResult = { ...previous, saved: totalSaved, failed, failedIds: still,
    status: failed || previous.buildingsFailed.length ? (totalSaved ? "partial" : "failed") : "complete", finishedAt: now().toISOString() };
  await deps.putSetting(facilitySyncKey(principal, previous.propertyId), result).catch(() => {});
  return result;
}

export function describeSync(p: FacilitySyncProgress | null, r: FacilitySyncResult | null): string {
  if (p && p.phase !== "done") return p.phase === "listing" ? `Finding openings: building ${p.buildingsDone} of ${p.buildingsTotal}`
    : `Downloading for offline use: ${p.openingsDone} of ${p.openingsTotal}${p.failed ? ` (${p.failed} failed)` : ""}`;
  if (!r) return "";
  const when = new Date(r.finishedAt).toLocaleString();
  if (r.status === "complete") return `All ${r.openings} opening(s) saved on this device (${when}).`;
  if (r.status === "cancelled") return "Download stopped.";
  if (r.status === "failed") return "Couldn't download this facility. Check your connection and retry.";
  return `${r.saved} of ${r.openings} opening(s) saved; ${r.failed} opening(s)${r.buildingsFailed.length ? ` and ${r.buildingsFailed.length} building(s)` : ""} failed. Retry when you have a connection.`;
}