import { describe, expect, it, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Chat reference upload route (ioqfdcehnhnqpnqawwvo only): handler logic with fake storage/RPC, and the
// insert-only migration on a disposable PGlite copy of the ioqfd reference_documents schema. Synthetic only.
import { handle, parseMeta, estimatePdfPages, timingSafeEqual, MAX_BYTES, type Deps } from '../supabase/reference-intake/functions/reference-upload/handler';

const KEY = 'k'.repeat(40); // synthetic test value, not a real secret
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pdf = (s = 'x') => new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Pages >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type /Page >>\n%${s}\n%%EOF`);
function fake(over: Partial<Deps> = {}) {
  const objects = new Map<string, Uint8Array>(); const docs = new Map<string, any>(); const calls: any[] = [];
  const d: Deps = {
    uploadKey: KEY, uploader: 'chat',
    rpc: async (fn, a: any) => {
      calls.push([fn, a]);
      if (fn === 'reference_upload_check') return { rate_limited: false, existing: docs.get(a.p_sha256) ?? null };
      if (fn === 'reference_upload_register') { if (docs.has(a.p_sha256)) return { inserted: false, existing: docs.get(a.p_sha256) }; docs.set(a.p_sha256, { sha256: a.p_sha256, status: 'draft' }); return { inserted: true }; }
      return null;
    },
    putObject: async (k, b) => { if (objects.has(k)) return 'exists'; objects.set(k, b); return 'created'; },
    getObject: async k => objects.get(k) ?? null,
    sha256: async b => hex(b), ...over,
  };
  return { d, objects, docs, calls };
}
const req = (file: Blob | null, meta: unknown, key: string | null = KEY, name = 'sheet.pdf') => {
  const f = new FormData(); if (file) f.append('file', file, name); if (meta !== undefined) f.append('metadata', typeof meta === 'string' ? meta : JSON.stringify(meta));
  const h: Record<string, string> = {}; if (key !== null) h['x-oi-upload-key'] = key;
  return new Request('https://example.invalid/functions/v1/reference-upload', { method: 'POST', body: f, headers: h });
};
const blob = (b: Uint8Array, type = 'application/pdf') => new Blob([b], { type });
const M = { manufacturer: 'Von Duprin', title: '99 Series', doc_type: 'installation' };

describe('reference-upload handler', () => {
  it('fails closed while the secret is unset or short, and rejects missing/wrong keys', async () => {
    for (const k of [undefined, '', 'short']) expect((await handle(req(blob(pdf()), M), fake({ uploadKey: k }).d)).status).toBe(503);
    const { d, calls } = fake();
    expect((await handle(req(blob(pdf()), M, null), d)).status).toBe(401);
    expect((await handle(req(blob(pdf()), M, 'k'.repeat(39) + 'x'), d)).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await handle(new Request('https://e.invalid/', { method: 'GET' }), d)).status).toBe(405);
    expect(timingSafeEqual('abc', 'abc')).toBe(true); expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
  it('stores a new PDF as draft under a sha256 key, create-only, and returns no URL', async () => {
    const { d, objects, calls } = fake(); const b = pdf();
    const r = await handle(req(blob(b), { ...M, sha256: hex(b).toUpperCase(), source_url: 'https://www.example.com/a.pdf', received_date: '2026-10-29' }), d);
    expect(r.status).toBe(201); const j = await r.json();
    expect(j).toEqual({ status: 'draft', sha256: hex(b), storage_key: `reference/Von Duprin/${hex(b)}.pdf`, bytes: b.byteLength, content_type: 'application/pdf', page_count: 2, page_count_estimated: true });
    expect(JSON.stringify(j)).not.toMatch(/https?:/);
    expect(objects.size).toBe(1);
    const reg = calls.find(c => c[0] === 'reference_upload_register')[1];
    expect(reg.p_metadata).toMatchObject({ revision: 'unknown', licence_storage: 'unknown', licence_ai_processing: 'unknown', licence_customer_display: 'unknown', interim_only: false, received_date: '2026-10-29' });
    expect(Object.keys(reg)).not.toContain('p_status');
  });
  it('duplicates by sha256 return 409 with the existing record and write nothing', async () => {
    const f = fake(); const b = pdf('dup');
    expect((await handle(req(blob(b), M), f.d)).status).toBe(201);
    const r = await handle(req(blob(b), { ...M, manufacturer: 'Other' }, KEY, 'renamed.pdf'), f.d);
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ error: 'duplicate', sha256: hex(b), existing: { status: 'draft' } });
    expect(f.objects.size).toBe(1);
  });
  it('refuses a hash mismatch, wrong type, spoofed content, oversize, bad metadata and approval fields', async () => {
    const { d, objects } = fake();
    expect((await handle(req(blob(pdf()), { ...M, sha256: 'a'.repeat(64) }), d)).status).toBe(422);
    expect((await handle(req(blob(pdf(), 'application/zip'), M), d)).status).toBe(415);
    expect((await handle(req(blob(new TextEncoder().encode('not a pdf')), M), d)).status).toBe(415);
    expect((await handle(req(blob(new Uint8Array(MAX_BYTES + 1)), M), d)).status).toBe(413);
    expect((await handle(req(blob(pdf()), 'not json'), d)).status).toBe(400);
    for (const bad of [{ title: 'x' }, { ...M, status: 'approved' }, { ...M, approved_by: 'x' }, { ...M, storage_key: 'public/x' }, { ...M, licence_storage: 'yes' },
      { ...M, source_url: 'javascript:alert(1)' }, { ...M, received_date: '29/10/2026' }, { ...M, interim: 'true' }, { ...M, doc_type: 'whatever' }])
      expect((await handle(req(blob(pdf()), bad), d)).status, JSON.stringify(bad)).toBe(400);
    expect(objects.size).toBe(0);
  });
  it('accepts images, CSV and XLSX by content; interim flag and licences are kept as metadata', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]);
    const xlsx = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]);
    const csv = new TextEncoder().encode('a,b\n1,2\n');
    for (const [b, t, ext] of [[png, 'image/png', 'png'], [xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'], [csv, 'text/csv', 'csv']] as const) {
      const f = fake(); const r = await handle(req(blob(b, t), { ...M, interim: true, licence_ai_processing: 'restricted' }, KEY, 'f.' + ext), f.d);
      expect(r.status, t).toBe(201); expect((await r.json()).storage_key).toMatch(new RegExp(`\\.${ext}$`));
      expect(f.calls.find(c => c[0] === 'reference_upload_register')[1].p_metadata).toMatchObject({ interim_only: true, licence_ai_processing: 'restricted' });
    }
  });
  it('an existing identical object (half-finished earlier upload) is reused; a different one is a conflict', async () => {
    const b = pdf('orphan'); const f = fake(); f.objects.set(`reference/Von Duprin/${hex(b)}.pdf`, b);
    expect((await handle(req(blob(b), M), f.d)).status).toBe(201);
    const g = fake(); g.objects.set(`reference/Von Duprin/${hex(b)}.pdf`, pdf('different'));
    expect((await handle(req(blob(b), M), g.d)).status).toBe(409);
    expect(g.docs.size).toBe(0);
  });
  it('rate limit returns 429; parseMeta defaults; PDF page estimate', async () => {
    const f = fake({ rpc: async fn => (fn === 'reference_upload_check' ? { rate_limited: true } : null) });
    expect((await handle(req(blob(pdf()), M), f.d)).status).toBe(429);
    const p = parseMeta({ manufacturer: ' LCN ' }, 'x.pdf'); expect(p.ok && p.meta).toMatchObject({ manufacturer: 'LCN', brand: 'LCN', title: 'x.pdf', doc_type: 'unknown', revision: 'unknown', interim: false });
    expect(estimatePdfPages(pdf())).toBe(2);
  });
  it('has no overwrite, update or delete code path', () => {
    const src = readFileSync('supabase/reference-intake/functions/reference-upload/handler.ts', 'utf8') + readFileSync('supabase/reference-intake/functions/reference-upload/index.ts', 'utf8');
    expect(src).toContain('upsert: false'); expect(src).not.toMatch(/upsert:\s*true|\.remove\(|\.update\(|\.delete\(|\.move\(|createSignedUrl|getPublicUrl/);
  });
});

// ioqfd shape (read-only inspection, Oct 29 2026): reference_documents columns/constraints, RLS on, service_role/anon/authenticated roles.
const STUB = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE oi_reference_approver NOLOGIN;
CREATE TABLE users (id uuid PRIMARY KEY, is_active boolean DEFAULT true);
CREATE TABLE reference_documents (sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'), manufacturer text NOT NULL, brand text NOT NULL, title text NOT NULL,
  doc_type text NOT NULL, page_count integer NOT NULL CHECK (page_count > 0), storage_key text NOT NULL, metadata jsonb NOT NULL, status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','approved','superseded','duplicate')), superseded_by text REFERENCES reference_documents(sha256), duplicate_of text REFERENCES reference_documents(sha256),
  approved_by uuid REFERENCES users(id), approved_at timestamptz, CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)));
ALTER TABLE reference_documents ENABLE ROW LEVEL SECURITY;
CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, public boolean, file_size_limit bigint, allowed_mime_types text[]);
INSERT INTO storage.buckets VALUES ('oi-opening-media-pr2-private', false, 26214400, ARRAY['application/pdf','image/png']);`;
describe('insert-only migration (PGlite copy of the ioqfd shape)', () => {
  let db: PGlite; const q = (s: string, a?: unknown[]) => db.query<any>(s, a);
  const S = (c: string) => c.repeat(64);
  const reg = (sha: string, key = `reference/Von Duprin/${sha}.pdf`) => q("SELECT reference_upload_register('chat',$1,'Von Duprin','Von Duprin','t','installation',1,$2,'{}'::jsonb,10,'application/pdf') r", [sha, key]);
  beforeAll(async () => {
    db = new PGlite(); await db.exec(STUB);
    const m = readFileSync('supabase/reference-intake/migrations/20261029231500_reference_upload_route.sql', 'utf8');
    await db.exec(m); await db.exec(m); // idempotent
    await db.exec('GRANT USAGE ON SCHEMA public TO service_role');
  });
  it('the uploader role can only SELECT and INSERT; functions are service_role only', async () => {
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) expect((await q("SELECT has_table_privilege('oi_reference_uploader','reference_documents',$1) h", [p])).rows[0].h).toBe(false);
    for (const p of ['UPDATE', 'DELETE']) expect((await q("SELECT has_table_privilege('oi_reference_uploader','reference_upload_events',$1) h", [p])).rows[0].h).toBe(false);
    for (const r of ['anon', 'authenticated', 'public']) for (const f of ['reference_upload_register(text,text,text,text,text,text,integer,text,jsonb,bigint,text)', 'reference_upload_check(text,text,integer)', 'reference_upload_reject(text,text,text,bigint,text)'])
      expect((await q('SELECT has_function_privilege($1,$2,\'EXECUTE\') h', [r, f])).rows[0].h, r + f).toBe(false);
    expect((await q("SELECT has_function_privilege('service_role','reference_upload_register(text,text,text,text,text,text,integer,text,jsonb,bigint,text)','EXECUTE') h")).rows[0].h).toBe(true);
    expect((await q("SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'reference_upload_%' AND prosecdef AND proowner = 'oi_reference_uploader'::regrole")).rows[0].n).toBe(3);
    expect((await q("SELECT has_schema_privilege('oi_reference_uploader','public','CREATE') h")).rows[0].h).toBe(false);
    for (const r of ['anon', 'authenticated']) expect((await q("SELECT has_table_privilege($1,'reference_upload_events','SELECT') h", [r])).rows[0].h).toBe(false);
  });
  it('registers a draft with audit; a duplicate returns the existing row and changes nothing', async () => {
    await db.exec('SET ROLE service_role');
    expect((await reg(S('1'))).rows[0].r).toMatchObject({ inserted: true, status: 'draft' });
    const again = (await reg(S('1'), 'reference/Other/' + S('1') + '.pdf')).rows[0].r;
    expect(again).toMatchObject({ inserted: false, existing: { sha256: S('1'), status: 'draft', manufacturer: 'Von Duprin' } });
    expect((await q("SELECT reference_upload_check('chat',$1,300) r", [S('1')])).rows[0].r.existing.sha256).toBe(S('1'));
    await db.exec('RESET ROLE');
    expect((await q('SELECT status, storage_key, metadata->>\'uploaded_by\' u FROM reference_documents')).rows).toEqual([{ status: 'draft', storage_key: `reference/Von Duprin/${S('1')}.pdf`, u: 'chat' }]);
    expect((await q('SELECT outcome FROM reference_upload_events ORDER BY id')).rows.map((r: any) => r.outcome)).toEqual(['inserted', 'duplicate', 'duplicate']);
  });
  it('as the uploader role: cannot approve, update, delete, or insert a non-draft / non-reference key', async () => {
    await db.exec('SET ROLE oi_reference_uploader');
    await expect(q("UPDATE reference_documents SET status='approved'")).rejects.toThrow(/permission/i);
    await expect(q('DELETE FROM reference_documents')).rejects.toThrow(/permission/i);
    await expect(q("DELETE FROM reference_upload_events")).rejects.toThrow(/permission/i);
    await expect(q("INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status) VALUES($1,'a','a','t','x',1,'reference/a/'||$1,'{}','superseded')", [S('2')])).rejects.toThrow(/row-level security/i);
    await expect(q("INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata) VALUES($1,'a','a','t','x',1,'public/x','{}')", [S('3')])).rejects.toThrow(/row-level security/i);
    await db.exec('RESET ROLE');
  });
  it('rate limit refuses and is logged; bucket stays private and gains only CSV/XLSX', async () => {
    await db.exec('SET ROLE service_role');
    expect((await q("SELECT reference_upload_check('chat',$1,1) r", [S('4')])).rows[0].r).toEqual({ rate_limited: true });
    await q("SELECT reference_upload_reject('chat','unsupported_type',NULL,5,'application/zip')");
    await db.exec('RESET ROLE');
    expect((await q("SELECT outcome FROM reference_upload_events ORDER BY id DESC LIMIT 2")).rows.map((r: any) => r.outcome)).toEqual(['rejected', 'rate_limited']);
    expect((await q("SELECT public, allowed_mime_types m FROM storage.buckets")).rows[0]).toEqual({ public: false,
      m: ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/png', 'text/csv'] });
  });
});
