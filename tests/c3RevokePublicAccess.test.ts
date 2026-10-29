import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
// Offline only: proves the C3 hardening migration leaves the C3 objects server-only.
const T = '20261030090300_c3_revoke_public_access';
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const tables = ['platform_staff', 'platform_audit_events', 'user_history', 'provider_assignment_requests'];
let db: PGlite;
const priv = async () => {
  const out: Record<string, boolean> = {};
  for (const r of ['anon', 'authenticated']) {
    for (const t of tables) for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      out[`${r}.${t}.${p}`] = (await db.query<any>(`SELECT has_table_privilege('${r}','${t}','${p}') v`)).rows[0].v;
    out[`${r}.fn`] = (await db.query<any>(`SELECT has_function_privilege('${r}','is_platform_staff(uuid)','EXECUTE') v`)).rows[0].v;
  }
  return out;
};
const any = (o: Record<string, boolean>) => Object.values(o).some(Boolean);
let before: Record<string, boolean>, after: Record<string, boolean>, undone: Record<string, boolean>, api = false;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const n of readdirSync('migrations').filter(n => n.endsWith('.sql') && n < T).sort()) await db.exec(fix(readFileSync('migrations/' + n, 'utf8')));
  for (const t of tables) await db.exec(`GRANT ALL ON ${t} TO anon, authenticated`); // simulate Supabase defaults
  before = await priv();
  const m = readFileSync(`migrations/${T}.sql`, 'utf8');
  await db.exec('BEGIN;' + m + ';ROLLBACK;');
  await db.exec(m); after = await priv();
  api = (await db.query<any>("SELECT has_function_privilege('oi_pr2_api','is_platform_staff(uuid)','EXECUTE') a")).rows[0].a;
  await db.exec(readFileSync(`docs/rollback/${T}_rollback.sql`, 'utf8')); undone = await priv();
  await db.exec(m);
}, 120000);
afterAll(async () => { await db?.close(); });
describe('C3 revoke public access', () => {
  it('starts with public privileges (simulated defaults)', () => { expect(before['anon.platform_staff.SELECT']).toBe(true); expect(before['anon.fn']).toBe(true); });
  it('removes every anon/authenticated table privilege and function EXECUTE', () => { expect(any(after)).toBe(false); });
  it('keeps the server role able to call is_platform_staff', () => { expect(api).toBe(true); });
  it('rollback restores the defaults', () => { expect(undone['authenticated.user_history.SELECT']).toBe(true); expect(undone['anon.fn']).toBe(true); });
});
