import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// C3 draft migrations: offline PGlite only, synthetic data only.
const C3 = ['20261030090000_platform_staff', '20261030090100_platform_audit_events', '20261030090200_user_history_and_provider_requests'];
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
let db: PGlite; const sql = (s: string, a?: unknown[]) => db.query(s, a);
const tables = async () => (await sql("SELECT table_name FROM information_schema.tables WHERE table_name IN ('platform_staff','platform_audit_events','provider_assignment_requests','user_history') ORDER BY 1")).rows.map((r: any) => r.table_name);
const fails = async (s: string, a: unknown[], msg: RegExp) => { await expect(sql(s, a)).rejects.toThrow(msg); };
let rolledBack: string[] = [], undone: string[] = [];
const id: Record<string, string> = {};
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < C3[0]).sort()) await db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const all = C3.map(n => readFileSync(`migrations/${n}.sql`, 'utf8')).join('\n;\n');
  await db.exec('BEGIN;' + all + ';ROLLBACK;'); rolledBack = await tables();
  await db.exec('BEGIN;' + all + ';COMMIT;');
  for (const n of [...C3].reverse()) await db.exec(readFileSync(`docs/rollback/${n}_rollback.sql`, 'utf8'));
  undone = await tables();
  await db.exec('BEGIN;' + all + ';COMMIT;');
  const org = async (t: string) => { const i = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [i, 'Synthetic ' + t, t]); return i; };
  const user = async (o: string, role: string) => { const i = randomUUID(); await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic',$4,'not-a-real-hash')", [i, o, i + '@example.invalid', role]); return i; };
  id.oi = await org('internal'); id.cust = await org('customer'); id.prov = await org('service_partner');
  id.staff = await user(id.oi, 'admin'); id.staff2 = await user(id.oi, 'admin');
  id.custAdmin = await user(id.cust, 'admin'); id.custTech = await user(id.cust, 'technician'); id.provAdmin = await user(id.prov, 'admin');
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'bootstrap')", [id.staff]);
}, 120000);
afterAll(async () => { await db?.close(); });

describe('C3 draft migrations', () => {
  it('roll back in a transaction and have working undo scripts', () => { expect(rolledBack).toEqual([]); expect(undone).toEqual([]); });
  it('allow only one internal org', async () => { await fails("INSERT INTO organizations(name,org_type) VALUES('Second OI','internal')", [], /duplicate|unique/i); });
  it('staff must be internal, allows several founding rows, no self-grant, and revocation is final', async () => {
    await fails("INSERT INTO platform_staff(user_id,granted_by_user_id,grant_reason) VALUES($1,$2,'x')", [id.custAdmin, id.staff], /platform_staff_must_be_internal/);
    await fails("INSERT INTO platform_staff(user_id,granted_by_user_id,grant_reason) VALUES($1,$1,'self')", [id.staff2], /check/i);
    await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'second founding row')", [id.staff2]);
    expect((await sql('SELECT is_platform_staff($1) s', [id.staff2])).rows[0]).toEqual({ s: true });
    expect((await sql('SELECT is_platform_staff($1) s', [id.custAdmin])).rows[0]).toEqual({ s: false });
    await sql("UPDATE platform_staff SET revoked_at=now(),revoked_by_user_id=$2,revoke_reason='left' WHERE user_id=$1", [id.staff2, id.staff]);
    expect((await sql('SELECT is_platform_staff($1) s', [id.staff2])).rows[0]).toEqual({ s: false });
    await fails('UPDATE platform_staff SET revoked_at=NULL,revoked_by_user_id=NULL WHERE user_id=$1', [id.staff2], /immutable/);
  });
  it('audit events are append-only', async () => {
    await sql("INSERT INTO platform_audit_events(actor_user_id,actor_org_id,action,target_org_id) VALUES($1,$2,'user_deactivated',$3)", [id.custAdmin, id.cust, id.cust]);
    await fails('UPDATE platform_audit_events SET reason=$1', ['x'], /append_only/);
    await fails('DELETE FROM platform_audit_events', [], /append_only/);
  });
  it('deactivation is immediate: same-org admin or staff records history; append-only, no passwords', async () => {
    const h = "INSERT INTO user_history(user_id,organization_id,changed_by_user_id,change,reason,before_state,after_state) VALUES($1,$2,$3,$4,'left company',$5,$6)";
    await sql(h, [id.custTech, id.cust, id.custAdmin, 'deactivate', { is_active: true }, { is_active: false }]);
    await sql(h, [id.custTech, id.cust, id.staff, 'reactivate', { is_active: false }, { is_active: true }]);
    await fails(h, [id.custTech, id.cust, id.provAdmin, 'deactivate', {}, {}], /actor_not_allowed/);
    await fails(h, [id.custAdmin, id.cust, id.custAdmin, 'deactivate', {}, {}], /no_self_change/);
    await fails(h, [id.custTech, id.cust, id.custAdmin, 'role_change', { password_hash: 'x' }, {}], /check/i);
    await fails('DELETE FROM user_history', [], /append_only/);
    expect((await sql('SELECT count(*)::int n FROM user_history')).rows[0]).toEqual({ n: 2 });
  });
  it('provider assignment requests: facility admin requests, one pending, OI staff review, closed is final', async () => {
    const pf = randomUUID(), prop = randomUUID();
    await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'P')", [pf, id.cust]);
    await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'Synthetic facility')", [prop, pf]);
    const q = "INSERT INTO provider_assignment_requests(property_id,provider_organization_id,requested_by_user_id,reason) VALUES($1,$2,$3,'need doors serviced') RETURNING id";
    await fails(q, [prop, id.prov, id.custTech], /not_facility_admin/);
    await fails(q, [prop, id.prov, id.provAdmin], /not_facility_admin/);
    await fails(q, [prop, id.cust, id.custAdmin], /not_a_provider/);
    const r = (await sql(q, [prop, id.prov, id.custAdmin])).rows[0] as any;
    await fails(q, [prop, id.prov, id.custAdmin], /duplicate|unique/i);
    await fails("UPDATE provider_assignment_requests SET status='approved',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1", [r.id, id.custAdmin], /reviewer_must_be_oi_staff/);
    await sql("UPDATE provider_assignment_requests SET status='approved',reviewed_by_user_id=$2,reviewed_at=now() WHERE id=$1", [r.id, id.staff]);
    await fails("UPDATE provider_assignment_requests SET review_note='x' WHERE id=$1", [r.id], /closed/);
    await fails('DELETE FROM provider_assignment_requests WHERE id=$1', [r.id], /no_delete/);
  });
  it('does not alter the users table', async () => {
    const cols = (await sql("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='access_suspended_at'")).rows;
    expect(cols).toEqual([]);
  });
});
