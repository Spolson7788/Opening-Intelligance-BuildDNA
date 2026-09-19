import type {
  OfflineEntityEnvelope,
  SyncOperation,
  SyncOperationState,
  TechnicianSyncStatus,
} from "./offlineTypes";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WAITING_STATES = new Set<SyncOperationState>([
  "queued",
  "retry_wait",
  "blocked_dependency",
]);
const ACTIVE_STATES = new Set<SyncOperationState>(["in_flight", "verifying"]);
const ATTENTION_STATES = new Set<SyncOperationState>([
  "permanent_failure",
  "auth_required",
  "storage_pressure",
  "schema_blocked",
]);

export function validateOfflineEntity(entity: OfflineEntityEnvelope): string[] {
  const errors: string[] = [];
  if (!UUID_PATTERN.test(entity.id)) errors.push("invalid_entity_id");
  if (!UUID_PATTERN.test(entity.openingId)) errors.push("invalid_opening_id");
  if (!UUID_PATTERN.test(entity.organizationId)) errors.push("invalid_organization_id");
  if (!UUID_PATTERN.test(entity.createdByUserId)) errors.push("invalid_creating_user_id");
  if (!UUID_PATTERN.test(entity.createdByDeviceId)) errors.push("invalid_device_id");
  if (entity.retryCount < 0 || !Number.isInteger(entity.retryCount)) errors.push("invalid_retry_count");
  if (entity.key !== `${entity.entityType}:${entity.id}`) errors.push("invalid_entity_key");
  return errors;
}

export function validateSyncOperation(operation: SyncOperation): string[] {
  const errors: string[] = [];
  if (!UUID_PATTERN.test(operation.operationId)) errors.push("invalid_operation_id");
  if (!UUID_PATTERN.test(operation.entityId)) errors.push("invalid_entity_id");
  if (!UUID_PATTERN.test(operation.openingId)) errors.push("invalid_opening_id");
  if (!UUID_PATTERN.test(operation.organizationId)) errors.push("invalid_organization_id");
  if (!UUID_PATTERN.test(operation.actorUserId)) errors.push("invalid_actor_user_id");
  if (!UUID_PATTERN.test(operation.deviceId)) errors.push("invalid_device_id");
  if (!operation.payloadHash) errors.push("missing_payload_hash");
  if (new Set(operation.dependencyOperationIds).size !== operation.dependencyOperationIds.length) {
    errors.push("duplicate_dependency");
  }
  if (operation.dependencyOperationIds.includes(operation.operationId)) {
    errors.push("self_dependency");
  }
  if (operation.attemptCount < 0 || !Number.isInteger(operation.attemptCount)) {
    errors.push("invalid_attempt_count");
  }
  return errors;
}

export function technicianStatusForStates(states: SyncOperationState[]): TechnicianSyncStatus {
  if (states.includes("conflict")) return "conflict_requires_review";
  if (states.some((state) => ATTENTION_STATES.has(state))) return "needs_attention";
  if (states.some((state) => ACTIVE_STATES.has(state))) return "syncing";
  if (states.some((state) => WAITING_STATES.has(state))) return "waiting_to_sync";
  if (states.includes("local_committed")) return "saved_locally";
  return "synced";
}

export function readyOperations(
  operations: SyncOperation[],
  verifiedOperationIds: ReadonlySet<string>,
  nowIso: string,
): SyncOperation[] {
  const now = Date.parse(nowIso);
  return operations
    .filter((operation) => operation.state === "queued" || operation.state === "retry_wait" || operation.state === "blocked_dependency")
    .filter((operation) => !operation.nextAttemptAt || Date.parse(operation.nextAttemptAt) <= now)
    .filter((operation) => operation.dependencyOperationIds.every((id) => verifiedOperationIds.has(id)))
    .sort((a, b) => a.createdAtLocal.localeCompare(b.createdAtLocal));
}

export function retryDelayMs(attemptCount: number, randomFraction = 0.5): number {
  const baseMs = 2_000;
  const capMs = 5 * 60_000;
  const boundedAttempt = Math.max(0, Math.min(attemptCount, 12));
  const withoutJitter = Math.min(capMs, baseMs * 2 ** boundedAttempt);
  const boundedRandom = Math.max(0, Math.min(randomFraction, 1));
  return Math.round(withoutJitter * (0.75 + boundedRandom * 0.5));
}
