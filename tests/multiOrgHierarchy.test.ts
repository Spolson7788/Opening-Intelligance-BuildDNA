import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// DRAFT multi-company memberships + customer hierarchy. Offline PGlite, synthetic data only.
const M = ['20261030090400_organization_hierarchy', '20261030090500_organization_memberships'];
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
let db: PGlite;
const sql = (s: string, a?: unknown[]) => db.query<any>(s, a);
const fails = async (s: string, a: unknown[], msg: RegExp) => { await expect(sql(s, a)).rejects.toThrow(msg); };
const id: Record<string, string> = {};
let rolledBack = 0, undone = 0, staffBefore: boolean | null = null;
const shape = async () => (await sql("SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_name='organization_memberships') + (SELECT count(*)::int FROM information_schema.columns WHERE table_name='organizations' AND column_name='parent_organization_id') n")).rows[0].n;
const setParent = async (org: string, parent: string | null, actor: string | null, reason = 'OI review', confirm = false) => {
  const cfg = (actor ? `SELECT set_config('oi.actor_user_id','${actor}',true), set_config('oi.reason','${reason}',true);` : '') + (confirm ? `SELECT set_config('oi.confirm_provider_link','confirmed',true);` : '');
  try { await db.exec(`BEGIN; ${cfg} UPDATE organizations SET parent_organization_id=${parent ? `'${parent}'` : 'NULL'} WHERE id='${org}'; COMMIT;`); }
  catch (e) { await db.exec('ROLLBACK'); throw e; }
};
const orgs = async (u: string) => (await sql('SELECT organization_id, role FROM user_authorized_orgs($1) ORDER BY organization_id', [u])).rows;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < M[0]).sort()) await db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  const org = async (k: string, t: string) => { id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], 'Synthetic ' + k, t]); };
  const user = async (k: string, o: string, role: string, active = true) => { id[k] = randomUUID(); await sql("INSERT INTO users(id,organization_id,email,full_name,role,is_active,password_hash) VALUES($1,$2,$3,'Synthetic',$4,$5,'not-a-real-hash')", [id[k], id[o], id[k] + '@example.invalid', role, active]); };
  await org('oi', 'internal'); await org('parent', 'customer'); await org('child', 'customer'); await org('grand', 'customer'); await org('prov', 'service_partner'); await org('provBranch', 'service_partner'); await org('prov2', 'service_partner');
  await user('staffer', 'parent', 'technician'); await user('parentAdmin', 'parent', 'admin'); await user('parentTech', 'parent', 'technician');
  await user('childAdmin', 'child', 'admin'); await user('gone', 'parent', 'admin', false); await user('provAdmin', 'prov', 'admin'); await user('parentMgr', 'parent', 'facilities_manager'); await user('oiStaff', 'oi', 'admin'); await user('multi', 'parent', 'technician'); await user('prov2Admin', 'prov2', 'admin');
  const all = M.map(n => readFileSync(`migrations/${n}.sql`, 'utf8')).join('\n;\n');
  await db.exec('BEGIN;' + all + ';ROLLBACK;'); rolledBack = await shape();
  await db.exec(all);
  for (const n of [...M].reverse()) await db.exec(readFileSync(`docs/rollback/${n}_rollback.sql`, 'utf8'));
  undone = await shape();
  staffBefore = (await sql('SELECT is_platform_staff($1) s', [id.staffer])).rows[0].s;
  await db.exec(all);
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic founder')", [id.oiStaff]);
}, 120000);
afterAll(async () => { await db?.close(); });

describe('multi-company memberships and customer hierarchy (draft)', () => {
  it('rolls back in a transaction; undo scripts remove everything and restore old functions', () => {
    expect(rolledBack).toBe(0); expect(undone).toBe(0); expect(staffBefore).toBe(false);
  });
  it('backfill gives every existing user exactly one home membership equal to today', async () => {
    const r = (await sql(`SELECT count(*)::int n, count(*) FILTER (WHERE m.organization_id=u.organization_id AND m.role=u.role AND m.is_active=u.is_active AND m.is_home)::int same
      FROM users u JOIN organization_memberships m ON m.user_id=u.id`)).rows[0];
    const users = (await sql('SELECT count(*)::int n FROM users')).rows[0].n;
    expect(r).toEqual({ n: users, same: users });
  });
  it('only OI staff can set parent links, with a reason, and each change is audited', async () => {
    await expect(setParent(id.child, id.parent, null)).rejects.toThrow(/requires_oi_staff/);
    await expect(setParent(id.child, id.parent, id.parentAdmin)).rejects.toThrow(/requires_oi_staff/);
    await expect(setParent(id.child, id.parent, id.oiStaff, ' ')).rejects.toThrow(/requires_reason/);
    await setParent(id.child, id.parent, id.oiStaff);
    await setParent(id.grand, id.child, id.oiStaff);
    const ev = (await sql("SELECT actor_user_id, target_org_id, reason, after_state FROM platform_audit_events WHERE action='org_parent_changed' AND target_org_id=$1", [id.child])).rows;
    expect(ev).toEqual([{ actor_user_id: id.oiStaff, target_org_id: id.child, reason: 'OI review', after_state: { parent_organization_id: id.parent, org_type: 'customer', provider_link_confirmed: false } }]);
    await sql("UPDATE organizations SET name='renamed' WHERE id=$1", [id.child]);
    expect((await sql("SELECT count(*)::int n FROM platform_audit_events WHERE action='org_parent_changed'")).rows[0].n).toBe(2);
  });
  it('prevents cycles, self-parents, mixed-type trees, OI trees and too-deep trees', async () => {
    await expect(setParent(id.parent, id.grand, id.oiStaff)).rejects.toThrow(/cycle/);
    await expect(setParent(id.parent, id.parent, id.oiStaff)).rejects.toThrow(/parent_not_self|check|cycle/i);
    await expect(setParent(id.prov, id.parent, id.oiStaff)).rejects.toThrow(/same_type_only/);
    await expect(setParent(id.child, id.prov, id.oiStaff)).rejects.toThrow(/same_type_only/);
    await expect(setParent(id.child, id.oi, id.oiStaff)).rejects.toThrow(/same_type_only/);
    let prev = id.grand;
    for (let i = 0; i < 7; i++) {
      const n = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Deep','customer')", [n]);
      await setParent(n, prev, id.oiStaff); prev = n;
    }
    const last = randomUUID(); await sql("INSERT INTO organizations(id,name,org_type) VALUES($1,'Too deep','customer')", [last]);
    await expect(setParent(last, prev, id.oiStaff)).rejects.toThrow(/too_deep/);
  });
  it('parent admins see all descendant locations; others see only their own company', async () => {
    const pa = (await orgs(id.parentAdmin)).map((r: any) => r.organization_id);
    expect(pa).toEqual(expect.arrayContaining([id.parent, id.child, id.grand]));
    const pm = (await sql('SELECT organization_id, role, access FROM user_authorized_orgs($1)', [id.parentMgr])).rows;
    const byOrg = Object.fromEntries(pm.map((r: any) => [r.organization_id, `${r.role}/${r.access}`]));
    expect(byOrg[id.parent]).toBe('facilities_manager/member');
    expect(byOrg[id.child]).toBe('viewer/tree_view'); expect(byOrg[id.grand]).toBe('viewer/tree_view');
    const pad = Object.fromEntries((await sql('SELECT organization_id, access FROM user_authorized_orgs($1)', [id.parentAdmin])).rows.map((r: any) => [r.organization_id, r.access]));
    expect(pad[id.child]).toBe('tree_admin');
    const ex = (await sql('SELECT can_export_tree($1,$3) a, can_export_tree($2,$3) m', [id.parentAdmin, id.parentMgr, id.parent])).rows[0];
    expect(ex).toEqual({ a: true, m: false });
    expect(await orgs(id.parentTech)).toEqual([{ organization_id: id.parent, role: 'technician' }]);
    const ca = (await orgs(id.childAdmin)).map((r: any) => r.organization_id);
    expect(ca).toContain(id.grand); expect(ca).not.toContain(id.parent);
    expect(await orgs(id.gone)).toEqual([]);
    expect(await orgs(id.provAdmin)).toEqual([{ organization_id: id.prov, role: 'admin' }]);
  });
  it('provider trees stay inside one provider company and never reach customer companies', async () => {
    await expect(setParent(id.provBranch, id.prov, id.oiStaff)).rejects.toThrow(/requires_confirmation/);
    await setParent(id.provBranch, id.prov, id.oiStaff, 'same legal company', true);
    const ev = (await sql("SELECT after_state FROM platform_audit_events WHERE action='org_parent_changed' AND target_org_id=$1", [id.provBranch])).rows;
    expect(ev).toEqual([{ after_state: { parent_organization_id: id.prov, org_type: 'service_partner', provider_link_confirmed: true } }]);
    const pa = (await orgs(id.provAdmin)).map((r: any) => r.organization_id).sort();
    expect(pa).toEqual([id.prov, id.provBranch].sort());
    expect(await orgs(id.prov2Admin)).toEqual([{ organization_id: id.prov2, role: 'admin' }]);
    const custTypes = (await sql("SELECT count(*)::int n FROM user_authorized_orgs($1) a JOIN organizations o ON o.id=a.organization_id WHERE o.org_type<>'service_partner'", [id.provAdmin])).rows[0].n;
    expect(custTypes).toBe(0);
  });
  it('deactivating a person deactivates every membership; home-membership deactivation deactivates the person', async () => {
    await sql("INSERT INTO organization_memberships(user_id,organization_id,role) VALUES($1,$2,'viewer')", [id.multi, id.child]);
    await sql('UPDATE users SET is_active=false WHERE id=$1', [id.multi]);
    expect((await sql('SELECT count(*)::int n FROM organization_memberships WHERE user_id=$1 AND is_active', [id.multi])).rows[0].n).toBe(0);
    expect(await orgs(id.multi)).toEqual([]);
    await sql('UPDATE users SET is_active=true WHERE id=$1', [id.multi]);
    const act = (await sql('SELECT organization_id FROM organization_memberships WHERE user_id=$1 AND is_active', [id.multi])).rows;
    expect(act).toEqual([{ organization_id: id.parent }]);
    await sql("UPDATE organization_memberships SET is_active=false, deactivated_at=now() WHERE user_id=$1 AND is_home", [id.multi]);
    expect((await sql('SELECT is_active FROM users WHERE id=$1', [id.multi])).rows[0].is_active).toBe(false);
  });
  it('OI staff join the OI company without leaving their other company', async () => {
    await fails("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'founder')", [id.staffer], /must_be_internal/);
    await sql("INSERT INTO organization_memberships(user_id,organization_id,role) VALUES($1,$2,'admin')", [id.staffer, id.oi]);
    await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'founder')", [id.staffer]);
    expect((await sql('SELECT is_platform_staff($1) s', [id.staffer])).rows[0].s).toBe(true);
    const home = (await sql('SELECT organization_id, role FROM users WHERE id=$1', [id.staffer])).rows[0];
    expect(home).toEqual({ organization_id: id.parent, role: 'technician' });
    await sql("UPDATE organization_memberships SET is_active=false, deactivated_at=now() WHERE user_id=$1 AND organization_id=$2", [id.staffer, id.oi]);
    expect((await sql('SELECT is_platform_staff($1) s', [id.staffer])).rows[0].s).toBe(false);
  });
  it('legacy users edits keep the home membership in sync; memberships cannot be deleted', async () => {
    await sql("UPDATE users SET role='viewer' WHERE id=$1", [id.parentTech]);
    expect((await sql('SELECT role FROM organization_memberships WHERE user_id=$1 AND is_home', [id.parentTech])).rows[0].role).toBe('viewer');
    await fails('DELETE FROM organization_memberships WHERE user_id=$1', [id.parentTech], /no_delete/);
  });
  it('a parent admin can request a provider for a child location; provider access still needs an assignment', async () => {
    const pf = randomUUID(), prop = randomUUID();
    await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'P')", [pf, id.grand]);
    await sql("INSERT INTO properties(id,portfolio_id,name,state) VALUES($1,$2,'Synthetic location','AZ')", [prop, pf]);
    await sql("INSERT INTO provider_assignment_requests(property_id,provider_organization_id,requested_by_user_id,reason) VALUES($1,$2,$3,'service')", [prop, id.prov, id.parentAdmin]);
    await fails("INSERT INTO provider_assignment_requests(property_id,provider_organization_id,requested_by_user_id,reason) VALUES($1,$2,$3,'x')", [prop, id.prov, id.parentTech], /not_facility_admin/);
    const v = (await sql('SELECT owner_organization_id, top_organization_id, active_provider_ids FROM platform_facility_overview WHERE property_id=$1', [prop])).rows[0];
    expect(v).toEqual({ owner_organization_id: id.grand, top_organization_id: id.parent, active_provider_ids: [] });
    await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [prop, id.prov, id.parentAdmin]);
    const p = (await sql('SELECT active_facility_count::int n FROM platform_provider_overview WHERE provider_organization_id=$1', [id.prov])).rows[0];
    expect(p).toEqual({ n: 1 });
  });
  it('keeps new objects server-only', async () => {
    const r = (await sql("SELECT has_table_privilege('anon','organization_memberships','SELECT') a, has_table_privilege('authenticated','platform_facility_overview','SELECT') b, has_function_privilege('anon','user_authorized_orgs(uuid)','EXECUTE') c, has_function_privilege('oi_pr2_api','user_authorized_orgs(uuid)','EXECUTE') d")).rows[0];
    expect(r).toEqual({ a: false, b: false, c: false, d: true });
  });
});
