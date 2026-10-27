import { getObjectBytes } from "./storage";

// Seam for tests: the import route reads stored schedule files only through
// this module, which delegates to the existing storage service.
export async function readScheduleFile(storageKey: string, maxBytes: number): Promise<Uint8Array> {
  return getObjectBytes(storageKey, maxBytes);
}
