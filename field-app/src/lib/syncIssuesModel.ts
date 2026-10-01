import type { OfflineMediaRecord, SyncConflict, SyncOperation } from "./offlineTypes";
import { interruptedOperationIsRecoverable } from "./offlineSyncModel";

export interface SyncIssueView {
  id: string;
  label: string;
  status: string;
  error?: string;
  conflict: boolean;
  kind: "operation" | "orphaned_media" | "rejected_media";
  createdAt: number;
  photoId?: string;
  mediaBytes?: number;
  contentType?: string;
}

export function syncIssuesForRecords(
  operations: SyncOperation[], conflicts: SyncConflict[], media: OfflineMediaRecord[], now = Date.now(),
): SyncIssueView[] {
  const openConflictIds = new Set(conflicts.filter((item) => item.resolutionState === "open").map((item) => item.operationId));
  const operationPhotoIds = new Set(operations.filter((item) => item.entityType === "photo").map((item) => item.entityId));
  const mediaById = new Map(media.map((item) => [item.photoId, item]));
  const attention = new Set(["conflict", "auth_required", "permanent_failure", "storage_pressure", "schema_blocked"]);
  return [
    ...operations.filter((item) => attention.has(item.state) ||
      interruptedOperationIsRecoverable(item, new Date(now).toISOString()))
      .map((item) => {
        const record = item.entityType === "photo" ? mediaById.get(item.entityId) : undefined;
        if (record && item.state === "permanent_failure" && item.lastErrorCode === "media_too_large") {
          return { id: item.operationId, label: `${record.targetType.replace(/_/g, " ")} ${record.contentType.startsWith("video/") ? "video" : "photograph"}`,
            status: "rejected_too_large", error: item.lastErrorCode, conflict: false, kind: "rejected_media" as const,
            createdAt: Date.parse(item.createdAtLocal), photoId: record.photoId, mediaBytes: record.byteSize, contentType: record.contentType };
        }
        return { id: item.operationId, label: item.entityType.replace(/_/g, " "), status: item.state,
          error: item.lastErrorCode, conflict: openConflictIds.has(item.operationId), kind: "operation" as const,
          createdAt: Date.parse(item.createdAtLocal) };
      }),
    ...media.filter((item) => !operationPhotoIds.has(item.photoId) && item.uploadState !== "verified").map((item) => ({
      id: item.photoId, label: `${item.targetType.replace(/_/g, " ")} photograph`, status: "orphaned_media",
      conflict: false, kind: "orphaned_media" as const, createdAt: Date.parse(item.createdAtLocal),
    })),
  ].sort((a, b) => a.createdAt - b.createdAt);
}
