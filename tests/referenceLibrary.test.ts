import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
// Reference library (DRAFT migration 20261030091000): schema, RLS/revokes, staff-only approval with audit,
// licence/interim guards, immutable releases, draft-only imports, sha256-deduped copy, retrieval and
// citation validation. Disposable PGlite, synthetic users, small manifest fixtures. No network.
import { planFromDir } from '../scripts/reference-import';
import { applyPlan, planCounts, tableCounts, copyFromLibrary, assertLocalTarget, assertAllowedSource, vdModelToken } from '../src/services/referenceImport';
import { buildReferenceContext, validateCitations, activeRelease } from '../src/services/referenceRetrieval';
const fix = (s: string) => s.replace(/CREATE EXTENSION IF NOT EXISTS "uuid-ossp";/g, '').replace(/uuid_generate_v4\(\)/g, 'gen_random_uuid()');
const MIG = 'migrations/20261030091000_reference_library.sql';
const FIX = 'tests/fixtures/reference';
async function fresh() {
  const db = new PGlite();
  await db.exec('CREATE ROLE oi_pr2_api NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;');
  for (const f of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) await db.exec(fix(readFileSync('migrations/' + f, 'utf8')));
  return db;
}
let db: PGlite; const id: Record<string, string> = {};
const sql = (s: string, a?: unknown[]) => db.query<any>(s, a);
const fails = async (p: Promise<unknown>, re: RegExp) => { await expect(p).rejects.toThrow(re); };
const approve = (actor: string, kind: string, key: string, reason = 'checked against source page') =>
  sql('SELECT reference_approve($1,NULL,$2,$3,$4) r', [actor, kind, key, reason]);
const DOC = 'a'.repeat(64);
type DB = { query: (s: string, a?: unknown[]) => Promise<any> };
const doc = (d: DB, sha: string, o: Record<string, unknown> = {}) => {
  const r: Record<string, unknown> = { sha256: sha, manufacturer: 'Von Duprin', brand: 'Von Duprin', title: 'Synthetic sheet', doc_type: 'spec_sheet', page_count: 2, storage_key: 'private/reference/' + sha.slice(0, 8) + '.pdf', ...o };
  const k = Object.keys(r); return d.query(`INSERT INTO reference_documents(${k.join(',')}) VALUES(${k.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(r));
};
const page = (d: DB, sha: string, n: number, text: string, citable: boolean) => d.query(
  "INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable) VALUES($1,$2,$3,encode(sha256(convert_to($3,'UTF8')),'hex'),'spec','verified',$4)", [sha, n, text, citable]);

beforeAll(async () => {
  db = await fresh();
  for (const [k, t] of [['oi', 'internal'], ['cust', 'customer']]) {
    id[k] = randomUUID(); await sql('INSERT INTO organizations(id,name,org_type) VALUES($1,$2,$3)', [id[k], 'Synthetic ' + k, t]);
    id[k + 'User'] = randomUUID();
    await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [id[k + 'User'], id[k], id[k + 'User'] + '@example.invalid']);
  }
  id.oiNonStaff = randomUUID();
  await sql("INSERT INTO users(id,organization_id,email,full_name,role,password_hash) VALUES($1,$2,$3,'Synthetic','admin','not-a-real-password')", [id.oiNonStaff, id.oi, id.oiNonStaff + '@example.invalid']);
  await sql("INSERT INTO platform_staff(user_id,grant_reason) VALUES($1,'synthetic staff')", [id.oiUser]);
}, 120000);

describe('reference library migration', () => {
  it('is idempotent and private: RLS on, nothing for anon/authenticated/PUBLIC, API role read-only', async () => {
    await db.exec(fix(readFileSync(MIG, 'utf8')));
    const t = (await sql("SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'reference\\_%' AND relkind='r' ORDER BY 1")).rows;
    expect(t.length).toBe(13); expect(t.every((r: any) => r.relrowsecurity)).toBe(true);
    for (const role of ['anon', 'authenticated', 'public']) for (const r of t)
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        expect((await sql(`SELECT has_table_privilege($1,$2,$3) h`, [role, r.relname, priv])).rows[0].h, `${role} ${r.relname} ${priv}`).toBe(false);
    for (const r of t) {
      expect((await sql("SELECT has_table_privilege('oi_pr2_api',$1,'SELECT') h", [r.relname])).rows[0].h).toBe(true);
      expect((await sql("SELECT has_table_privilege('oi_pr2_api',$1,'INSERT') h", [r.relname])).rows[0].h).toBe(false);
    }
    for (const role of ['anon', 'authenticated'])
      expect((await sql("SELECT has_function_privilege($1,'reference_approve(uuid,uuid,text,text,text)','EXECUTE') h", [role])).rows[0].h).toBe(false);
  });
  it('storage keys must be private object keys, never URLs or public paths', async () => {
    for (const k of ['https://x.example/a.pdf', 'public/a.pdf'])
      await fails(doc(db, 'b'.repeat(64), { storage_key: k }), /check/i);
  });
});

describe('approval, licences and audit', () => {
  beforeAll(async () => {
    await doc(db, DOC, { title: '99 Series spec sheet', revision: '2024-03' });
    await page(db, DOC, 1, '99 Series exit device. Mechanism case 2-1/4 in. projection.', true);
    await page(db, DOC, 2, 'draft notes', false);
  });
  it('only active OI staff can approve, with a reason; customers and non-staff are refused', async () => {
    await fails(approve(id.custUser, 'document', DOC), /reference_requires_oi_staff/);
    await fails(approve(id.oiNonStaff, 'document', DOC), /reference_requires_oi_staff/);
    await fails(approve(id.oiUser, 'document', DOC, '  '), /reference_reason_required/);
  });
  it('a document cannot be approved until storage and AI processing are permitted', async () => {
    await fails(approve(id.oiUser, 'document', DOC), /check/i);
    await sql("UPDATE reference_documents SET licence_storage='permitted', licence_ai_processing='permitted' WHERE sha256=$1", [DOC]);
    expect((await approve(id.oiUser, 'document', DOC)).rows[0].r.action).toBe('reference_document_approved');
    const a = (await sql("SELECT actor_user_id, reason FROM platform_audit_events WHERE action='reference_document_approved'")).rows;
    expect(a).toEqual([{ actor_user_id: id.oiUser, reason: 'checked against source page' }]);
  });
  it('approved document content is immutable and cannot be deleted', async () => {
    await fails(sql("UPDATE reference_documents SET title='changed' WHERE sha256=$1", [DOC]), /reference/i);
    await fails(sql('DELETE FROM reference_documents WHERE sha256=$1', [DOC]), /reference/i);
  });
  it('interim-only documents can never be approved', async () => {
    const s = 'c'.repeat(64);
    await doc(db, s, { manufacturer: 'LCN', brand: 'LCN', title: 'Part A', licence_storage: 'permitted', licence_ai_processing: 'permitted', interim_only: true });
    await fails(approve(id.oiUser, 'document', s), /check/i);
  });
  it('a product needs an approved source; a dimension must be complete to become verified', async () => {
    const p = randomUUID(), q = randomUUID();
    await sql("INSERT INTO reference_products(id,manufacturer,series,model) VALUES($1,'Von Duprin','99','99EO'),($2,'Von Duprin','33A','33AEO')", [p, q]);
    await fails(approve(id.oiUser, 'product', q), /reference_product_needs_approved_source/);
    await sql('INSERT INTO reference_product_sources(product_id,doc_sha256,page_no) VALUES($1,$2,1)', [p, DOC]);
    await approve(id.oiUser, 'product', p);
    const incomplete = randomUUID();
    await sql("INSERT INTO reference_dimensions(id,product_id,name,source_doc_sha256,source_page) VALUES($1,$2,'mechanism_case_projection',$3,1)", [incomplete, p, DOC]);
    await fails(approve(id.oiUser, 'dimension', incomplete), /check/i);
    const d = randomUUID();
    await sql(`INSERT INTO reference_dimensions(id,product_id,name,value,units,normalized_mm,endpoint_a,endpoint_b,orientation,configuration,tolerance,source_doc_sha256,source_page,verification_status)
      VALUES($1,$2,'mechanism_case_projection',2.25,'in',57.15,'door face','case face','projection','standard','nominal',$3,1,'manufacturer_stated')`, [d, p, DOC]);
    await approve(id.oiUser, 'dimension', d);
    id.product = p; id.otherProduct = q; id.dim = d;
    await sql("INSERT INTO reference_lookalike_groups(id,name,basis) VALUES('CS-T-1','Synthetic rim devices','similar housing')");
    await sql("INSERT INTO reference_lookalike_members(group_id,member_key,manufacturer,series_or_model) VALUES('CS-T-1','VD-99','Von Duprin','99'),('CS-T-1','VD-33A','Von Duprin','33A')");
    await approve(id.oiUser, 'lookalike_group', 'CS-T-1');
    const acts = (await sql("SELECT action FROM platform_audit_events WHERE action LIKE 'reference_%' ORDER BY id")).rows.map((r: any) => r.action);
    expect(acts).toEqual(['reference_document_approved', 'reference_product_approved', 'reference_dimension_verified', 'reference_lookalike_group_approved']);
  });
});

describe('releases', () => {
  it('no release: retrieval returns null and every citation is rejected', async () => {
    expect(await activeRelease(db)).toBeNull();
    expect(await buildReferenceContext(db, ['99EO'])).toBeNull();
    expect(validateCitations({ reference_citations: ['R1'] }, null)).toEqual({ cited: [], rejected: ['R1'] });
  });
  it('publish is staff-only and snapshots only approved/verified/citable content', async () => {
    await fails(sql("SELECT reference_release_publish($1,NULL,'x')", [id.custUser]), /reference_requires_oi_staff/);
    const r = (await sql("SELECT reference_release_publish($1,NULL,'first release') r", [id.oiUser])).rows[0].r;
    expect(r.version).toBe(1);
    const kinds = (await sql('SELECT item_kind, count(*)::int n FROM reference_release_items WHERE release_id=$1 GROUP BY 1 ORDER BY 1', [r.release_id])).rows;
    expect(kinds).toEqual([{ item_kind: 'dimension', n: 1 }, { item_kind: 'document', n: 1 }, { item_kind: 'lookalike_group', n: 1 }, { item_kind: 'page', n: 1 }, { item_kind: 'product', n: 1 }]);
    expect((await sql("SELECT count(*)::int n FROM platform_audit_events WHERE action='reference_release_published'")).rows[0].n).toBe(1);
    id.rel1 = r.release_id;
  });
  it('release items and versions are immutable; only active -> retired is allowed', async () => {
    await fails(sql("UPDATE reference_release_items SET content='{}' WHERE release_id=$1", [id.rel1]), /reference/i);
    await fails(sql('DELETE FROM reference_release_items WHERE release_id=$1', [id.rel1]), /reference/i);
    await fails(sql('UPDATE reference_releases SET version=9 WHERE id=$1', [id.rel1]), /reference/i);
    await fails(sql('DELETE FROM reference_releases WHERE id=$1', [id.rel1]), /reference/i);
  });
  it('retrieval uses only the active release, ranks schedule hints first, and validates citations', async () => {
    // a later draft edit must not leak into recognition
    await sql("INSERT INTO reference_products(manufacturer,model) VALUES('Von Duprin','DRAFT-ONLY')");
    const ctx = (await buildReferenceContext(db, ['Von Duprin', '99EO']))!;
    expect(ctx.release_id).toBe(id.rel1);
    expect(ctx.facts[0]).toMatchObject({ kind: 'product', source_key: id.product });
    expect(ctx.prompt).toContain('2.25 in'); expect(ctx.prompt).toContain('LOOK-ALIKES');
    expect(ctx.prompt).not.toContain('DRAFT-ONLY'); expect(ctx.prompt).not.toContain('draft notes');
    const ids = ctx.facts.map(f => f.id);
    const v = validateCitations({ reference_citations: [ids[1], 'R999', ids[1], 42, 'P:made-up'] }, ctx);
    expect(v.cited).toEqual([{ id: ids[1], kind: ctx.facts[1].kind, source_key: ctx.facts[1].source_key }]);
    expect(v.rejected).toEqual(['R999', '42', 'P:made-up']);
  });
  it('a second publish retires the first; exactly one release is active', async () => {
    const r = (await sql("SELECT reference_release_publish($1,NULL,'second') r", [id.oiUser])).rows[0].r;
    expect(r).toMatchObject({ version: 2, previous_release_id: id.rel1 });
    expect((await sql("SELECT version, status FROM reference_releases ORDER BY version")).rows).toEqual([{ version: 1, status: 'retired' }, { version: 2, status: 'active' }]);
    await fails(sql("UPDATE reference_releases SET status='active' WHERE id=$1", [id.rel1]), /reference|unique|duplicate/i);
  });
  it('rollback refuses once any release exists', async () => {
    await fails(db.exec(readFileSync('docs/rollback/20261030091000_reference_library_rollback.sql', 'utf8')), /release/i);
  });
});

describe('rollback on a library with no releases', () => {
  it('removes the library and the recognition columns, then the migration re-applies', async () => {
    const d2 = await fresh();
    await d2.exec(readFileSync('docs/rollback/20261030091000_reference_library_rollback.sql', 'utf8'));
    expect((await d2.query<any>("SELECT count(*)::int n FROM pg_class WHERE relname LIKE 'reference\\_%' AND relkind='r'")).rows[0].n).toBe(0);
    expect((await d2.query<any>("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='recognition_runs' AND column_name LIKE 'reference_%'")).rows[0].n).toBe(0);
    await d2.exec(fix(readFileSync(MIG, 'utf8')));
    expect((await d2.query<any>("SELECT count(*)::int n FROM pg_class WHERE relname LIKE 'reference\\_%' AND relkind='r'")).rows[0].n).toBe(13);
  }, 120000);
});

describe('imports (draft only, local only)', () => {
  it('plans the fixture manifests and lands everything as draft; re-import inserts nothing', async () => {
    const d = await fresh();
    const plan = planFromDir(FIX); const c = planCounts(plan);
    expect(c.products).toBeGreaterThan(0); expect(c.assets_interim).toBe(6);
    const ins = await applyPlan(d, plan);
    const counts = await tableCounts(d);
    expect(counts.reference_products).toBe(ins.reference_products);
    expect((await d.query<any>("SELECT count(*)::int n FROM reference_products WHERE status<>'draft'")).rows[0].n).toBe(0);
    expect((await d.query<any>("SELECT count(*)::int n FROM reference_dimensions WHERE verification_status='verified'")).rows[0].n).toBe(0);
    expect((await d.query<any>("SELECT count(*)::int n FROM reference_lookalike_groups WHERE status<>'draft'")).rows[0].n).toBe(0);
    expect((await d.query<any>("SELECT count(*)::int n FROM reference_assets WHERE package LIKE '%LCN%' AND NOT interim_only")).rows[0].n).toBe(0);
    const again = await applyPlan(d, planFromDir(FIX));
    expect(Object.values(again).every(n => n === 0)).toBe(true);
    // the duplicate registry row collapses to one product
    const keys = plan.products.map(p => [p.manufacturer, p.series, p.model].join('|').toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  }, 120000);
  it('model tokens and target/source guards', () => {
    expect(vdModelToken('B01/P01_99EO_AX_626')).toBe('99EO');
    expect(() => assertLocalTarget('postgres://u@localhost:5432/x')).not.toThrow();
    for (const u of ['postgres://u@db.boaoedvyvifppuklbwad.supabase.co/postgres', 'postgres://u@db.fadihkhdwpfffpelqjtg.supabase.co/p', 'postgres://u@db.fdudsigbxumcpbxxxerb.supabase.co/p'])
      expect(() => assertLocalTarget(u)).toThrow();
    for (const u of ['postgres://u@db.fadihkhdwpfffpelqjtg.supabase.co/p', 'postgres://u@db.fdudsigbxumcpbxxxerb.supabase.co/p'])
      expect(() => assertAllowedSource(u)).toThrow();
  });
});

describe('copy from the staging library (simulated with two local databases)', () => {
  it('dedupes by sha256, lands as draft, preserves source status in metadata, is re-runnable', async () => {
    const src = await fresh(), dst = await fresh();
    const s1 = '1'.repeat(64), s2 = '2'.repeat(64);
    await doc(src, s1); await doc(src, s2, { manufacturer: 'LCN', brand: 'LCN' });
    await src.query("INSERT INTO reference_document_models(doc_sha256,model,evidence_page,evidence_quote) VALUES($1,'99EO',1,'99EO')", [s1]);
    await page(src, s1, 1, 'page one', true);
    await doc(dst, s1, { title: 'already here' });
    const r1 = await copyFromLibrary(src, dst, { sourceRef: 'local-test' });
    expect(r1).toMatchObject({ source_documents: 2, copied_documents: 1, skipped_existing: 1 });
    expect((await dst.query<any>("SELECT title, status FROM reference_documents WHERE sha256=$1", [s1])).rows[0]).toEqual({ title: 'already here', status: 'draft' });
    expect((await dst.query<any>("SELECT status, metadata->>'source_status' ss FROM reference_documents WHERE sha256=$1", [s2])).rows[0]).toEqual({ status: 'draft', ss: 'draft' });
    const r2 = await copyFromLibrary(src, dst, { sourceRef: 'local-test' });
    expect(r2.copied_documents).toBe(0);
  }, 120000);
});
