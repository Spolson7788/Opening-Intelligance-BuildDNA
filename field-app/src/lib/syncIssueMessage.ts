/** Never render server response bodies or unknown error strings as recovery instructions. */
const REASONS: Record<string, string> = {
  site_access_required: "Access to this private site needs renewal. Your saved change remains on this device.",
  unexpected_response: "The service returned an unexpected response. Your saved change remains on this device. Restore site access and confirm the correct account before retrying.",
  internal_error: "The server could not save this change. It remains on this device until you retry or discard it.",
  photo_unreadable: "The failure photo could not be read. It remains on this device until you discard it and save the inspection again.",
  inspection_type_mismatch: "This inspection was saved with the wrong type. Discard it and save the fire door inspection again.",
  checklist_incomplete: "The checklist was incomplete. Discard it and save the inspection again.",
  fail_requires_photo: "A failed item is missing its photo. Discard it and save the inspection again.",
  fail_requires_note: "A failed item is missing its note. Discard it and save the inspection again.",
  media_too_large: "This file is too large to sync. It remains on this device until you discard it.",
  visit_finished: "This inspection is still on this device. That visit is already finished, so it was not added there. Save it without a visit, or save it in a new visit.",
};

export const DISCARDABLE_SYNC_ERRORS = new Set([
  "internal_error", "photo_unreadable", "inspection_type_mismatch", "checklist_incomplete",
  "fail_requires_photo", "fail_requires_note", "media_too_large",
]);

export function syncIssueCanDiscard(issue: { status: string; error?: string }): boolean {
  if (issue.error === "visit_finished") return false;
  if (issue.status === "permanent_failure" || issue.status === "rejected_too_large") return true;
  return Boolean(issue.error && DISCARDABLE_SYNC_ERRORS.has(issue.error)
    && ["retry_wait", "schema_blocked", "storage_pressure"].includes(issue.status));
}

export function syncIssueMessage(status: string, error?: string) {
  if (error && REASONS[error]) return REASONS[error];
  if (error && status === "permanent_failure" && /^[a-z][a-z0-9_]{0,40}$/.test(error)) {
    return `The server refused this change (${error}). It remains on this device until you retry or discard it.`;
  }
  if (status === "auth_required") return "This change is paused for an access check. Sign in to the account that created it and confirm access before retrying. It will not retry automatically.";
  if (status === "conflict") return "The server record has changed. Review the conflict before choosing whether to retry your local change.";
  if (status === "orphaned_media") return "This photo is saved locally but its upload operation needs to be restored.";
  if (["in_flight", "verifying"].includes(status)) return "Synchronization was interrupted. Recover the existing operation after checking access.";
  if (status === "retry_wait") return "Synchronization could not finish. Your change remains saved locally; check connectivity before retrying.";
  return "This saved change needs review before synchronization can continue.";
}
