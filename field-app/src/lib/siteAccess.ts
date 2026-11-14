export const SITE_ACCESS_REQUIRED = "site_access_required";
const ACCESS_ORIGINS = [
  "https://oi-connected-release-candidate.netlify.app",
  "https://oi-video-workflows-staging.netlify.app",
] as const;

// Inspect text only. Never execute response HTML or derive a navigation target from it.
export function isNetlifyAccessResponse(status: number, contentType: string, text: string) {
  // Normalize only escaped slashes; never execute or navigate from response text.
  const normalized = text.replace(/\\\//g, "/");
  return status === 401 && contentType.split(";")[0].trim().toLowerCase() === "text/html"
    && /<title>\s*Login Redirect\s*<\/title>/i.test(text)
    && ACCESS_ORIGINS.some(origin => {
      const host = new URL(origin).hostname.replace(/\./g, "\\.");
      // Netlify may encode the following query separator as literal \u0026.
      // Accept it only at this exact hostname boundary; do not decode response scripts.
      return new RegExp(`https://app\\.netlify\\.com/edge-access\\?domain=${host}(?:["'&\\s<]|\\\\u0026|$)`).test(normalized);
    });
}

export const FIELD_AFTER_GATE = "/field/";
export const FIELD_GATE_RETURN_KEY = "oi_field_after_gate";

// Top-level visit to this host's root. Netlify shows its team login there.
// The edge-access URL with a domain query is a Bad request on iPhone Safari.
export function siteAccessRenewalUrl(origin: string): string | null {
  if (!ACCESS_ORIGINS.some(allowed => allowed === origin)) return null;
  const root = `${new URL(origin).origin}/`;
  if (root.includes("?") || root.includes("#")) return null;
  return root;
}

export function renewPrivateSiteAccess(
  location: { origin: string; assign: (url: string) => void },
  storage?: { setItem: (key: string, value: string) => void },
) {
  const root = siteAccessRenewalUrl(location.origin);
  if (!root) return;
  try { storage?.setItem(FIELD_GATE_RETURN_KEY, FIELD_AFTER_GATE); } catch { /* still open the gate */ }
  location.assign(root);
}

export function consumeFieldGateReturn(
  storage: { getItem: (key: string) => string | null; removeItem: (key: string) => void },
  pathname: string,
  replace: (url: string) => void,
) {
  let back: string | null = null;
  try { back = storage.getItem(FIELD_GATE_RETURN_KEY); } catch { return; }
  if (back !== FIELD_AFTER_GATE) return;
  try { storage.removeItem(FIELD_GATE_RETURN_KEY); } catch { /* still leave the gate page */ }
  if (pathname === "/field" || pathname.startsWith("/field/")) return;
  replace(FIELD_AFTER_GATE);
}

export function fieldLoginPath(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const path = `${base}login`;
  return path.includes("?") || path.includes("#") ? "/field/login" : path;
}

export function redirectToFieldLogin(baseUrl: string, currentPath: string, assign: (url: string) => void) {
  const login = fieldLoginPath(baseUrl);
  if (currentPath === login || currentPath === login.replace(/\/$/, "")) return;
  assign(login);
}

export function isAppSessionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  if ((error as { status?: number }).status !== 401) return false;
  const message = error instanceof Error ? error.message : "";
  return message !== "session_revoked" && message !== SITE_ACCESS_REQUIRED;
}
