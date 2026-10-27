const tokenPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const isQrLandingPath = (path: string) => /^\/opening\/by-qr(?:\/|$)/i.test(path) && !isQrDetailsPath(path);
export const isQrDetailsPath = (path: unknown): path is string => typeof path === 'string'
  && new RegExp(`^/opening/by-qr/${tokenPattern}/details/?$`, 'i').test(path);
export const isQrLogin = (path: string, from: unknown) => path === '/login' && isQrDetailsPath(from);
export const validQrToken = (token: string) => new RegExp(`^${tokenPattern}$`, 'i').test(token);

export interface PublicOpeningSummary { facility_name: string; building_name: string; opening_code: string }
export async function fetchPublicOpening(token: string, signal: AbortSignal): Promise<PublicOpeningSummary> {
  if (!validQrToken(token)) throw new Error('unavailable');
  // Never read an auth store or send an application bearer token from this page.
  const response = await fetch(`/api/qr/${encodeURIComponent(token)}`, {
    // Same-origin cookies preserve the staging access gate; the response remains
    // the exact public DTO even if a browser has other authenticated cookies.
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('unavailable');
  const value = await response.json();
  const keys = ['facility_name', 'building_name', 'opening_code'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !keys.every(key => typeof value[key] === 'string')) throw new Error('unavailable');
  return { facility_name: value.facility_name, building_name: value.building_name, opening_code: value.opening_code };
}
