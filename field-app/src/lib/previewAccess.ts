// A precached Field App can open after the hosting access session expires.
// Fetch cannot execute Netlify's HTML login redirect; recovery must navigate.
export const PREVIEW_ACCESS_EVENT = 'oi-preview-access-required';
export const PREVIEW_ACCESS_PATH = '/preview-access';

export function requestPreviewAccess() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PREVIEW_ACCESS_EVENT));
}

export async function readResponseBody(response: Response): Promise<any> {
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (type !== 'application/json' && !type?.endsWith('+json')) return null;
  return response.json().catch(() => null);
}

export function isUnverifiedSiteAccess(response: Response, body: any): boolean {
  // A correlated application refusal remains an application refusal. Do not
  // renew hosting access for wrong credentials, revoked sessions or roles.
  const correlated = typeof body?.error === 'string' &&
    typeof body?.reference === 'string' && /^[0-9a-f-]{36}$/i.test(body.reference);
  const knownDenial = ['forbidden', 'account_deactivated', 'missing_token',
    'invalid_token', 'session_revoked', 'invalid_token_subject'].includes(body?.error);
  const applicationRefusal = correlated || knownDenial;
  return [401, 403].includes(response.status) && !applicationRefusal;
}
