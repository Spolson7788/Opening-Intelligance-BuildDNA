import { isNetlifyAccessResponse } from './siteAccess';
const tokenPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const isQrLandingPath = (path: string) => /^\/opening\/by-qr(?:\/|$)/i.test(path) && !isQrDetailsPath(path);
export const isQrDetailsPath = (path: unknown): path is string => typeof path === 'string'
  && new RegExp(`^/opening/by-qr/${tokenPattern}/details/?$`, 'i').test(path);
export const isQrLogin = (path: string, from: unknown) => path === '/login' && isQrDetailsPath(from);
export const validQrToken = (token: string) => new RegExp(`^${tokenPattern}$`, 'i').test(token);

export interface PublicOpeningSummary { facility_name: string; building_name: string; opening_code: string }
export type QrFailureKind = 'site_access' | 'service' | 'network' | 'unavailable';
export class QrInformationError extends Error {
  readonly kind: QrFailureKind;
  constructor(kind: QrFailureKind) { super('unavailable'); this.kind = kind; }
}
// Inspect only a bounded HTML body. Never render it or navigate to its contents.
async function gateBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) return '';
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function fetchPublicOpening(token: string, signal: AbortSignal): Promise<PublicOpeningSummary> {
  if (!validQrToken(token)) throw new Error('unavailable');
  // Never read an auth store or send an application bearer token from this page.
  let response: Response;
  try { response = await fetch(`/api/qr/${encodeURIComponent(token)}`, {
    // Same-origin cookies preserve the staging access gate; the response remains
    // the exact public DTO even if a browser has other authenticated cookies.
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
  }); } catch { throw new QrInformationError(signal.aborted ? 'unavailable' : 'network'); }
  const type = response.headers.get('content-type') || '';
  if (response.status === 401 && type.split(';')[0].trim().toLowerCase() === 'text/html') {
    let body = '';
    try { body = await gateBody(response); } catch { /* Unknown bodies remain unavailable. */ }
    throw new QrInformationError(isNetlifyAccessResponse(response.status, type, body) ? 'site_access' : 'unavailable');
  }
  if (response.status === 429 || response.status === 503) throw new QrInformationError('service');
  if (!response.ok || !type.toLowerCase().startsWith('application/json')) throw new QrInformationError('unavailable');
  const value = await response.json();
  const keys = ['facility_name', 'building_name', 'opening_code'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !keys.every(key => typeof value[key] === 'string')) throw new Error('unavailable');
  return { facility_name: value.facility_name, building_name: value.building_name, opening_code: value.opening_code };
}
