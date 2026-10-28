// M3.1: an expired or rejected session sends the user back to sign-in
// instead of leaving the dashboard looking signed in with empty lists.

export const TOKEN_KEY = "oi_token";
export const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again.";
export const SESSION_EXPIRED_PARAM = "expired";

type KeyStore = Pick<Storage, "getItem" | "removeItem">;

/** Reads the token's exp claim without verifying it; the server stays authoritative. */
export function tokenExpiresAtMs(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch { return null; }
}

/** True when the token is malformed or its exp is in the past (with a small skew). */
export function isTokenExpired(token: string, nowMs: number = Date.now(), skewMs = 30_000): boolean {
  const exp = tokenExpiresAtMs(token);
  if (exp === null) return !/^[^.]+\.[^.]+\.[^.]*$/.test(token);
  return exp - skewMs <= nowMs;
}

/** Startup check: drop an expired token before any request is made. */
export function readValidToken(store: KeyStore | null, nowMs: number = Date.now()): string | null {
  try {
    const token = store?.getItem(TOKEN_KEY) ?? null;
    if (!token) return null;
    if (isTokenExpired(token, nowMs)) { store?.removeItem(TOKEN_KEY); return null; }
    return token;
  } catch { return null; }
}

/** Where a rejected session lands: the dashboard sign-in page with the expiry notice. */
export function sessionExpiredUrl(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  return `${base}login?${SESSION_EXPIRED_PARAM}=1`;
}

export interface SessionNav { pathname: string; assign: (url: string) => void }

/** Clear the token and go to sign-in, unless the user is already on the sign-in page. */
export function handleUnauthorized(store: KeyStore | null, nav: SessionNav | null, baseUrl: string): void {
  try { store?.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  if (!nav) return;
  const target = sessionExpiredUrl(baseUrl);
  if (nav.pathname.replace(/\/$/, "").endsWith("/login")) return;
  nav.assign(target);
}
