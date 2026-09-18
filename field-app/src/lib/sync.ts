import {
  getOutbox, removeOutboxItem, updateOutboxItem,
  getPhotoOutbox, removePhotoOutboxItem, updatePhotoOutboxItem,
  enqueueOutboxItem,
} from "./db";
import type { OutboxItem, PhotoOutboxItem } from "./db";
import {
  submitServiceEvent, submitInspectionEvent, ApiError,
  presignPhotoUpload, uploadToPresignedUrl, confirmPhotoUpload,
  saveOpeningFrame, saveDoorLeaf, addHardwareComponent, completeOpening,
} from "./api";

type SyncListener = (state: SyncState) => void;

export interface SyncState {
  pending: number; // combined: JSON outbox + photo outbox
  syncing: boolean;
  failed: number;
  conflicts: number;
  lastError?: string;
}

let listeners: SyncListener[] = [];
let currentState: SyncState = { pending: 0, syncing: false, failed: 0, conflicts: 0 };

function notify() {
  listeners.forEach((l) => l(currentState));
}

export function onSyncStateChange(listener: SyncListener) {
  listeners.push(listener);
  listener(currentState);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

async function refreshPendingCount() {
  const [events, photos] = await Promise.all([getOutbox(), getPhotoOutbox()]);
  const all = [...events, ...photos];
  currentState = {
    ...currentState,
    pending: all.filter((item) => item.status === "pending" || item.status === "failed").length,
    failed: all.filter((item) => item.status === "failed").length,
    conflicts: all.filter((item) => item.status === "conflict").length,
  };
  notify();
}

async function submitOne(item: OutboxItem) {
  if (item.kind === "service_event") return submitServiceEvent(item.payload);
  if (item.kind === "inspection_event") return submitInspectionEvent(item.payload);
  if (item.kind === "opening_frame") return saveOpeningFrame(item.openingId!, item.payload);
  if (item.kind === "door_leaf") return saveDoorLeaf(item.openingId!, item.payload);
  if (item.kind === "hardware_component") return addHardwareComponent(item.payload);
  return completeOpening(item.openingId!);
}

export async function queueOpeningMutation(
  kind: OutboxItem["kind"], openingId: string, payload: any, id = crypto.randomUUID()
) {
  await enqueueOutboxItem({ id, kind, openingId, payload });
  await refreshPendingCount();
  void flushOutbox();
  return id;
}

async function flushEventOutbox() {
  const items = (await getOutbox()).sort((a, b) => a.createdAt - b.createdAt);

  for (const item of items.filter((candidate) => candidate.status !== "conflict")) {
    try {
      await submitOne(item);
      await removeOutboxItem(item.id);
    } catch (err) {
      const isClientError = err instanceof ApiError && err.status >= 400 && err.status < 500;
      const updated: OutboxItem = {
        ...item,
        attempts: item.attempts + 1,
        lastError: err instanceof Error ? err.message : "unknown_error",
        status: err instanceof ApiError && err.status === 409 ? "conflict" : "failed",
      };
      await updateOutboxItem(updated);
      currentState = { ...currentState, lastError: updated.lastError };
      if (isClientError) continue;
      return; // likely connectivity — stop and wait for the next trigger
    }
  }
}

async function uploadOnePhoto(item: PhotoOutboxItem) {
  const { uploadUrl, key } = await presignPhotoUpload(item.openingId, item.contentType, item.id);
  await uploadToPresignedUrl(uploadUrl, item.blob, item.contentType);
  await confirmPhotoUpload({
    opening_id: item.openingId,
    storage_key: key,
    content_type: item.contentType,
    client_operation_id: item.id,
    related_entity_type: item.relatedEntityType,
    related_entity_id: item.relatedEntityId,
    frame_id: item.frameId,
    door_leaf_id: item.doorLeafId,
    hardware_component_id: item.hardwareComponentId,
    latitude: item.latitude,
    longitude: item.longitude,
  });
}

async function flushPhotoOutbox() {
  const items = (await getPhotoOutbox()).sort((a, b) => a.createdAt - b.createdAt);

  for (const item of items.filter((candidate) => candidate.status !== "conflict")) {
    try {
      await uploadOnePhoto(item);
      await removePhotoOutboxItem(item.id);
    } catch (err) {
      // Presigned URLs expire in 5 minutes — if this item sat offline for
      // longer than that, the first attempt after reconnecting will fail
      // with an expired-URL error from S3, and the retry on the *next* flush
      // pass will succeed (it re-presigns from scratch each attempt). So a
      // single failure here is expected and not itself a sign of trouble.
      const isClientError = err instanceof ApiError && err.status >= 400 && err.status < 500;
      const updated: PhotoOutboxItem = {
        ...item,
        attempts: item.attempts + 1,
        lastError: err instanceof Error ? err.message : "unknown_error",
        status: err instanceof ApiError && err.status === 409 ? "conflict" : "failed",
      };
      await updatePhotoOutboxItem(updated);
      currentState = { ...currentState, lastError: updated.lastError };
      if (isClientError && updated.attempts > 5) continue; // give up on something persistently rejected
      return; // stop this pass, retry on the next trigger
    }
  }
}

// Flushes both outboxes. Photos run after events on purpose — event writes
// are small and should land first; photo uploads are larger and more likely
// to hit a flaky connection mid-transfer, so we don't want a stalled photo
// upload to hold up service/inspection records that are ready to go.
export async function flushOutbox() {
  if (currentState.syncing) return;
  if (!navigator.onLine) return;

  currentState = { ...currentState, syncing: true };
  notify();

  await flushEventOutbox();
  await flushPhotoOutbox();

  currentState = { ...currentState, syncing: false };
  await refreshPendingCount();
}

export function initSync() {
  refreshPendingCount();
  window.addEventListener("online", flushOutbox);
  // Also try periodically in case 'online' doesn't fire reliably (some mobile browsers).
  const interval = setInterval(flushOutbox, 30_000);
  flushOutbox();
  return () => {
    window.removeEventListener("online", flushOutbox);
    clearInterval(interval);
  };
}
