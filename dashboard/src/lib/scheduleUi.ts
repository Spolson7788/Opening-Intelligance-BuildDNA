import { ApiError, type ScheduleImportResolutions } from "./api";

// M3 UI round: pure helpers shared by the schedule pages and the login page.

export type ScheduleKind = "door" | "hardware";

/** Item 2: guess the schedule type from the file name. The user can still change it. */
export function kindForFilename(name: string): ScheduleKind | null {
  const ext = (name.toLowerCase().split(".").pop() ?? "").trim();
  if (ext === "docx") return "hardware";
  if (ext === "xlsx" || ext === "csv" || ext === "xls") return "door";
  return null;
}

/** Item 6: shown when the signed-in account's organization has no facilities. */
export const NO_FACILITIES_MESSAGE = "This account has no facilities. Sign in with the account that owns the facility.";

/** Item 7: only a real credential rejection says the password didn't match. */
export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 && err.message === "invalid_credentials") return "Email or password didn't match. Try again.";
    if (err.status === 403) return "This account is deactivated.";
  }
  return "Couldn't reach the sign-in service. Reload the page and try again.";
}

/** Item 5: unsaved review choices are kept on this device, per import id, until confirm. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const importDraftKey = (importId: string) => `oi.scheduleImportDraft.${importId}`;
function browserStorage(): DraftStorage | null {
  try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}
export function isEmptyResolutions(r: ScheduleImportResolutions): boolean {
  return Object.keys(r.rows ?? {}).length === 0 && Object.keys(r.set_map ?? {}).length === 0 && Object.keys(r.row_sets ?? {}).length === 0
    && (r.accept_items ?? []).length === 0 && (r.overwrite ?? []).length === 0;
}
export function saveImportDraft(importId: string, res: ScheduleImportResolutions, storage: DraftStorage | null = browserStorage()): void {
  try {
    if (!storage) return;
    if (isEmptyResolutions(res)) storage.removeItem(importDraftKey(importId));
    else storage.setItem(importDraftKey(importId), JSON.stringify({ v: 1, res }));
  } catch { /* storage full or blocked: drafts are best effort */ }
}
export function loadImportDraft(importId: string, storage: DraftStorage | null = browserStorage()): ScheduleImportResolutions | null {
  try {
    const raw = storage?.getItem(importDraftKey(importId));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || p.v !== 1 || typeof p.res !== "object" || p.res === null || Array.isArray(p.res)) return null;
    return { rows: {}, set_map: {}, row_sets: {}, accept_items: [], overwrite: [], ...p.res };
  } catch { return null; }
}
export function clearImportDraft(importId: string, storage: DraftStorage | null = browserStorage()): void {
  try { storage?.removeItem(importDraftKey(importId)); } catch { /* ignore */ }
}

/** M3.1: facilities failed to load. A 401 is handled by the session-expired redirect. */
export function facilitiesErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Your session expired. Sign in again.";
    return `Could not load facilities (${err.status}${err.message ? " " + err.message : ""}). Try again.`;
  }
  return "Could not load facilities (network error). Try again.";
}

/** M3B: warning shown before changing a schedule's type when the current file looks like the other type. */
export function kindChangeWarning(target: ScheduleKind, filename: string | undefined): string | null {
  const guess = filename ? kindForFilename(filename) : null;
  if (!guess || guess === target) return null;
  return `The current file (${filename}) looks like a ${guess === "door" ? "door" : "hardware"} schedule, not a ${target} schedule. Change the type anyway?`;
}

/** M3B: friendly text for the type-change / archive API errors. */
export function scheduleChangeErrorMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.message : "";
  if (code === "schedule_used_by_confirmed_import") return "This schedule was used by a confirmed import, so its type can't be changed.";
  if (code === "insufficient_role_for_action") return "Your role cannot change schedules.";
  if (code === "schedule_archived") return "Unarchive the schedule first.";
  if (code === "kind_unchanged") return "The schedule already has that type.";
  return "The change failed. Nothing was changed.";
}

export const STALE_IMPORT_MESSAGE = "A schedule used by this draft changed type after it was started. Start the import again to continue.";
