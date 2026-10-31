import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from './auth';
import { pool } from '../db/pool';
import { RECORD_WRITE_RETRY } from '../services/recognitionRunRecords';
// Records every 401/403 response on the recognition endpoints in recognition_access_denials
// (DRAFT migration 20261031090000, not applied). Mounted before requireAuth/requireRole, so
// sign-in and permission failures are recorded outside the handlers. Stores only the status, the
// error code, the endpoint family, the method, the auth reference and, when the caller's identity
// was verified, the user and active company (otherwise NULL: visible to OI staff only). Never the
// token, URL, query, ids from the path, or the body. Never changes the response.
const REASON = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const pending = new Set<Promise<void>>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type AccessDenial = { http_status: number; reason: string; endpoint: 'recognition_runs' | 'recognition'; method: string;
  user_id: string | null; organization_id: string | null; auth_reference: string | null };

export async function writeAccessDenial(d: AccessDenial): Promise<boolean> {
  for (let i = 0; i <= RECORD_WRITE_RETRY.delaysMs.length; i++) {
    if (i > 0) await sleep(RECORD_WRITE_RETRY.delaysMs[i - 1]);
    try {
      await pool.query('INSERT INTO recognition_access_denials(http_status,reason,endpoint,method,user_id,organization_id,auth_reference) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [d.http_status, d.reason, d.endpoint, d.method, d.user_id, d.organization_id, d.auth_reference]);
      return true;
    } catch { /* retry */ }
  }
  console.error('recognition_access_denial_lost', d.auth_reference ?? '');
  return false;
}

export function recordRecognitionAccessDenials(req: AuthedRequest, res: Response, next: NextFunction) {
  const endpoint = /^\/runs(\/|$)/.test(req.path) ? 'recognition_runs' : 'recognition';
  const method = METHODS.has((req.method || '').toUpperCase()) ? req.method.toUpperCase() : 'GET';
  let reason: string | null = null;
  const json = res.json.bind(res);
  res.json = ((body: any) => { if (body && typeof body.error === 'string') reason = body.error; return json(body); }) as typeof res.json;
  res.on('finish', () => {
    if (res.statusCode !== 401 && res.statusCode !== 403) return;
    const ref = String(res.getHeader('X-OI-Auth-Reference') ?? '');
    const verified = !!(req.auth?.userId && req.auth?.organizationId);
    const p = writeAccessDenial({ http_status: res.statusCode, reason: reason && REASON.test(reason) ? reason : 'unknown_reason', endpoint, method,
      user_id: verified ? req.auth!.userId : null, organization_id: verified ? req.auth!.organizationId : null, auth_reference: UUID.test(ref) ? ref : null })
      .then(() => undefined, () => undefined);
    pending.add(p); p.finally(() => pending.delete(p));
  });
  next();
}
// Tests: wait for in-flight denial writes.
export const flushAccessDenialWrites = () => Promise.all([...pending]).then(() => undefined);
