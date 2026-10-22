export const SITE_ACCESS_REQUIRED = "site_access_required";
const CANDIDATE_ORIGIN = "https://oi-connected-release-candidate.netlify.app";

// Inspect text only. Never execute response HTML or derive a navigation target from it.
export function isNetlifyAccessResponse(status: number, contentType: string, text: string) {
  // Normalize only escaped slashes; never execute or navigate from response text.
  const normalized = text.replace(/\\\//g, "/");
  return status === 401 && contentType.split(";")[0].trim().toLowerCase() === "text/html"
    && /<title>\s*Login Redirect\s*<\/title>/i.test(text)
    && /https:\/\/app\.netlify\.com\/edge-access\?domain=oi-connected-release-candidate\.netlify\.app(?:["'&\s<]|$)/.test(normalized);
}

export function siteAccessRenewalUrl(origin: string): string | null {
  return origin === CANDIDATE_ORIGIN
    ? "https://app.netlify.com/edge-access?domain=oi-connected-release-candidate.netlify.app"
    : null;
}
