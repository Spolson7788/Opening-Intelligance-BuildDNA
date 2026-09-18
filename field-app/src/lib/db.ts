import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";

interface FieldAppDB extends DBSchema {
  // Local cache of the last-seen version of each opening, so a technician can
  // still view opening details when there's no signal (e.g. a basement).
  openings: {
    key: string;
    value: any;
  };
  // Outbox: mutations captured while offline (or just to avoid blocking the UI
  // on a slow connection), flushed in order once connectivity returns.
  outbox: {
    key: string;
    value: OutboxItem;
  };
  // Photo outbox: unlike JSON events, this holds the actual image blob, since
  // a presigned upload URL can't be requested until we're back online anyway.
  // The blob is captured to disk immediately on shutter tap so nothing is lost
  // if the app closes before connectivity returns.
  photoOutbox: {
    key: string;
    value: PhotoOutboxItem;
  };
  auth: {
    key: string;
    value: { token: string; userId: string; organizationId: string; role: string; savedAt: number };
  };
}

export interface OutboxItem {
  id: string; // uuid, generated client-side
  kind: "service_event" | "inspection_event" | "opening_frame" | "door_leaf" | "hardware_component" | "complete_opening";
  payload: any;
  openingId?: string;
  createdAt: number;
  attempts: number;
  status: "pending" | "failed" | "conflict";
  lastError?: string;
}

export interface PhotoOutboxItem {
  id: string;
  openingId: string;
  blob: Blob;
  contentType: string;
  relatedEntityType: "opening" | "frame" | "door_leaf" | "hardware_component";
  relatedEntityId?: string;
  frameId?: string;
  doorLeafId?: string;
  hardwareComponentId?: string;
  latitude?: number;
  longitude?: number;
  createdAt: number;
  attempts: number;
  status: "pending" | "failed" | "conflict";
  lastError?: string;
}

let dbPromise: Promise<IDBPDatabase<FieldAppDB>> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<FieldAppDB>("opening-intel-field", 2, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("openings", { keyPath: "id" });
          db.createObjectStore("outbox", { keyPath: "id" });
          db.createObjectStore("auth");
        }
        if (oldVersion < 2) {
          db.createObjectStore("photoOutbox", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function cacheOpening(opening: any) {
  const db = await getDb();
  await db.put("openings", opening);
}

export async function getCachedOpening(id: string) {
  const db = await getDb();
  return db.get("openings", id);
}

export async function updateCachedOpening(id: string, updater: (opening: any) => any) {
  const db = await getDb();
  const current = await db.get("openings", id);
  if (!current) return;
  await db.put("openings", updater(current));
}

export async function enqueueOutboxItem(item: Omit<OutboxItem, "attempts" | "createdAt" | "status">) {
  const db = await getDb();
  await db.put("outbox", { ...item, attempts: 0, status: "pending", createdAt: Date.now() });
}

export async function getOutbox(): Promise<OutboxItem[]> {
  const db = await getDb();
  return (await db.getAll("outbox")).map((item) => ({ ...item, status: item.status || "pending" }));
}

export async function removeOutboxItem(id: string) {
  const db = await getDb();
  await db.delete("outbox", id);
}

export async function updateOutboxItem(item: OutboxItem) {
  const db = await getDb();
  await db.put("outbox", item);
}

export async function enqueuePhotoOutboxItem(item: Omit<PhotoOutboxItem, "attempts" | "createdAt" | "status">) {
  const db = await getDb();
  await db.put("photoOutbox", { ...item, attempts: 0, status: "pending", createdAt: Date.now() });
}

export async function getPhotoOutbox(): Promise<PhotoOutboxItem[]> {
  const db = await getDb();
  return (await db.getAll("photoOutbox")).map((item) => ({
    ...item,
    status: item.status || "pending",
    relatedEntityType: item.relatedEntityType || "opening",
  }));
}

export async function getPhotoOutboxForOpening(openingId: string): Promise<PhotoOutboxItem[]> {
  const all = await getPhotoOutbox();
  return all.filter((p) => p.openingId === openingId);
}

export async function removePhotoOutboxItem(id: string) {
  const db = await getDb();
  await db.delete("photoOutbox", id);
}

export async function updatePhotoOutboxItem(item: PhotoOutboxItem) {
  const db = await getDb();
  await db.put("photoOutbox", item);
}

export async function retryOutboxItem(id: string, photo: boolean) {
  const db = await getDb();
  if (photo) {
    const item = await db.get("photoOutbox", id);
    if (item) await db.put("photoOutbox", { ...item, status: "pending", lastError: undefined });
    return;
  }
  const item = await db.get("outbox", id);
  if (item) await db.put("outbox", { ...item, status: "pending", lastError: undefined });
}

export async function saveAuth(auth: { token: string; userId: string; organizationId: string; role: string }) {
  const db = await getDb();
  await db.put("auth", { ...auth, savedAt: Date.now() }, "current");
}

export async function loadAuth() {
  const db = await getDb();
  return db.get("auth", "current");
}

export async function clearAuth() {
  const db = await getDb();
  await db.delete("auth", "current");
}
