import type { OfflineMediaRecord, SyncConflict, SyncOperation } from "./offlineTypes";
import { interruptedOperationIsRecoverable } from "./offlineSyncModel";

export interface SyncIssueView {
  id: string;
  label: string;
  status: string;
  error?: string;
  conflict: boolean;
  kind: "operation" | "orphaned_media";
  createdAt: number;
}

export function syncIssuesForRecords(
  operations: SyncOperation[], conflicts: SyncConflict[], media: OfflineMediaRecord[], now = Date.now(),
): SyncIssueView[] {
  const openConflictIds = new Set(conflicts.filter((item) => item.resolutionState === "open").map((item) => item.operationId));
  const operationPhotoIds = new Set(operations.filter((item) => item.entityType === "photo").map((item) => item.entityId));
  const attention = new Set(["conflict", "auth_required", "permanent_failure", "storage_pressure", "schema_blocked"]);
  return [
    ...operations.filter((item) => attention.has(item.state) ||
      interruptedOperationIsRecoverable(item, new Date(now).toISOString()))
      .map((item) => ({ id: item.operationId, label: item.entityType.replace(/_/g, " "), status: item.state,
        error: item.lastErrorCode, conflict: openConflictIds.has(item.operationId), kind: "operation" as const,
        createdAt: Date.parse(item.createdAtLocal) })),
    ...media.filter((item) => !operationPhotoIds.has(item.photoId) && item.uploadState !== "verified").map((item) => ({
      id: item.photoId, label: `${item.targetType.replace(/_/g, " ")} photograph`, status: "orphaned_media",
      conflict: false, kind: "orphaned_media" as const, createdAt: Date.parse(item.createdAtLocal),
    })),
  ].sort((a, b) => a.createdAt - b.createdAt);
}
