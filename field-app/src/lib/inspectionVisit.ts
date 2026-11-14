import { getOfflineSetting, loadAuth, putOfflineSetting } from "./db";
import { isRequestTimeout, withTimeout } from "./deadline";
import { selectedFacilityKey } from "./facilitySync";

export interface VisitInspection {
  inspectionId: string;
  openingId: string;
  passed: boolean;
  inspectedAt?: string | null;
}

export interface InspectionVisit {
  id: string;
  organizationId: string;
  userId: string;
  facilityId: string;
  status: "open" | "finished";
  inspections: VisitInspection[];
  replaceOpenVisit?: boolean;
}

export function visitKey(id: string) { return `inspection-visit:${id}`; }
export function openVisitKey(userId: string, organizationId: string, facilityId: string) {
  return `inspection-visit-open:${userId}:${organizationId}:${facilityId}`;
}

export function visitCounts(inspections: VisitInspection[]) {
  const doors = new Map<string, VisitInspection>();
  for (const item of inspections) {
    const key = item.openingId || item.inspectionId;
    const current = doors.get(key);
    if (!current) {
      doors.set(key, item);
      continue;
    }
    const currentAt = current.inspectedAt;
    const nextAt = item.inspectedAt;
    if (currentAt && nextAt) {
      if (nextAt >= currentAt) doors.set(key, item);
    } else {
      doors.set(key, item);
    }
  }
  const latest = [...doors.values()];
  const failed = latest.filter((item) => !item.passed).length;
  return { inspected: latest.length, passed: latest.length - failed, failed };
}

export function visitUploadMessage(pending: number): string {
  return `${pending} inspection(s) are still uploading, try again`;
}

export function pendingInspectionIds(
  localIds: string[],
  operations: { entityId: string; entityType: string; state: string }[],
  serverIds: string[] | null,
): string[] {
  const localState = new Map(
    operations.filter((operation) => operation.entityType === "inspection_event").map((operation) => [operation.entityId, operation.state]),
  );
  const onServer = new Set(serverIds ?? []);
  return localIds.filter((id) => {
    const state = localState.get(id);
    if (state && state !== "verified") return true;
    return !serverIds || !onServer.has(id);
  });
}

export const VISIT_TIME_ZONE = "America/Phoenix";

export function formatVisitDoorTime(value: string | null | undefined, timeZone = VISIT_TIME_ZONE): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

export function openingCountText(count: number): string {
  return `${count} ${count === 1 ? "opening" : "openings"}`;
}

export function visitSummaryText(inspections: VisitInspection[]): string {
  const counts = visitCounts(inspections);
  return `This visit: ${openingCountText(counts.inspected)} (${counts.passed} passed, ${counts.failed} failed)`;
}

export function withInspection(visit: InspectionVisit, inspection: VisitInspection): InspectionVisit {
  if (visit.inspections.some((item) => item.inspectionId === inspection.inspectionId)) return visit;
  const stamped = { ...inspection, inspectedAt: inspection.inspectedAt || new Date().toISOString() };
  return { ...visit, inspections: [...visit.inspections, stamped] };
}

async function readVisit(id: string): Promise<InspectionVisit | null> {
  const stored = await getOfflineSetting(visitKey(id));
  const value = stored?.value as InspectionVisit | undefined;
  if (!value || value.id !== id || !Array.isArray(value.inspections)) return null;
  return value;
}

export async function currentFacilityId(): Promise<string> {
  const auth = await loadAuth();
  if (!auth) return "";
  const stored = await getOfflineSetting(selectedFacilityKey(auth));
  return typeof stored?.value === "string" ? stored.value : "";
}

export type OpenVisitLookup = (facilityId: string) => Promise<{ id: string; inspections?: VisitInspection[] } | null>;

async function rememberVisit(visit: InspectionVisit) {
  const now = new Date().toISOString();
  await putOfflineSetting({ key: visitKey(visit.id), value: visit, updatedAt: now });
  await putOfflineSetting({ key: openVisitKey(visit.userId, visit.organizationId, visit.facilityId), value: visit.id, updatedAt: now });
}

async function readOrCreateOpenVisit(lookup: OpenVisitLookup | undefined, attempt: { cancelled: boolean }): Promise<InspectionVisit | null> {
  const auth = await loadAuth();
  if (!auth) return null;
  const facilityId = await currentFacilityId();
  if (!facilityId) return null;
  const pointer = await getOfflineSetting(openVisitKey(auth.userId, auth.organizationId, facilityId));
  const existing = typeof pointer?.value === "string" && pointer.value ? await readVisit(pointer.value) : null;
  if (existing && existing.status === "open" && existing.facilityId === facilityId && existing.userId === auth.userId && existing.organizationId === auth.organizationId) {
    return existing;
  }
  if (lookup) {
    try {
      const found = await withTimeout(lookup(facilityId), 4_000, "open visit lookup timed out");
      if (found?.id) {
        const adopted: InspectionVisit = {
          id: found.id, organizationId: auth.organizationId, userId: auth.userId, facilityId, status: "open",
          inspections: Array.isArray(found.inspections) ? found.inspections : [],
        };
        if (!attempt.cancelled) await rememberVisit(adopted);
        return adopted;
      }
    } catch {
      // A missed lookup must not block the save. The server still joins an open visit when no id is sent.
    }
  }
  if (attempt.cancelled) return null;
  const created: InspectionVisit = {
    id: crypto.randomUUID(), organizationId: auth.organizationId, userId: auth.userId,
    facilityId, status: "open", inspections: [],
  };
  await rememberVisit(created);
  return created;
}

export async function ensureOpenVisit(lookup?: OpenVisitLookup): Promise<InspectionVisit | null> {
  const attempt = { cancelled: false };
  try {
    return await withTimeout(readOrCreateOpenVisit(lookup, attempt), 8_000, "IndexedDB request timed out");
  } catch (error) {
    attempt.cancelled = true;
    if (isRequestTimeout(error)) throw error;
    return null;
  }
}

export async function recordVisitInspection(visitId: string, inspection: VisitInspection): Promise<InspectionVisit | null> {
  try {
    const visit = await readVisit(visitId);
    if (!visit) return null;
    const next = withInspection(visit, inspection);
    await putOfflineSetting({ key: visitKey(visit.id), value: next, updatedAt: new Date().toISOString() });
    return next;
  } catch {
    return null;
  }
}

export function serverVisitIsClosed(server: { status?: string | null; report_sent?: boolean | null } | null | undefined): boolean {
  if (!server) return false;
  return server.status === "finished" || server.report_sent === true;
}

function serverInspections(inspections: VisitInspection[] | undefined): VisitInspection[] {
  return (inspections ?? []).map((item) => ({
    inspectionId: item.inspectionId,
    openingId: item.openingId,
    passed: item.passed === true,
  }));
}

function missingOnServer(error: unknown): boolean {
  return !!error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404;
}

/** On Scan load and focus, follow the server's open visit when this phone is online. */
export async function reconcileOpenVisit(
  fetchServer: (id: string) => Promise<{ status?: string | null; report_sent?: boolean | null } | null>,
  lookup?: OpenVisitLookup,
): Promise<InspectionVisit | null> {
  const local = await readOpenVisit();
  if (local?.replaceOpenVisit && local.inspections.length === 0) return local;
  const auth = await loadAuth();
  const facilityId = await currentFacilityId();
  if (!auth || !facilityId) return local;
  let serverOpen: { id: string; inspections?: VisitInspection[] } | null = null;
  if (lookup) {
    try {
      serverOpen = await withTimeout(lookup(facilityId), 4_000, "open visit lookup timed out");
    } catch {
      return local;
    }
  }
  let dropLocal = false;
  if (local) {
    try {
      const row = await fetchServer(local.id);
      dropLocal = serverVisitIsClosed(row) || !row;
    } catch (error) {
      if (!missingOnServer(error)) return local;
      dropLocal = true;
    }
  }
  const serverId = serverOpen?.id;
  if (local && !dropLocal && (!serverId || serverId === local.id)) {
    if (serverId === local.id) {
      const refreshed = { ...local, status: "open" as const, inspections: serverInspections(serverOpen?.inspections) };
      await rememberVisit(refreshed);
      return refreshed;
    }
    return local;
  }
  if (local) await finishVisit(local.id);
  if (!serverId) return null;
  const adopted: InspectionVisit = {
    id: serverId, organizationId: auth.organizationId, userId: auth.userId, facilityId, status: "open",
    inspections: serverInspections(serverOpen?.inspections),
  };
  await rememberVisit(adopted);
  return adopted;
}

export async function readOpenVisit(): Promise<InspectionVisit | null> {
  try {
    const auth = await loadAuth();
    const facilityId = await currentFacilityId();
    if (!auth || !facilityId) return null;
    const pointer = await getOfflineSetting(openVisitKey(auth.userId, auth.organizationId, facilityId));
    if (typeof pointer?.value !== "string") return null;
    const visit = await readVisit(pointer.value);
    if (!visit || visit.status !== "open" || visit.facilityId !== facilityId) return null;
    return visit;
  } catch {
    return null;
  }
}

export async function readVisitById(id: string): Promise<InspectionVisit | null> {
  try { return await readVisit(id); } catch { return null; }
}

export async function adoptBoundVisit(visitId: string, inspection?: VisitInspection): Promise<void> {
  const auth = await loadAuth();
  const facilityId = await currentFacilityId();
  if (!auth || !facilityId || !visitId) return;
  const existing = await readVisit(visitId);
  let visit: InspectionVisit = existing?.status === "open" ? existing : {
    id: visitId, organizationId: auth.organizationId, userId: auth.userId, facilityId, status: "open",
    inspections: existing?.inspections ?? [],
  };
  if (inspection) visit = withInspection(visit, inspection);
  await rememberVisit(visit);
}

export async function startNewVisit(options?: { replaceOpenVisit?: boolean }): Promise<InspectionVisit | null> {
  try {
    const auth = await loadAuth();
    const facilityId = await currentFacilityId();
    if (!auth || !facilityId) return null;
    const created: InspectionVisit = {
      id: crypto.randomUUID(), organizationId: auth.organizationId, userId: auth.userId,
      facilityId, status: "open", inspections: [],
      replaceOpenVisit: options?.replaceOpenVisit === true,
    };
    const now = new Date().toISOString();
    await putOfflineSetting({ key: visitKey(created.id), value: created, updatedAt: now });
    await putOfflineSetting({ key: openVisitKey(auth.userId, auth.organizationId, facilityId), value: created.id, updatedAt: now });
    return created;
  } catch {
    return null;
  }
}

export async function finishVisit(id: string): Promise<void> {
  const visit = await readVisit(id);
  if (!visit) return;
  const finished = { ...visit, status: "finished" as const };
  await putOfflineSetting({ key: visitKey(id), value: finished, updatedAt: new Date().toISOString() });
  const pointer = openVisitKey(visit.userId, visit.organizationId, visit.facilityId);
  const current = await getOfflineSetting(pointer);
  if (current?.value === id) await putOfflineSetting({ key: pointer, value: "", updatedAt: new Date().toISOString() });
}
