import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
const state = vi.hoisted(() => ({ db: null as any }));
// M5: add team member (temporary password or email invite), forced password change, invites.
// In-process disposable SQL only; synthetic data only; no network (email provider is faked).
vi.mock('../src/db/pool', () => ({ pool: {
  query: (s: string, a?: unknown[]) => state.db.query(s, a),
  connect: async () => ({ query: (s: string, a?: unknown[]) => state.db.query(s, a), release: () => {} }),
} }));
import { authRouter } from '../src/routes/auth';
import { membersRouter, invitesPublicRouter } from '../src/routes/members';
import { setEmailProviderForTests, emailSettings, resendProvider, OutboundEmail } from '../src/services/email';
import { acceptInviteUrl, inviteEmail } from '../src/services/inviteEmail';
import { canCreateRole, passwordProblem } from '../src/services/memberRules';
const app = express(); app.use(express.json());
app.use('/api/auth', authRouter); app.use('/api/members', membersRouter); app.use('/api/invites', invitesPublicRouter);
const migration = '20261029090000_member_onboarding.sql';
const sql = (s: string, a?: unknown[]) => state.db.query(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const exists = async () => (await sql("SELECT to_regclass('public.team_invites') AS n")).rows[0].n !== null;
const hasColumn = async () => (await sql("SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name='users' AND column_name='must_change_password'")).rows[0].c > 0;
let rollbackProven = false, undoProven = false;
const logs: string[] = [];
beforeAll(async () => {
  state.db = new PGlite();
  await state.db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < migration).sort()) await state.db.exec(fix(readFileSync('migrations/' + name, 'utf8')));
  await state.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY)');
  const script = readFileSync('migrations/' + migration, 'utf8');
  await state.db.exec('BEGIN;' + script + ';ROLLBACK;');
  rollbackProven = !(await exists()) && !(await hasColumn());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  await state.db.exec(readFileSync('docs/rollback/20261029090000_member_onboarding_rollback.sql', 'utf8'));
  undoProven = !(await exists()) && !(await hasColumn());
  await state.db.exec('BEGIN;' + script + ';COMMIT;');
  for (const k of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(JSON.stringify(a)); });
}, 120000);
afterAll(async () => { await state.db?.close(); });
afterEach(() => setEmailProviderForTests(null));

async function org() { const id = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic org','customer')", [id]); return id; }
async function user(orgId: string, role = 'admin', password = 'synthetic-pass-123') {
  const id = randomUUID(), email = id + '@example.invalid';
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic admin',$4,$5)", [id, orgId, email, role, await bcrypt.hash(password, 4)]);
  return { id, org: orgId, role, email, password, token: jwt.sign({ userId: id, organizationId: orgId, role, sessionVersion: 0 }, process.env.JWT_SECRET!) };
}
async function facility(orgId: string) {
  const portfolio = randomUUID(), property = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic portfolio')", [portfolio, orgId]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [property, portfolio]);
  return property;
}
const post = (u: any, path: string, body: any = {}) => request(app).post(path).set('Authorization', 'Bearer ' + u.token).send(body);
const get = (u: any, path: string) => request(app).get(path).set('Authorization', 'Bearer ' + u.token);
const email = () => `m-${randomUUID().slice(0, 8)}@example.com`;
const TEMP = 'Temporary-pass-42';
function fakeProvider() {
  const sent: OutboundEmail[] = [];
  setEmailProviderForTests({ name: 'fake', send: async (m) => { sent.push(m); return { sent: true }; } });
  return sent;
}
const tokenFrom = (m: OutboundEmail) => decodeURIComponent(/#invite=([A-Za-z0-9_%-]+)/.exec(m.text)![1]);
const auditRows = async (orgId: string) => (await sql('SELECT action, request_body::text AS body FROM audit_log WHERE organization_id=$1 ORDER BY created_at', [orgId])).rows;

describe('M5 migration', () => {
  it('is additive, rolls back cleanly in a transaction, and the undo script removes it', () => {
    expect(rollbackProven).toBe(true); expect(undoProven).toBe(true);
  });
  it('stores invite tokens hashed only', async () => {
    const cols = (await sql("SELECT column_name FROM information_schema.columns WHERE table_name='team_invites'")).rows.map((r: any) => r.column_name);
    expect(cols).toContain('token_hash'); expect(cols).not.toContain('token');
  });
});

describe('role rules', () => {
  it('only admins create members and nobody creates a role above their own', () => {
    expect(canCreateRole('admin', 'admin')).toEqual({ ok: true });
    expect(canCreateRole('facilities_manager', 'technician')).toEqual({ ok: false, error: 'admin_required' });
    expect(canCreateRole('admin', 'owner')).toEqual({ ok: false, error: 'invalid_role' });
    expect(passwordProblem('short')).toBe('password_too_short');
    expect(passwordProblem('x'.repeat(73))).toBe('password_too_long');
  });
  it('facilities managers and technicians are refused by the API', async () => {
    const o = await org(); const fm = await user(o, 'facilities_manager'); const tech = await user(o, 'technician');
    for (const u of [fm, tech]) {
      const r = await post(u, '/api/members', { full_name: 'X', email: email(), role: 'viewer', temporary_password: TEMP });
      expect(r.status).toBe(403); expect(r.body.error).toBe('admin_required');
      expect((await post(u, '/api/members/invites', { full_name: 'X', email: email(), role: 'viewer' })).status).toBe(403);
    }
  });
});

describe('direct add with temporary password', () => {
  it('forces a password change at first sign-in and gates every other route', async () => {
    const o = await org(); const admin = await user(o); const e = email();
    const add = await post(admin, '/api/members', { full_name: 'New Tech', email: e, role: 'technician', temporary_password: TEMP, is_test_account: false });
    expect(add.status).toBe(201);
    expect(add.body.must_change_password).toBe(true);
    expect(JSON.stringify(add.body)).not.toContain(TEMP); expect(add.body.password_hash).toBeUndefined();
    const login = await request(app).post('/api/auth/login').send({ email: e, password: TEMP });
    expect(login.body.must_change_password).toBe(true);
    expect((jwt.decode(login.body.token) as any).mustChangePassword).toBe(true);
    const t = { token: login.body.token };
    expect((await get(t, '/api/auth/users')).body.error).toBe('password_change_required');
    expect((await get(t, '/api/auth/me')).body.must_change_password).toBe(true);
    expect((await post(t, '/api/auth/change-password', { current_password: TEMP, new_password: TEMP })).body.error).toBe('password_unchanged');
    expect((await post(t, '/api/auth/change-password', { current_password: 'wrong-pass-123', new_password: 'Brand-new-pass-1' })).status).toBe(401);
    const ch = await post(t, '/api/auth/change-password', { current_password: TEMP, new_password: 'Brand-new-pass-1' });
    expect(ch.status).toBe(200);
    expect((await get(t, '/api/auth/me')).body.error).toBe('session_revoked');
    const fresh = { token: ch.body.token };
    expect((await get(fresh, '/api/auth/users')).status).toBe(200);
    expect((await get(fresh, '/api/auth/me')).body.password_changed_at).toBeTruthy();
    const audit = await auditRows(o);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['Added team member', 'Changed own password']));
    expect(JSON.stringify(audit)).not.toContain(TEMP); expect(JSON.stringify(audit)).not.toContain('Brand-new-pass-1');
  });
  it('a test account skips the forced change and the flag is audit-logged', async () => {
    const o = await org(); const admin = await user(o); const e = `tech-${randomUUID().slice(0, 6)}@oi-nonprod.invalid`;
    const add = await post(admin, '/api/members', { full_name: 'Test Tech', email: e, role: 'technician', temporary_password: TEMP, is_test_account: true });
    expect(add.body.must_change_password).toBe(false); expect(add.body.is_test_account).toBe(true);
    const login = await request(app).post('/api/auth/login').send({ email: e, password: TEMP });
    expect(login.body.must_change_password).toBe(false);
    expect((await get({ token: login.body.token }, '/api/auth/users')).status).toBe(200);
    const a = (await auditRows(o)).find((r: any) => r.action === 'Added team member');
    expect(JSON.parse(a.body).is_test_account).toBe(true);
  });
  it('validates the default facility against the caller and rejects duplicates', async () => {
    const o = await org(); const admin = await user(o); const mine = await facility(o); const other = await facility(await org());
    expect((await post(admin, '/api/members', { full_name: 'A', email: email(), role: 'viewer', temporary_password: TEMP, default_property_id: other })).body.error).toBe('default_property_not_accessible');
    const e = email();
    const ok = await post(admin, '/api/members', { full_name: 'A', email: e, role: 'viewer', temporary_password: TEMP, default_property_id: mine });
    expect(ok.body.default_property_id).toBe(mine);
    expect((await post(admin, '/api/members', { full_name: 'A', email: e, role: 'viewer', temporary_password: TEMP })).status).toBe(409);
    expect((await post(admin, '/api/members', { full_name: 'A', email: email(), role: 'viewer', temporary_password: 'short' })).body.error).toBe('password_too_short');
  });
});

describe('email invites', () => {
  it('without email configured: invite created, not sent, token never returned or logged', async () => {
    setEmailProviderForTests(null);
    const o = await org(); const admin = await user(o); logs.length = 0;
    const r = await post(admin, '/api/members/invites', { full_name: 'Invitee', email: email(), role: 'technician' });
    expect(r.status).toBe(201);
    expect(r.body.email).toEqual({ sent: false, status: 'not_configured' });
    expect(r.body.invite.token_hash).toBeUndefined(); expect(r.body.token).toBeUndefined();
    const stored = (await sql('SELECT token_hash FROM team_invites WHERE id=$1', [r.body.invite.id])).rows[0].token_hash;
    expect(JSON.stringify(r.body) + logs.join('') + JSON.stringify(await auditRows(o))).not.toContain(stored);
    const list = await get(admin, '/api/members/invites');
    expect(list.body.email_configured).toBe(false); expect(list.body.invites).toHaveLength(1);
  });
  it('sends, previews, accepts once, and the invitee signs in with their own password', async () => {
    const sent = fakeProvider();
    const o = await org(); const admin = await user(o); const prop = await facility(o); const e = email(); logs.length = 0;
    const r = await post(admin, '/api/members/invites', { full_name: 'Invitee', email: e, role: 'inspector', default_property_id: prop });
    expect(r.body.email).toEqual({ sent: true, status: 'sent' });
    expect(sent).toHaveLength(1); expect(sent[0].to).toBe(e);
    const token = tokenFrom(sent[0]);
    expect(JSON.stringify(r.body) + logs.join('') + JSON.stringify(await auditRows(o))).not.toContain(token);
    const row = (await sql('SELECT token_hash FROM team_invites WHERE id=$1', [r.body.invite.id])).rows[0];
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect((await request(app).post('/api/invites/preview').send({ token })).body.email).toBe(e);
    expect((await request(app).post('/api/invites/accept').send({ token, password: 'short' })).body.error).toBe('password_too_short');
    const acc = await request(app).post('/api/invites/accept').send({ token, password: 'Invitee-chosen-1' });
    expect(acc.status).toBe(201);
    expect((jwt.decode(acc.body.token) as any).mustChangePassword).toBeUndefined();
    expect((await request(app).post('/api/invites/accept').send({ token, password: 'Invitee-chosen-2' })).status).toBe(410);
    const login = await request(app).post('/api/auth/login').send({ email: e, password: 'Invitee-chosen-1' });
    expect(login.status).toBe(200);
    const me = await get({ token: login.body.token }, '/api/auth/me');
    expect(me.body.role).toBe('inspector'); expect(me.body.default_property_id).toBe(prop); expect(me.body.must_change_password).toBe(false);
    const actions = (await auditRows(o)).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['Created team invite', 'Accepted team invite']));
    expect(JSON.stringify(await auditRows(o))).not.toContain('Invitee-chosen-1');
    expect((await get(admin, '/api/members/invites')).body.invites).toHaveLength(0);
  });
  it('resend rotates the token; revoke kills it; expired tokens are refused; cooldown applies', async () => {
    const sent = fakeProvider();
    const o = await org(); const admin = await user(o);
    const r = await post(admin, '/api/members/invites', { full_name: 'Invitee', email: email(), role: 'viewer' });
    const first = tokenFrom(sent[0]);
    const tooSoon = await post(admin, `/api/members/invites/${r.body.invite.id}/resend`);
    expect(tooSoon.status).toBe(429); expect(tooSoon.body.retry_after_seconds).toBeGreaterThan(0);
    await sql("UPDATE team_invite_sends SET created_at=now()-interval '2 minutes' WHERE invite_id=$1", [r.body.invite.id]);
    expect((await post(admin, `/api/members/invites/${r.body.invite.id}/resend`)).status).toBe(200);
    const second = tokenFrom(sent[1]); expect(second).not.toBe(first);
    expect((await request(app).post('/api/invites/preview').send({ token: first })).status).toBe(410);
    expect((await request(app).post('/api/invites/preview').send({ token: second })).status).toBe(200);
    await sql("UPDATE team_invites SET expires_at=now()-interval '1 second', created_at=now()-interval '8 days' WHERE id=$1", [r.body.invite.id]);
    expect((await request(app).post('/api/invites/accept').send({ token: second, password: 'Whatever-pass-1' })).status).toBe(410);
    expect((await post(admin, `/api/members/invites/${r.body.invite.id}/revoke`)).status).toBe(200);
    expect((await post(admin, `/api/members/invites/${r.body.invite.id}/revoke`)).status).toBe(409);
    expect((await auditRows(o)).map((a: any) => a.action)).toEqual(expect.arrayContaining(['Resent team invite', 'Revoked team invite']));
    const other = await user(await org());
    expect((await post(other, `/api/members/invites/${r.body.invite.id}/resend`)).status).toBe(404);
  });
  it('rate-limits invite sends per organization and blocks duplicate open invites', async () => {
    fakeProvider();
    const o = await org(); const admin = await user(o); const e = email();
    expect((await post(admin, '/api/members/invites', { full_name: 'I', email: e, role: 'viewer' })).status).toBe(201);
    expect((await post(admin, '/api/members/invites', { full_name: 'I', email: e, role: 'viewer' })).body.error).toBe('invite_pending');
    expect((await post(admin, '/api/members', { full_name: 'I', email: e, role: 'viewer', temporary_password: TEMP })).body.error).toBe('invite_pending');
    const inv = (await sql('SELECT id FROM team_invites WHERE organization_id=$1', [o])).rows[0].id;
    for (let i = 0; i < 29; i++) await sql("INSERT INTO team_invite_sends(id,invite_id,organization_id,sent_by_user_id,outcome) VALUES($1,$2,$3,$4,'sent')", [randomUUID(), inv, o, admin.id]);
    const r = await post(admin, '/api/members/invites', { full_name: 'I', email: email(), role: 'viewer' });
    expect(r.status).toBe(429); expect(r.body.scope).toBe('organization');
  });
});

describe('email provider and template', () => {
  it('is configured only when every env name is present, and never exposes values', () => {
    expect(emailSettings({}).configured).toBe(false);
    const s = emailSettings({ EMAIL_PROVIDER: 'resend', EMAIL_PROVIDER_API_KEY: 'k-synthetic', EMAIL_FROM: 'OI <i@example.com>', APP_BASE_URL: 'https://example.netlify.app/' });
    expect(s.configured).toBe(true); expect(s.baseUrl).toBe('https://example.netlify.app'); expect(JSON.stringify(s)).not.toContain('k-synthetic');
    expect(emailSettings({ EMAIL_PROVIDER: 'resend', EMAIL_PROVIDER_API_KEY: 'k', EMAIL_FROM: 'i@example.com', APP_BASE_URL: 'http://evil.example' }).configured).toBe(false);
  });
  it('posts to Resend over HTTPS and reports failures without the body', async () => {
    const calls: any[] = []; logs.length = 0;
    const ok = resendProvider('k-synthetic', 'i@example.com', async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; });
    expect(await ok.send({ to: 'a@example.com', subject: 's', text: 'secret-link', html: 'h' })).toEqual({ sent: true });
    expect(calls[0].url).toBe('https://api.resend.com/emails'); expect(JSON.parse(calls[0].init.body).to).toEqual(['a@example.com']);
    const bad = resendProvider('k-synthetic', 'i@example.com', async () => ({ ok: false, status: 422 }));
    expect(await bad.send({ to: 'a@example.com', subject: 's', text: 'secret-link', html: 'h' })).toEqual({ sent: false, reason: 'email_send_failed' });
    expect(logs.join('')).not.toContain('secret-link'); expect(logs.join('')).not.toContain('k-synthetic');
  });
  it('renders text and HTML with the app name and an escaped accept link in the fragment', () => {
    const url = acceptInviteUrl('https://example.netlify.app/', 'tok_EN');
    expect(url).toBe('https://example.netlify.app/dashboard/accept-invite#invite=tok_EN');
    const m = inviteEmail({ to: 'a@example.com', inviteeName: '<b>Al</b>', inviterName: 'Admin', organizationName: 'Org', role: 'technician', acceptUrl: url, expiresAt: new Date('2026-11-04T00:00:00Z') });
    expect(m.subject).toContain('Opening Intelligence'); expect(m.text).toContain(url); expect(m.html).toContain(url);
    expect(m.html).not.toContain('<b>Al</b>'); expect(m.text).toContain('Technician');
  });
});