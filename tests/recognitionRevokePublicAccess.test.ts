import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// 20261030090900: anon/authenticated lose every right on the recognition tables and functions (as on
// Supabase, simulate its default grants first); oi_pr2_api keeps what the app needs; triggers still fire.
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const TABLES = ['recognition_runs', 'recognition_run_photos', 'recognition_usage_settings', 'recognition_safety_caps',
  'recognition_usage_monthly', 'recognition_usage_reservations', 'opening_billable_periods', 'facility_provider_assignment_periods'];
const FN_FILTER = `p.pronamespace='public'::regnamespace AND (p.proname LIKE 'recognition\\_%' OR p.proname LIKE 'opening\\_billable\\_periods%'
  OR p.proname LIKE 'facility\\_provider\\_assignment%' OR p.proname='billing_periods_guard')`;
let db: PGlite;
const files = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort();
const revoke = files.find(f => f.startsWith('20261030090900'))!;

beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const f of files.filter(f => f < revoke)) await db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
  // Simulate Supabase default privileges on the new objects.
  for (const t of TABLES) await db.exec(`GRANT ALL ON ${t} TO anon, authenticated`);
  const fns = (await db.query<{ f: string }>(`SELECT p.oid::regprocedure::text f FROM pg_proc p WHERE ${FN_FILTER}`)).rows;
  for (const { f } of fns) await db.exec(`GRANT EXECUTE ON FUNCTION ${f} TO anon, authenticated`);
  for (const f of files.filter(f => f >= revoke)) await db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
});

describe('recognition revoke public access (090900)', () => {
  it('anon and authenticated have no table rights and no EXECUTE', async () => {
    for (const t of TABLES) for (const r of ['anon', 'authenticated'])
      expect((await db.query<any>(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') p`, [r, t])).rows[0].p, `${r} ${t}`).toBe(false);
    const f = (await db.query<any>(`SELECT p.proname, has_function_privilege('anon',p.oid,'EXECUTE') a, has_function_privilege('authenticated',p.oid,'EXECUTE') u FROM pg_proc p WHERE ${FN_FILTER}`)).rows;
    expect(f.length).toBeGreaterThanOrEqual(13);
    for (const x of f) expect([x.proname, x.a, x.u]).toEqual([x.proname, false, false]);
  });
  it('the API role keeps what the app needs; RLS stays on', async () => {
    const r = (await db.query<any>(`SELECT has_function_privilege('oi_pr2_api','recognition_usage_reserve(uuid)','EXECUTE') a,
      has_function_privilege('oi_pr2_api','recognition_safety_cap_set(uuid,uuid,uuid,integer,text)','EXECUTE') b,
      has_function_privilege('oi_pr2_api','recognition_usage_settings_update(uuid,uuid,text,integer,numeric,boolean,integer,numeric)','EXECUTE') c,
      has_table_privilege('oi_pr2_api','recognition_runs','SELECT,INSERT') d, has_table_privilege('oi_pr2_api','opening_billable_periods','SELECT') e`)).rows[0];
    expect(r).toEqual({ a: true, b: true, c: true, d: true, e: true });
    for (const t of TABLES) expect((await db.query<any>('SELECT relrowsecurity r FROM pg_class WHERE oid=$1::regclass', [t])).rows[0].r).toBe(true);
  });
  it('billing triggers still fire for the API role', async () => {
    const o = randomUUID(), pf = randomUUID(), pr = randomUUID(), b = randomUUID(), op = randomUUID();
    await db.query("INSERT INTO organizations(id,name,org_type) VALUES($1,'Synthetic','customer')", [o]);
    await db.query("INSERT INTO portfolios(id,organization_id,name) VALUES($1,$2,'P')", [pf, o]);
    await db.query("INSERT INTO properties(id,portfolio_id,name) VALUES($1,$2,'F')", [pr, pf]);
    await db.query("INSERT INTO buildings(id,property_id,name) VALUES($1,$2,'B')", [b, pr]);
    await db.query("INSERT INTO openings(id,building_id,opening_code,qr_token,opening_type,status) VALUES($1,$2,'X1',$3,'door','pending_capture')", [op, b, 'qr-' + op]);
    await db.exec('GRANT UPDATE ON openings TO oi_pr2_api; GRANT SELECT ON openings TO oi_pr2_api; CREATE POLICY t_api ON openings FOR ALL TO oi_pr2_api USING (true) WITH CHECK (true);');
    await db.exec('SET ROLE oi_pr2_api');
    try { expect((await db.query("UPDATE openings SET status='active' WHERE id=$1", [op])).affectedRows).toBe(1); } finally { await db.exec('RESET ROLE'); }
    expect((await db.query<any>('SELECT count(*)::int n FROM opening_billable_periods WHERE opening_id=$1 AND ended_at IS NULL', [op])).rows[0].n).toBe(1);
  });
  it('rollback restores only PUBLIC EXECUTE on trigger functions, never anon/authenticated on staff functions', async () => {
    await db.exec(readFileSync('docs/rollback/20261030090900_recognition_revoke_public_access_rollback.sql', 'utf8'));
    expect((await db.query<any>(`SELECT has_function_privilege('anon','recognition_safety_cap_set(uuid,uuid,uuid,integer,text)','EXECUTE') a`)).rows[0].a).toBe(false);
    await db.exec(fix(readFileSync('migrations/' + revoke, 'utf8')));
    expect((await db.query<any>(`SELECT has_function_privilege('anon','billing_periods_guard()','EXECUTE') a`)).rows[0].a).toBe(false);
  });
});
