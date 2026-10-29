// reference-upload: insert-only, authenticated upload of manufacturer reference documents into the
// private bucket oi-opening-media-pr2-private on opening-intelligence-staging (ioqfdcehnhnqpnqawwvo).
// Pure logic (no Deno globals) so it is unit-tested in Node; index.ts wires the real dependencies.
// There is deliberately NO approve, update, overwrite (upsert) or delete code path in this file.

export const BUCKET = 'oi-opening-media-pr2-private';
export const MAX_BYTES = 25 * 1024 * 1024; // matches the bucket limit (26,214,400)
export const RATE_LIMIT_PER_HOUR = 300;
const LICENCE = ['unknown', 'permitted', 'restricted', 'denied'] as const;
const DOC_TYPES = ['installation', 'product_data', 'catalog', 'template', 'spec_sheet', 'dimension_drawing', 'image', 'data_sheet', 'price_list', 'other', 'unknown'];

export const TYPES: Record<string, { ext: string; sniff: (b: Uint8Array) => boolean }> = {
  'application/pdf': { ext: 'pdf', sniff: b => ascii(b, 0, 5) === '%PDF-' },
  'image/jpeg': { ext: 'jpg', sniff: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', sniff: b => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' },
  'image/webp': { ext: 'webp', sniff: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  'image/heic': { ext: 'heic', sniff: b => ascii(b, 4, 8) === 'ftyp' },
  'text/csv': { ext: 'csv', sniff: b => !b.slice(0, 65536).includes(0) },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', sniff: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 },
};
function ascii(b: Uint8Array, s: number, e: number) { return String.fromCharCode(...b.slice(s, e)); }

export interface Deps {
  uploadKey: string | undefined;      // REFERENCE_UPLOAD_KEY function secret (set by Stephan); never logged or returned
  uploader: string;                   // REFERENCE_UPLOAD_IDENTITY, e.g. 'chat'
  rpc: (fn: string, args: Record<string, unknown>) => Promise<any>;
  // Storage writes are create-only (upsert:false). Returns 'created' | 'exists'.
  putObject: (key: string, bytes: Uint8Array, contentType: string) => Promise<'created' | 'exists'>;
  getObject: (key: string) => Promise<Uint8Array | null>;
  sha256: (b: Uint8Array) => Promise<string>;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function timingSafeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function estimatePdfPages(b: Uint8Array): number {
  const s = new TextDecoder('latin1').decode(b);
  const m = s.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return m ? m.length : 0;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null);
export const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown';

export interface Meta { manufacturer: string; brand: string; title: string; doc_type: string; source_url: string | null; received_date: string | null;
  revision: string; licence_storage: string; licence_ai_processing: string; licence_customer_display: string; interim: boolean;
  page_count: number | null; client_sha256: string | null; note: string | null; models: string[] }

export function parseMeta(raw: unknown, fileName: string): { ok: true; meta: Meta } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'metadata_must_be_object' };
  const r = raw as Record<string, unknown>;
  const allowed = new Set(['manufacturer', 'brand', 'title', 'doc_type', 'source_url', 'received_date', 'revision', 'licence_storage', 'licence_ai_processing',
    'licence_customer_display', 'interim', 'page_count', 'sha256', 'note', 'models']);
  // Fields that would approve or relate records are refused outright, not ignored.
  for (const k of Object.keys(r)) if (!allowed.has(k)) return { ok: false, error: 'unsupported_field:' + k.slice(0, 40) };
  const manufacturer = str(r.manufacturer, 120); if (!manufacturer) return { ok: false, error: 'manufacturer_required' };
  const lic = (k: string) => { const v = r[k] ?? 'unknown'; return (LICENCE as readonly unknown[]).includes(v) ? (v as string) : null; };
  const ls = lic('licence_storage'), la = lic('licence_ai_processing'), lc = lic('licence_customer_display');
  if (!ls || !la || !lc) return { ok: false, error: 'invalid_licence_value' };
  const doc_type = r.doc_type === undefined ? 'unknown' : str(r.doc_type, 40);
  if (!doc_type || !DOC_TYPES.includes(doc_type)) return { ok: false, error: 'invalid_doc_type' };
  let source_url: string | null = null;
  if (r.source_url !== undefined && r.source_url !== null) {
    const u = str(r.source_url, 2000); if (!u) return { ok: false, error: 'invalid_source_url' };
    try { const p = new URL(u); if (!['http:', 'https:'].includes(p.protocol)) throw 0; } catch { return { ok: false, error: 'invalid_source_url' }; }
    source_url = u;
  }
  let received_date: string | null = null;
  if (r.received_date !== undefined && r.received_date !== null) {
    if (typeof r.received_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.received_date) || isNaN(Date.parse(r.received_date))) return { ok: false, error: 'invalid_received_date' };
    received_date = r.received_date;
  }
  const revision = r.revision === undefined ? 'unknown' : str(r.revision, 80); if (!revision) return { ok: false, error: 'invalid_revision' };
  if (r.interim !== undefined && typeof r.interim !== 'boolean') return { ok: false, error: 'invalid_interim' };
  let page_count: number | null = null;
  if (r.page_count !== undefined) { if (!Number.isInteger(r.page_count) || (r.page_count as number) < 1 || (r.page_count as number) > 5000) return { ok: false, error: 'invalid_page_count' }; page_count = r.page_count as number; }
  let client_sha256: string | null = null;
  if (r.sha256 !== undefined) { if (typeof r.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.sha256)) return { ok: false, error: 'invalid_sha256' }; client_sha256 = r.sha256.toLowerCase(); }
  let models: string[] = [];
  if (r.models !== undefined) { if (!Array.isArray(r.models) || r.models.length > 200 || r.models.some(m => !str(m, 120))) return { ok: false, error: 'invalid_models' }; models = (r.models as string[]).map(m => m.trim()); }
  const note = r.note === undefined ? null : str(r.note, 1000);
  if (r.note !== undefined && !note) return { ok: false, error: 'invalid_note' };
  return { ok: true, meta: { manufacturer, brand: str(r.brand, 120) ?? manufacturer, title: str(r.title, 300) ?? (str(fileName, 300) ?? 'untitled'), doc_type,
    source_url, received_date, revision, licence_storage: ls, licence_ai_processing: la, licence_customer_display: lc, interim: r.interim === true, page_count, client_sha256, note, models } };
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  // Fail closed until Stephan sets the secret; a short key is treated as unset.
  if (!d.uploadKey || d.uploadKey.length < 32) return json(503, { error: 'upload_key_not_configured' });
  const presented = req.headers.get('x-oi-upload-key') ?? '';
  if (!presented || !timingSafeEqual(presented, d.uploadKey)) return json(401, { error: 'unauthorized' });

  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BYTES + 256 * 1024) return json(413, { error: 'file_too_large', max_bytes: MAX_BYTES });
  const reject = async (status: number, error: string, extra: Record<string, unknown> = {}, sha: string | null = null, size: number | null = null, ct: string | null = null) => {
    try { await d.rpc('reference_upload_reject', { p_uploader: d.uploader, p_reason: error, p_sha256: sha, p_byte_size: size, p_content_type: ct }); } catch { /* audit best effort */ }
    return json(status, { error, ...extra });
  };
  let form: FormData;
  try { form = await req.formData(); } catch { return reject(400, 'multipart_form_required'); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return reject(400, 'file_required');
  const ct = (file.type || '').toLowerCase().split(';')[0].trim();
  const type = TYPES[ct];
  if (!type) return reject(415, 'unsupported_type', { allowed: Object.keys(TYPES) }, null, file.size, ct);
  if (file.size <= 0) return reject(400, 'empty_file', {}, null, 0, ct);
  if (file.size > MAX_BYTES) return reject(413, 'file_too_large', { max_bytes: MAX_BYTES }, null, file.size, ct);
  let metaRaw: unknown;
  try { metaRaw = JSON.parse(String(form.get('metadata') ?? '')); } catch { return reject(400, 'metadata_json_required', {}, null, file.size, ct); }
  const pm = parseMeta(metaRaw, (file as File).name ?? '');
  if (!pm.ok) return reject(400, pm.error, {}, null, file.size, ct);
  const meta = pm.meta;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!type.sniff(bytes)) return reject(415, 'content_does_not_match_type', {}, null, bytes.byteLength, ct);
  const sha = await d.sha256(bytes);
  if (meta.client_sha256 && meta.client_sha256 !== sha) return reject(422, 'sha256_mismatch', { sha256: sha }, sha, bytes.byteLength, ct);

  const pre = await d.rpc('reference_upload_check', { p_uploader: d.uploader, p_sha256: sha, p_limit_per_hour: RATE_LIMIT_PER_HOUR });
  if (pre?.rate_limited) return json(429, { error: 'rate_limited', limit_per_hour: RATE_LIMIT_PER_HOUR });
  if (pre?.existing) return json(409, { error: 'duplicate', sha256: sha, existing: pre.existing });

  const key = `reference/${safeSegment(meta.manufacturer)}/${sha}.${type.ext}`;
  const put = await d.putObject(key, bytes, ct);
  if (put === 'exists') {
    // An object can exist without a row (an earlier upload stopped half-way). Accept it only if identical.
    const existing = await d.getObject(key);
    if (!existing || (await d.sha256(existing)) !== sha) return reject(409, 'storage_key_conflict', {}, sha, bytes.byteLength, ct);
  }
  let pages = meta.page_count ?? (ct === 'application/pdf' ? estimatePdfPages(bytes) : 1);
  const estimated = meta.page_count === null;
  if (!pages || pages < 1) pages = 1;
  const metadata = { source_url: meta.source_url, received_date: meta.received_date, revision: meta.revision, licence_storage: meta.licence_storage,
    licence_ai_processing: meta.licence_ai_processing, licence_customer_display: meta.licence_customer_display, interim_only: meta.interim,
    original_filename: ((file as File).name ?? '').slice(0, 300), content_type: ct, bytes: bytes.byteLength, sha256: sha, page_count_estimated: estimated,
    ...(meta.models.length ? { unverified_models: meta.models } : {}), ...(meta.note ? { note: meta.note } : {}) };
  const reg = await d.rpc('reference_upload_register', { p_uploader: d.uploader, p_sha256: sha, p_manufacturer: meta.manufacturer, p_brand: meta.brand,
    p_title: meta.title, p_doc_type: meta.doc_type, p_page_count: pages, p_storage_key: key, p_metadata: metadata, p_byte_size: bytes.byteLength, p_content_type: ct });
  if (!reg?.inserted) return json(409, { error: 'duplicate', sha256: sha, existing: reg?.existing ?? null });
  // No URL of any kind is returned: the object stays private.
  return json(201, { status: 'draft', sha256: sha, storage_key: key, bytes: bytes.byteLength, content_type: ct, page_count: pages, page_count_estimated: estimated });
}
