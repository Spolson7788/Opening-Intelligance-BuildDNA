/** Describe failures without confusing authorization or connectivity with a missing record. */
export function openingLoadFailure(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (status === 401) return {title: "Sign-in required", message: "Your session could not be verified. Sign in again to load this opening.", signIn: true, retry: false};
  if (status === 403) return {title: "Access unavailable", message: "Your account does not currently have permission to load this opening. Contact your administrator.", signIn: false, retry: false};
  if (status === 404) return {title: "Opening unavailable", message: "This opening was not found or is not available to your account. Check the code or contact your administrator.", signIn: false, retry: false};
  return {title: "Unable to load opening", message: "The connection or service is unavailable. Your saved record has not been reported missing. Try again when connected.", signIn: false, retry: true};
}
