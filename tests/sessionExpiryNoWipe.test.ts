import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
// Follow-up to C2 (Stephan, 2026-10-29): ordinary session expiry must NEVER wipe on-device data.
// Only 401 session_revoked / 403 account_deactivated (with a server reference) wipe. Here the REAL
// server auth middleware produces the responses for an expired, invalid and missing token, and those
// exact responses are fed to the field app. Every store (including unsynced work) must survive.
// The database is never reached for these refusals (the pool throws if used). Synthetic data only.
vi.mock('../src/db/pool', () => ({ pool: {
  query: async () => { throw new Error('db_must_not_be_reached'); },
  connect: async () => { throw new Error('db_must_not_be_reached'); },
} }));
import { requireAuth } from '../src/middleware/auth';
import { closeFieldAppDb, getDb, loadAuth, putSyncOperation, saveAuth } from '../field-app/src/lib/db';
import { fetchMe, isSessionEnded } from '../field-app/src/lib/api';

const app = express();
app.get('/api/auth/me', requireAuth as any, (_req, res) => { res.json({ ok: true }); });
const account = { token: 'synthetic-device-token', userId: randomUUID(), organizationId: randomUUID(), role: 'technician' };
async function seedDevice() {
  await saveAuth(account);
  const db: any = await getDb();
  const opening = randomUUID();
  await db.put('openings', { id: opening, opening_code: 'SYN-EXP' });
  await db.put('outbox', { id: randomUUID(), kind: 'service_event', payload: {}, createdAt: 1, attempts: 0, status: 'pending' });
  await db.put('photoOutbox', { id: randomUUID(), openingId: opening, blob: new Uint8Array([1]), contentType: 'image/jpeg', relatedEntityType: 'opening', createdAt: 1, attempts: 0, status: 'pending' });
  await db.put('operations', { operationId: randomUUID(), openingId: opening, state: 'pending' });
  await db.put('media', { photoId: randomUUID(), openingId: opening, uploadState: 'pending', targetType: 'opening', targetId: opening });
}
async function counts() {
  const db: any = await getDb(); const out: Record<string, number> = {};
  for (const n of Array.from(db.objectStoreNames) as string[]) out[n] = await db.count(n);
  return out;
}
async function serverResponse(authHeader?: string) {
  const r = request(app).get('/api/auth/me'); if (authHeader) r.set('Authorization', authHeader);
  const res = await r;
  return { status: res.status, body: res.body };
}
beforeAll(() => { process.env.JWT_SECRET ||= 'synthetic-test-secret'; });
afterEach(async () => {
  vi.unstubAllGlobals(); await closeFieldAppDb();
  await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase('opening-intel-field'); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
});

describe('session expiry never wipes the device', () => {
  it('the server answers an expired token with 401 invalid_token (never session_revoked), without touching the database', async () => {
    const expired = jwt.sign({ userId: account.userId, organizationId: account.organizationId, role: 'technician', sessionVersion: 0, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET!);
    const r = await serverResponse('Bearer ' + expired);
    expect(r.status).toBe(401); expect(r.body.error).toBe('invalid_token'); expect(r.body.reference).toMatch(/^[0-9a-f-]{36}$/);
  });
  for (const [label, header] of [
    ['expired token', () => 'Bearer ' + jwt.sign({ userId: account.userId, organizationId: account.organizationId, role: 'technician', sessionVersion: 0, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET!)],
    ['token signed with another key', () => 'Bearer ' + jwt.sign({ userId: account.userId, organizationId: account.organizationId, role: 'technician' }, 'not-the-server-key')],
    ['missing token', () => undefined],
  ] as const) {
    it(`${label}: the real server response leaves every store, the sign-in and unsynced work intact`, async () => {
      await seedDevice();
      const before = await counts();
      expect(before.outbox).toBe(1); expect(before.photoOutbox).toBe(1); expect(before.operations).toBe(1);
      const r = await serverResponse(header());
      expect(r.status).toBe(401); expect(r.body.error).not.toBe('session_revoked');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })));
      const failure: any = await fetchMe().catch((e: unknown) => e);
      expect(isSessionEnded(failure)).toBe(false);
      expect(failure?.status).toBe(401);
      const after = await counts();
      expect(after.outbox).toBe(before.outbox);
      expect(after.photoOutbox).toBe(before.photoOutbox);
      expect(after.operations).toBe(before.operations);
      expect(after.media).toBe(before.media);
      expect(await loadAuth()).toBeFalsy();
      // Local writes are still allowed (no wipe latch).
      await putSyncOperation({ operationId: randomUUID(), openingId: randomUUID(), state: 'pending' } as any);
      expect((await counts()).operations).toBe(2);
    });
  }
});
