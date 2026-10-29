import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { serviceEventVisibleSql, photoVisibleSql } from '../src/db/tenantScope';
// t130: the service-event visibility filter on its own (no caller-side facility scope) must not
// leak another provider's history, even with sharing on. Synthetic in-process data only.
let db: PGlite;
const sql = (s: string, a?: unknown[]) => db.query<any>(s, a);
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const ids: Record<string, string> = {};
async function org(name: string, type: string) { const id = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id, name, type]); return id; }
async function facility(owner: string, tag: string) {
  const pf = randomUUID(), p = randomUUID(), b = randomUUID(), o = randomUUID();
  await sql("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'Synthetic')", [pf, owner]);
  await sql("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,$3)", [p, pf, 'Synthetic ' + tag]);
  await sql("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, p]);
  await sql("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type) VALUES($1,$2,$3,$4,'door')", [o, b, tag, 'qr-' + o]);
  return { p, o };
}
async function event(opening: string, by: string | null) {
  const id = randomUUID();
  await sql("INSERT INTO service_events(id,opening_id,performed_by_org_id,event_date,work_performed) VALUES($1,$2,$3,'2026-10-29','synthetic')", [id, opening, by]);
  return id;
}
const visible = async (opening: string, orgId: string) => (await sql(`SELECT count(*)::int c FROM service_events se WHERE se.opening_id=$1 AND ${serviceEventVisibleSql('se', 2)}`, [opening, orgId])).rows[0].c;
const photoVisible = async (photo: string, orgId: string) => (await sql(`SELECT count(*)::int c FROM photos ph WHERE ph.id=$1 AND ${photoVisibleSql('ph', 2)}`, [photo, orgId])).rows[0].c;
const share = (p: string, on: boolean) => sql('UPDATE properties SET share_provider_service_history=$2 WHERE id=$1', [p, on]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN');
  // Mirror staging: every migration before the unapplied 090600 draft.
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < '20261030090600').sort()) await db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  ids.owner = await org('Synthetic owner', 'customer');
  ids.V = await org('Synthetic Provider V', 'service_partner');
  ids.D = await org('Synthetic Provider D', 'service_partner');
  ids.E = await org('Synthetic Provider E', 'service_partner');
  const granter = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [granter, ids.owner, granter + '@example.invalid']);
  const fv = await facility(ids.owner, 'V-site'), fd = await facility(ids.owner, 'D-site');
  Object.assign(ids, { vProp: fv.p, vOpen: fv.o, dProp: fd.p, dOpen: fd.o, granter });
  for (const [p, prov] of [[fv.p, ids.V], [fd.p, ids.D], [fv.p, ids.E]]) await sql('INSERT INTO facility_provider_assignments(property_id,provider_organization_id,granted_by_user_id) VALUES($1,$2,$3)', [p, prov, granter]);
  ids.vEvent = await event(fv.o, ids.V);
  ids.ownerEvent = await event(fv.o, ids.owner);
  ids.dEvent = await event(fd.o, ids.D);
  ids.vPhoto = randomUUID();
  await sql("INSERT INTO photos(id,opening_id,related_entity_type,related_entity_id,storage_url,media_type) VALUES($1,$2,'service_event',$3,'synthetic://none','photo')", [ids.vPhoto, fv.o, ids.vEvent]);
}, 120000);
describe('service-event filter requires facility access by itself', () => {
  it('sharing off: owner sees all, V sees own, D and E see nothing they did not do', async () => {
    await share(ids.vProp, false);
    expect(await visible(ids.vOpen, ids.owner)).toBe(2);
    expect(await visible(ids.vOpen, ids.V)).toBe(1);
    expect(await visible(ids.vOpen, ids.E)).toBe(0);
    expect(await visible(ids.vOpen, ids.D)).toBe(0);
  });
  it('sharing ON for V-site: provider D (not assigned) gets 0 of V events from the filter alone', async () => {
    await share(ids.vProp, true);
    expect(await visible(ids.vOpen, ids.D)).toBe(0);
    expect(await photoVisible(ids.vPhoto, ids.D)).toBe(0);
    // Sharing still works for a provider that IS assigned to V-site.
    expect(await visible(ids.vOpen, ids.E)).toBe(2);
    expect(await photoVisible(ids.vPhoto, ids.E)).toBe(1);
    // And V never sees D-site history through V-site sharing.
    expect(await visible(ids.dOpen, ids.V)).toBe(0);
    await share(ids.vProp, false);
  });
  it('after revocation the filter alone hides even the provider own past events', async () => {
    await sql('UPDATE facility_provider_assignments SET revoked_at=now() WHERE property_id=$1 AND provider_organization_id=$2', [ids.vProp, ids.V]);
    expect(await visible(ids.vOpen, ids.V)).toBe(0);
    expect(await visible(ids.vOpen, ids.owner)).toBe(2);
  });
});
