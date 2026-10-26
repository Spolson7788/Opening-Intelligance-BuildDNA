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
      return new RegExp(`https://app\\.netlify\\.com/edge-access\\?domain=${host}(?:["'&\\s<]|$)`).test(normalized);
    });
}

export function siteAccessRenewalUrl(origin: string): string | null {
  return ACCESS_ORIGINS.some(allowed => allowed === origin)
    ? `https://app.netlify.com/edge-access?domain=${new URL(origin).hostname}`
    : null;
}
