export const DEVICE_STORAGE_MESSAGE = "This device's storage had a problem. Close and reopen the app, then try again. Your entries are kept on this screen.";

export function isDeviceStorageError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return name === "AbortError" || name === "InvalidStateError" || name === "UnknownError" || name === "QuotaExceededError"
    || /Connection to Indexed Database server lost/i.test(message)
    || /indexeddb|quotaexceeded|invalidstate|aborterror/i.test(message);
}

export function storageDiagnostic(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : "unknown";
  return `${name}: ${message}`.slice(0, 180);
}
