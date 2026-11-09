export const DEVICE_STORAGE_MESSAGE = "This device's storage had a problem. Close and reopen the app, then try again. Your entries are kept on this screen.";

const STORAGE_ERROR_NAMES = new Set([
  "AbortError", "InvalidStateError", "UnknownError", "QuotaExceededError",
  "DataCloneError", "NotFoundError", "TransactionInactiveError", "SecurityError",
]);

export function isDeviceStorageError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return STORAGE_ERROR_NAMES.has(name)
    || /Connection to Indexed Database server lost/i.test(message)
    || /indexed database/i.test(message)
    || /internal error/i.test(message)
    || /indexeddb|quotaexceeded|invalidstate|aborterror|datacloneerror|notfounderror|transactioninactiveerror|securityerror/i.test(message);
}

export function storageDiagnostic(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const message = error instanceof Error ? error.message : "unknown";
  return `${name}: ${message}`.slice(0, 180);
}
