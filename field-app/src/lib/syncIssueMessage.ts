/** Never render server response bodies or unknown error strings as recovery instructions. */
export function syncIssueMessage(status: string, error?: string) {
  if (error === "site_access_required") return "Access to this private site needs renewal. Your saved change remains on this device.";
  if (error === "unexpected_response") return "The service returned an unexpected response. Your saved change remains on this device. Restore site access and confirm the correct account before retrying.";
  if (status === "auth_required") return "This change is paused for an access check. Sign in to the account that created it and confirm access before retrying. It will not retry automatically.";
  if (status === "conflict") return "The server record has changed. Review the conflict before choosing whether to retry your local change.";
  if (status === "orphaned_media") return "This photo is saved locally but its upload operation needs to be restored.";
  if (["in_flight", "verifying"].includes(status)) return "Synchronization was interrupted. Recover the existing operation after checking access.";
  if (status === "retry_wait") return "Synchronization could not finish. Your change remains saved locally; check connectivity before retrying.";
  return "This saved change needs review before synchronization can continue.";
}
