import { getOfflineSetting, loadAuth, putOfflineSetting } from "./db";
import { selectedFacilityKey } from "./facilitySync";

export interface VisitInspection {
  inspectionId: string;
  openingId: string;
  passed: boolean;
}

export interface InspectionVisit {
  id: string;
  organizationId: string;
  userId: string;
  facilityId: string;
  status: "open" | "finished";
  inspections: VisitInspection[];
}

export function visitKey(id: string) { return `inspection-visit:${id}`; }
export function openVisitKey(userId: string, organizationId: string, facilityId: string) {
  return `inspection-visit-open:${userId}:${organizationId}:${facilityId}`;
}

export function visitCounts(inspections: VisitInspection[]) {
  const failed = inspections.filter((item) => !item.passed).length;
  return { inspected: inspections.length, passed: inspections.length - failed, failed };
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

export function visitSummaryText(inspections: VisitInspection[]): string {
  const counts = visitCounts(inspections);
  return `This visit: ${counts.inspected} openings (${counts.passed} passed, ${counts.failed} failed)`;
}

export function withInspection(visit: InspectionVisit, inspection: VisitInspection): InspectionVisit {
  if (visit.inspections.some((item) => item.inspectionId === inspection.inspectionId)) return visit;
  return { ...visit, inspections: [...visit.inspections, inspection] };
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

export async function ensureOpenVisit(): Promise<InspectionVisit | null> {
  try {
    const auth = await loadAuth();
    if (!auth) return null;
    const facilityId = await currentFacilityId();
    if (!facilityId) return null;
    const pointer = await getOfflineSetting(openVisitKey(auth.userId, auth.organizationId, facilityId));
    const existing = typeof pointer?.value === "string" ? await readVisit(pointer.value) : null;
    if (existing && existing.status === "open" && existing.facilityId === facilityId && existing.userId === auth.userId && existing.organizationId === auth.organizationId) {
      return existing;
    }
    const created: InspectionVisit = {
      id: crypto.randomUUID(), organizationId: auth.organizationId, userId: auth.userId,
      facilityId, status: "open", inspections: [],
    };
    await putOfflineSetting({ key: visitKey(created.id), value: created, updatedAt: new Date().toISOString() });
    await putOfflineSetting({ key: openVisitKey(auth.userId, auth.organizationId, facilityId), value: created.id, updatedAt: new Date().toISOString() });
    return created;
  } catch {
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

export async function finishVisit(id: string): Promise<void> {
  const visit = await readVisit(id);
  if (!visit) return;
  const finished = { ...visit, status: "finished" as const };
  await putOfflineSetting({ key: visitKey(id), value: finished, updatedAt: new Date().toISOString() });
  const pointer = openVisitKey(visit.userId, visit.organizationId, visit.facilityId);
  const current = await getOfflineSetting(pointer);
  if (current?.value === id) await putOfflineSetting({ key: pointer, value: "", updatedAt: new Date().toISOString() });
}
