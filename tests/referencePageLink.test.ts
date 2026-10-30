import { describe, expect, it, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Page linking (mode=page) for the reference-upload route, ioqfdcehnhnqpnqawwvo only. Synthetic data only.
import { handle, parsePageMeta, pageImageKey, type Deps } from '../supabase/reference-intake/functions/reference-upload/handler';

const KEY = 'k'.repeat(40); // synthetic test value, not a real secret
const hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const png = (s = 'x') => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...new TextEncoder().encode(s)]);
const DOC = 'd'.repeat(64);
const PARENT = { sha256: DOC, status: 'draft', storage_key: `reference/Von Duprin/${DOC}.pdf`, page_count: 3 };

function fake(over: Partial<Deps> = {}, parent: any = PARENT) {
  const objects = new Map<string, Uint8Array>(); const pages = new Map<string, any>(); const calls: any[] = [];
  const d: Deps = {
    uploadKey: KEY, uploader: 'chat',
    rpc: async (fn, a: any) => {
      calls.push([fn, a]);
      if (fn === 'reference_page_check') {
        const e = pages.get(`${a.p_doc_sha256}#${a.p_page_no}`);
        return { rate_limited: false, parent: a.p_doc_sha256 === DOC ? parent : null,
          existing: e ? { ...e, identical: e.image_sha256 === a.p_image_sha256 && e.text_sha256 === a.p_text_sha256 } : null };
      }
      if (fn === 'reference_page_register') { const k = `${a.p_doc_sha256}#${a.p_page_no}`; if (pages.has(k)) return { inserted: false, duplicate: true };
        pages.set(k, { image_sha256: a.p_image_sha256, text_sha256: a.p_text_sha256, image_key: a.p_image_key }); return { inserted: true, page_id: `sha256:${a.p_doc_sha256}#p${a.p_page_no}` }; }
      return null;
    },
    putObject: async (k, b) => { if (objects.has(k)) return 'exists'; objects.set(k, b); return 'created'; },
    getObject: async k => objects.get(k) ?? null,
    sha256: async b => hex(b), ...over,
  };
  return { d, objects, pages, calls };
}
const meta = (b: Uint8Array, page_no = 1, text = 'Page text', extra: Record<string, unknown> = {}) => ({ doc_sha256: DOC, page_no, page_id: `sha256:${DOC}#p${page_no}`,
  text, text_sha256: hex(text), page_class: 'mixed', image_sha256: hex(b), image_key: `reference/Von Duprin/${DOC}/p${String(page_no).padStart(3, '0')}.${hex(b)}.png`, ...extra });
const req = (b: Uint8Array | null, m: unknown, key: string | null = KEY, type = 'image/png') => {
  const f = new FormData(); f.append('mode', 'page'); if (b) f.append('file', new Blob([b], { type }), 'p001.png'); f.append('metadata', JSON.stringify(m));
  const h: Record<string, string> = {}; if (key !== null) h['x-oi-upload-key'] = key;
  return new Request('https://example.invalid/functions/v1/reference-upload', { method: 'POST', body: f, headers: h });
};

describe('reference-upload page mode', () => {
  it('requires the key (503 unset, 401 wrong) before touching anything', async () => {
    const b = png();
    expect((await handle(req(b, meta(b)), fake({ uploadKey: undefined }).d)).status).toBe(503);
    const f = fake(); expect((await handle(req(b, meta(b), 'x'.repeat(40)), f.d)).status).toBe(401);
    expect(f.calls).toEqual([]); expect(f.objects.size).toBe(0);
  });
  it('links a page as draft: folder from the parent stored key, create-only write, readback hash before register', async () => {
    const f = fake(); const b = png(); const order: string[] = [];
    const d = { ...f.d, getObject: async (k: string) => { order.push('readback'); return f.d.getObject(k); },
      rpc: async (fn: string, a: any) => { order.push(fn); return f.d.rpc(fn, a); } };
    const r = await handle(req(b, meta(b)), d); expect(r.status).toBe(201);
    const j = await r.json();
    expect(j).toMatchObject({ status: 'draft', kind: 'page', page_no: 1, image_key: `reference/Von Duprin/${DOC}/p001.${hex(b)}.png`, readback_sha256: hex(b), citable: false });
    expect(JSON.stringify(j)).not.toMatch(/https?:/);
    expect(order).toEqual(['reference_page_check', 'readback', 'reference_page_register']);
  });
  it('re-sending the same page is a duplicate (409) and writes nothing new', async () => {
    const f = fake(); const b = png();
    expect((await handle(req(b, meta(b)), f.d)).status).toBe(201);
    const r = await handle(req(b, meta(b)), f.d); expect(r.status).toBe(409); expect((await r.json()).error).toBe('duplicate');
    expect(f.objects.size).toBe(1); expect(f.calls.filter(c => c[0] === 'reference_page_register').length).toBe(1);
  });
  it('a different image or text for an existing page is a conflict; nothing written', async () => {
    const f = fake(); const b = png();
    await handle(req(b, meta(b)), f.d);
    const b2 = png('other'); const r = await handle(req(b2, meta(b2)), f.d);
    expect(r.status).toBe(409); expect((await r.json()).error).toBe('page_conflict');
    const r2 = await handle(req(b, meta(b, 1, 'changed text')), f.d); expect((await r2.json()).error).toBe('page_conflict');
    expect(f.objects.size).toBe(1);
  });
  it('rejects a missing / non-draft parent, a wrong manufacturer folder, and an unexpected parent key', async () => {
    const b = png();
    expect((await handle(req(b, { ...meta(b), doc_sha256: 'e'.repeat(64), page_id: undefined, image_key: undefined }), fake().d)).status).toBe(404);
    expect((await handle(req(b, meta(b)), fake({}, { ...PARENT, status: 'approved' }).d)).status).toBe(409);
    const f = fake(); const r = await handle(req(b, meta(b, 1, 'Page text', { image_key: `reference/Other/${DOC}/p001.${hex(b)}.png` })), f.d);
    expect(r.status).toBe(409); expect((await r.json()).error).toBe('image_key_mismatch'); expect(f.objects.size).toBe(0);
    const g = fake({}, { ...PARENT, storage_key: `reference/Von Duprin/${DOC}/original.pdf` });
    expect((await (await handle(req(b, meta(b)), g.d)).json()).error).toBe('parent_storage_key_unexpected');
    expect((await handle(req(b, meta(b, 4)), fake().d)).status).toBe(400);
  });
  it('refuses hash mismatches, non-PNG, and approval/citation fields', async () => {
    const f = fake(); const b = png();
    expect((await handle(req(b, { ...meta(b), image_sha256: 'a'.repeat(64) }), f.d)).status).toBe(422);
    expect((await handle(req(b, { ...meta(b), text_sha256: 'a'.repeat(64) }), f.d)).status).toBe(422);
    expect((await handle(req(b, meta(b), KEY, 'application/pdf'), f.d)).status).toBe(415);
    expect((await handle(req(new TextEncoder().encode('%PDF-1.4'), meta(new TextEncoder().encode('%PDF-1.4'))), f.d)).status).toBe(415);
    for (const k of ['citable', 'transcription_status', 'fraction_unverified', 'status']) expect((await handle(req(b, { ...meta(b), [k]: true }), f.d)).status, k).toBe(400);
    expect(f.objects.size).toBe(0);
  });
  it('an existing different object at the key fails readback (conflict); a failed readback is 502; nothing registered', async () => {
    const b = png(); const f = fake(); f.objects.set(`reference/Von Duprin/${DOC}/p001.${hex(b)}.png`, png('tampered'));
    expect((await (await handle(req(b, meta(b)), f.d)).json()).error).toBe('storage_key_conflict');
    const g = fake({ getObject: async () => null }); expect((await handle(req(b, meta(b)), g.d)).status).toBe(502);
    expect(f.pages.size + g.pages.size).toBe(0);
  });
  it('helpers', () => {
    expect(pageImageKey(`reference/LCN/${DOC}.pdf`, DOC, 12, 'a'.repeat(64))).toBe(`reference/LCN/${DOC}/p012.${'a'.repeat(64)}.png`);
    expect(pageImageKey(`reference/LCN/${'f'.repeat(64)}.pdf`, DOC, 1, 'a'.repeat(64))).toBeNull();
    expect(parsePageMeta({ ...meta(png()), page_id: 'sha256:x#p1' })).toEqual({ ok: false, error: 'page_id_mismatch' });
  });
  it('has no overwrite, update or delete code path', () => {
    const src = readFileSync('supabase/reference-intake/functions/reference-upload/handler.ts', 'utf8');
    expect(src).not.toMatch(/upsert:\s*true|\.remove\(|\.update\(|\.delete\(|\.move\(|createSignedUrl|getPublicUrl/);
  });
});

const STUB = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE oi_reference_approver NOLOGIN;
CREATE TABLE users (id uuid PRIMARY KEY, is_active boolean DEFAULT true);
CREATE TABLE reference_documents (sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'), manufacturer text NOT NULL, brand text NOT NULL, title text NOT NULL,
  doc_type text NOT NULL, page_count integer NOT NULL CHECK (page_count > 0), storage_key text NOT NULL, metadata jsonb NOT NULL, status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','approved','superseded','duplicate')), superseded_by text REFERENCES reference_documents(sha256), duplicate_of text REFERENCES reference_documents(sha256),
  approved_by uuid REFERENCES users(id), approved_at timestamptz, CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)));
ALTER TABLE reference_documents ENABLE ROW LEVEL SECURITY;
-- ioqfd reference_pages shape (read-only inspection, Oct 30 2026), incl. generated page_id/search_vector.
CREATE TABLE reference_pages (doc_sha256 text NOT NULL REFERENCES reference_documents(sha256), page_no integer NOT NULL CHECK (page_no > 0),
  page_id text GENERATED ALWAYS AS ('sha256:' || doc_sha256 || '#p' || page_no::text) STORED UNIQUE,
  text text NOT NULL, text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  page_class text NOT NULL CHECK (page_class IN ('text','drawing','scan','photo','blank','mixed')),
  transcription_status text NOT NULL CHECK (transcription_status IN ('none','queued','transcribed','verified')), citable boolean NOT NULL,
  fraction_unverified boolean NOT NULL DEFAULT false, image_key text, image_sha256 text CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[a-f0-9]{64}$'),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (doc_sha256, page_no),
  CHECK (NOT citable OR (page_class <> 'blank' AND NOT fraction_unverified AND (page_class NOT IN ('scan','drawing','mixed') OR transcription_status = 'verified'))));
ALTER TABLE reference_pages ENABLE ROW LEVEL SECURITY;
CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, public boolean, file_size_limit bigint, allowed_mime_types text[]);
INSERT INTO storage.buckets VALUES ('oi-opening-media-pr2-private', false, 26214400, ARRAY['application/pdf','image/png']);`;

describe('page-link migration (PGlite copy of the ioqfd shape)', () => {
  let db: PGlite; const q = (s: string, a?: unknown[]) => db.query<any>(s, a);
  const D1 = '1'.repeat(64), D2 = '2'.repeat(64), I = 'a'.repeat(64), I2 = 'b'.repeat(64), TXT = 'hello page', TS = hex(TXT);
  const key = (doc: string, n: number, img: string, folder = 'Von Duprin') => `reference/${folder}/${doc}/p${String(n).padStart(3, '0')}.${img}.png`;
  const reg = (doc: string, n: number, img: string, k = key(doc, n, img), text = TXT, ts = TS) =>
    q("SELECT reference_page_register('chat',$1,$2,$3,$4,'mixed',$5,$6,100) r", [doc, n, text, ts, k, img]);
  beforeAll(async () => {
    db = new PGlite(); await db.exec(STUB);
    await db.exec(readFileSync('supabase/reference-intake/migrations/20261029231500_reference_upload_route.sql', 'utf8'));
    const m = readFileSync('supabase/reference-intake/migrations/20261030120000_reference_page_link.sql', 'utf8');
    await db.exec(m); await db.exec(m); // idempotent
    await db.exec('GRANT USAGE ON SCHEMA public TO service_role');
    await db.exec(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status) VALUES
      ('${D1}','Von Duprin','Von Duprin','t','installation',2,'reference/Von Duprin/${D1}.pdf','{}','draft')`);
    await db.exec(`INSERT INTO users VALUES ('00000000-0000-0000-0000-000000000001');
      INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,approved_by,approved_at) VALUES
      ('${D2}','LCN','LCN','t','installation',2,'reference/LCN/${D2}.pdf','{}','approved','00000000-0000-0000-0000-000000000001',now())`);
  });
  it('functions are owned by the insert-only role and executable only by service_role', async () => {
    const fns = ['reference_page_check(text,text,integer,text,text,integer)', 'reference_page_register(text,text,integer,text,text,text,text,text,bigint)'];
    for (const r of ['anon', 'authenticated', 'public']) for (const f of fns) expect((await q("SELECT has_function_privilege($1,$2,'EXECUTE') h", [r, f])).rows[0].h, r + f).toBe(false);
    for (const f of fns) expect((await q("SELECT has_function_privilege('service_role',$1,'EXECUTE') h", [f])).rows[0].h).toBe(true);
    expect((await q("SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'reference_page_%' AND prosecdef AND proowner = 'oi_reference_uploader'::regrole")).rows[0].n).toBe(2);
    for (const p of ['UPDATE', 'DELETE', 'TRUNCATE']) expect((await q("SELECT has_table_privilege('oi_reference_uploader','reference_pages',$1) h", [p])).rows[0].h).toBe(false);
    expect((await q("SELECT has_schema_privilege('oi_reference_uploader','public','CREATE') h")).rows[0].h).toBe(false);
  });
  it('inserts a draft page, skips an exact duplicate, rejects conflicts, wrong folder, bad text hash, non-draft parent', async () => {
    await db.exec('SET ROLE service_role');
    expect((await reg(D1, 1, I)).rows[0].r).toMatchObject({ inserted: true, page_id: `sha256:${D1}#p1` });
    expect((await reg(D1, 1, I)).rows[0].r).toEqual({ inserted: false, duplicate: true });
    expect((await reg(D1, 1, I2)).rows[0].r).toEqual({ inserted: false, conflict: true });
    const chk = (await q("SELECT reference_page_check('chat',$1,1,$2,$3,300) r", [D1, I, TS])).rows[0].r;
    expect(chk).toMatchObject({ rate_limited: false, parent: { status: 'draft', storage_key: `reference/Von Duprin/${D1}.pdf` }, existing: { identical: true } });
    await expect(reg(D1, 2, I, key(D1, 2, I, 'Other'))).rejects.toThrow(/image_key_mismatch/);
    await expect(reg(D1, 2, I, key(D1, 2, I), 'x', TS)).rejects.toThrow(/text_sha256_mismatch/);
    await expect(reg(D1, 3, I)).rejects.toThrow(/page_no_exceeds/);
    await expect(reg(D2, 1, I, key(D2, 1, I, 'LCN'))).rejects.toThrow(/parent_not_draft/);
    await expect(reg('3'.repeat(64), 1, I)).rejects.toThrow(/parent_not_found/);
    await db.exec('RESET ROLE');
    expect((await q('SELECT page_no, citable, fraction_unverified, transcription_status, image_sha256 FROM reference_pages')).rows)
      .toEqual([{ page_no: 1, citable: false, fraction_unverified: true, transcription_status: 'none', image_sha256: I }]);
    expect((await q("SELECT outcome FROM reference_upload_events WHERE detail->>'kind'='page' ORDER BY id")).rows.map((r: any) => r.outcome)).toEqual(['inserted', 'duplicate', 'rejected']);
  });
  it('as the uploader role: cannot update/delete pages or insert citable / non-draft-parent rows', async () => {
    await db.exec('SET ROLE oi_reference_uploader');
    await expect(q('UPDATE reference_pages SET citable=true')).rejects.toThrow(/permission/i);
    await expect(q('DELETE FROM reference_pages')).rejects.toThrow(/permission/i);
    const ins = (doc: string, n: number, cit: boolean) => q(`INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable,fraction_unverified,image_key,image_sha256)
      VALUES ($1,$2,'t',$3,'text','none',$4,true,$5,$6)`, [doc, n, TS, cit, key(doc, n, I), I]);
    await expect(ins(D1, 2, true)).rejects.toThrow(/row-level security/i);
    await expect(ins(D2, 2, false)).rejects.toThrow(/row-level security/i);
    await db.exec('RESET ROLE');
  });
  it('page rate limit refuses and is logged; bucket unchanged by this migration', async () => {
    await db.exec('SET ROLE service_role');
    expect((await q("SELECT reference_page_check('chat',$1,2,$2,$3,1) r", [D1, I, TS])).rows[0].r).toEqual({ rate_limited: true });
    await db.exec('RESET ROLE');
    expect((await q("SELECT public FROM storage.buckets")).rows[0].public).toBe(false);
  });
});