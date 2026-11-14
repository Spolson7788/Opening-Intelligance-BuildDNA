import { ApiError } from "./api";

// Same allow-list and URL as field-app/src/lib/siteAccess.ts (kept in sync by tests).
const ACCESS_ORIGINS = [
  "https://oi-connected-release-candidate.netlify.app",
  "https://oi-video-workflows-staging.netlify.app",
] as const;

export function siteAccessRenewalUrl(origin: string): string | null {
  if (!ACCESS_ORIGINS.some(allowed => allowed === origin)) return null;
  const root = `${new URL(origin).origin}/`;
  if (root.includes("?") || root.includes("#")) return null;
  return root;
}

export const SITE_ACCESS_LOGIN_MESSAGE = "Site access could not be verified. Your app password has not been rejected. Renew access to this private preview, then sign in again.";

// A 401/403 without the app's UUID reference came from the hosting gate, not from OI's login route.
export function isSiteAccessLoginError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403) && !err.reference;
}