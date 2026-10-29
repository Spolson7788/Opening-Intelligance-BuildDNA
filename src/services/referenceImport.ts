// Reference library imports (draft only). Pure planning functions turn the PC manifests into rows;
// applyPlan() inserts them idempotently (ON CONFLICT DO NOTHING). Nothing here approves anything:
// documents, products, dimensions and look-alike groups always land as draft / unverified, and LCN
// Part A assets are marked interim-only. The CLI (scripts/reference-import.ts) is dry-run by default
// and refuses any database that is not local.
import { createHash } from 'node:crypto';

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(v => v !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some(v => v !== '')) rows.push(row); }
  const [head, ...body] = rows; if (!head) return [];
  const h = head.map(x => x.trim());
  return body.map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const blank = (v?: string) => (v && v.trim() ? v.trim() : null);
const key = (m: string, model: string, series: string | null) => `${m.toLowerCase()}|${model.toLowerCase()}|${(series ?? '').toLowerCase()}`;
export const deterministicId = (k: string) => {
  const h = createHash('sha256').update('reference-product:' + k).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface ProductRow { id: string; manufacturer: string; component_class: string | null; series: string | null; model: string;
  registry_row_ref: string | null; spec_sheet_url: string | null; cut_sheet_url: string | null; interim_only: boolean; imported_from: string }
export interface AssetRow { package: string; manufacturer: string; relative_path: string; asset_type: string | null; byte_size: number | null;
  sha256: string | null; interim_only: boolean; recognition_use_status: string | null; metadata: Record<string, string> }
export interface DimensionRow { id: string; product_id: string; name: string; dimension_source: string | null; claim_tier: string | null;
  verification_status: 'unverified' | 'manufacturer_stated'; does_not_establish: string | null; configuration: string | null; imported_from: string }
export interface Plan { products: ProductRow[]; assets: AssetRow[]; dimensions: DimensionRow[];
  groups: { id: string; name: string; basis: string | null; source_document: string | null; source_locator: string | null; may_support_promotion: boolean }[];
  members: { group_id: string; member_key: string; manufacturer: string; series_or_model: string }[];
  pairs: { id: string; group_id: string | null; member_a: string; member_b: string; confusion_basis: string | null; basis_statement: string | null; does_not_establish: string | null; document_number: string | null; source_locator: string | null }[];
  skipped: Record<string, number> }

export const emptyPlan = (): Plan => ({ products: [], assets: [], dimensions: [], groups: [], members: [], pairs: [], skipped: {} });
const skip = (p: Plan, why: string) => { p.skipped[why] = (p.skipped[why] ?? 0) + 1; };

export function planRegistry(plan: Plan, csv: string, source = 'pc:registry_v17') {
  const seen = new Set(plan.products.map(p => key(p.manufacturer, p.model, p.series)));
  for (const r of parseCsv(csv)) {
    const m = blank(r.manufacturer), model = blank(r.model);
    if (!m || !model) { skip(plan, 'registry_missing_identity'); continue; }
    const series = blank(r.series); const k = key(m, model, series);
    if (seen.has(k)) { skip(plan, 'registry_duplicate_identity'); continue; }
    seen.add(k);
    plan.products.push({ id: deterministicId(k), manufacturer: m, component_class: blank(r.component_class), series, model,
      registry_row_ref: blank(r.source_row_ref), spec_sheet_url: blank(r.spec_sheet_url), cut_sheet_url: blank(r.cut_sheet_url), interim_only: false, imported_from: source });
  }
  return plan;
}

export function planAssetManifest(plan: Plan, csv: string, opts: { pkg: string; manufacturer?: string; interim?: boolean }) {
  const seen = new Set(plan.assets.map(a => a.package + '|' + a.relative_path));
  for (const r of parseCsv(csv)) {
    const path = blank(r.relative_path) ?? blank(r.handoff_path);
    if (!path) { skip(plan, 'asset_missing_path'); continue; }
    const k = opts.pkg + '|' + path; if (seen.has(k)) { skip(plan, 'asset_duplicate'); continue; } seen.add(k);
    const sha = blank(r.sha256)?.toLowerCase() ?? null;
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) { skip(plan, 'asset_bad_sha256'); continue; }
    const size = Number(r.bytes || r.size_bytes);
    const interim = !!opts.interim || /INTERIM/i.test(r.recognition_use_status ?? '');
    const { relative_path, handoff_path, sha256, bytes, size_bytes, manufacturer, file_type, asset_type, recognition_use_status, ...rest } = r;
    plan.assets.push({ package: opts.pkg, manufacturer: blank(r.manufacturer) ?? opts.manufacturer ?? 'unknown', relative_path: path,
      asset_type: blank(r.asset_type) ?? blank(r.file_type), byte_size: Number.isFinite(size) && size > 0 ? size : null, sha256: sha,
      interim_only: interim, recognition_use_status: blank(r.recognition_use_status), metadata: rest });
  }
  return plan;
}

// 'B01/P01_99EO_AX_626' -> '99EO'
export const vdModelToken = (s: string) => (s.split('/').pop() ?? s).replace(/^P\d+_/, '').replace(/^VD_/, '').split('_')[0];

export function planVdDimensions(plan: Plan, csv: string, source = 'pc:vd_dimension_manifest') {
  const byModel = new Map(plan.products.filter(p => /von duprin/i.test(p.manufacturer)).map(p => [p.model.toUpperCase(), p]));
  const seen = new Set<string>();
  for (const r of parseCsv(csv)) {
    const src = blank(r.output_product) ?? blank(r.source_product); if (!src) { skip(plan, 'dimension_missing_product'); continue; }
    const token = vdModelToken(src).toUpperCase(); if (!token) { skip(plan, 'dimension_missing_product'); continue; }
    let p = byModel.get(token);
    if (!p) {
      const k = key('Von Duprin', token, null);
      p = { id: deterministicId(k), manufacturer: 'Von Duprin', component_class: 'EXIT_DEVICE', series: null, model: token, registry_row_ref: null,
        spec_sheet_url: null, cut_sheet_url: null, interim_only: false, imported_from: source };
      plan.products.push(p); byModel.set(token, p);
    }
    const name = 'dimensioned_image:' + (blank(r.dimensioned_image) ?? src);
    const dk = p.id + '|' + name + '|' + src; if (seen.has(dk)) { skip(plan, 'dimension_duplicate'); continue; } seen.add(dk);
    // Import never verifies: manufacturer-stated at most.
    const vs = /MANUFACTURER-STATED/i.test(r.verification_status ?? '') ? 'manufacturer_stated' : 'unverified';
    plan.dimensions.push({ id: deterministicId('dim:' + dk), product_id: p.id, name, dimension_source: blank(r.dimension_source),
      claim_tier: blank(r.claim_tier), verification_status: vs, does_not_establish: blank(r.does_not_establish), configuration: src, imported_from: source });
  }
  return plan;
}

export function planHardNegatives(plan: Plan, files: { sets: string; members: string; pairs: string }) {
  for (const r of parseCsv(files.sets)) {
    if (!blank(r.comparison_set_id)) { skip(plan, 'lookalike_set_missing_id'); continue; }
    plan.groups.push({ id: r.comparison_set_id, name: r.name || r.comparison_set_id, basis: blank(r.scope_type), source_document: blank(r.document_number) ?? blank(r.evidence_source_file),
      source_locator: blank(r.source_locator), may_support_promotion: /^YES$/i.test(r.may_support_promotion ?? '') });
  }
  const only = plan.groups.length === 1 ? plan.groups[0].id : null;
  for (const r of parseCsv(files.members)) {
    const g = blank(r.comparison_set_id) ?? only; if (!g || !blank(r.member_id)) { skip(plan, 'lookalike_member_unassigned'); continue; }
    plan.members.push({ group_id: g, member_key: r.member_id, manufacturer: r.manufacturer || 'unknown', series_or_model: r.device_series_as_printed || r.member_id });
  }
  for (const r of parseCsv(files.pairs)) {
    if (!blank(r.confuser_id) || !blank(r.node_id) || !blank(r.confuser_node_id)) { skip(plan, 'lookalike_pair_incomplete'); continue; }
    plan.pairs.push({ id: r.confuser_id, group_id: blank(r.comparison_set_id), member_a: r.node_id, member_b: r.confuser_node_id,
      confusion_basis: blank(r.confusion_basis), basis_statement: blank(r.basis_statement), does_not_establish: blank(r.does_not_establish),
      document_number: blank(r.document_number), source_locator: blank(r.source_locator) });
  }
  return plan;
}

export const planCounts = (p: Plan) => ({ products: p.products.length, assets: p.assets.length, assets_interim: p.assets.filter(a => a.interim_only).length,
  assets_with_sha256: p.assets.filter(a => a.sha256).length, dimensions: p.dimensions.length, lookalike_groups: p.groups.length,
  lookalike_members: p.members.length, lookalike_pairs: p.pairs.length, skipped: p.skipped });

async function chunked<T>(rows: T[], n: number, f: (c: T[]) => Promise<void>) { for (let i = 0; i < rows.length; i += n) await f(rows.slice(i, i + n)); }
const ins = (table: string, cols: string[], conflict: string) => (rows: any[][]) => {
  const params: unknown[] = []; const vals = rows.map(r => '(' + r.map(v => { params.push(v); return '$' + params.length; }).join(',') + ')').join(',');
  return { sql: `INSERT INTO ${table}(${cols.join(',')}) VALUES ${vals} ON CONFLICT ${conflict} DO NOTHING`, params };
};

/** Inserts the plan as draft rows. Idempotent. Returns rows actually inserted per table. */
export async function applyPlan(db: Q, plan: Plan) {
  const before = await tableCounts(db);
  const run = async (table: string, cols: string[], conflict: string, rows: any[][]) =>
    chunked(rows, 200, async c => { const s = ins(table, cols, conflict)(c); await db.query(s.sql, s.params); });
  await run('reference_products', ['id','manufacturer','component_class','series','model','registry_row_ref','spec_sheet_url','cut_sheet_url','status','interim_only','imported_from'], '',
    plan.products.map(p => [p.id, p.manufacturer, p.component_class, p.series, p.model, p.registry_row_ref, p.spec_sheet_url, p.cut_sheet_url, 'draft', p.interim_only, p.imported_from]));
  await run('reference_assets', ['package','manufacturer','relative_path','asset_type','byte_size','sha256','interim_only','recognition_use_status','metadata'], '(package, relative_path)',
    plan.assets.map(a => [a.package, a.manufacturer, a.relative_path, a.asset_type, a.byte_size, a.sha256, a.interim_only, a.recognition_use_status, JSON.stringify(a.metadata)]));
  await run('reference_dimensions', ['id','product_id','name','dimension_source','claim_tier','verification_status','does_not_establish','configuration','imported_from'], '(id)',
    plan.dimensions.map(d => [d.id, d.product_id, d.name, d.dimension_source, d.claim_tier, d.verification_status, d.does_not_establish, d.configuration, d.imported_from]));
  await run('reference_lookalike_groups', ['id','name','basis','source_document','source_locator','status','may_support_promotion','imported_from'], '(id)',
    plan.groups.map(g => [g.id, g.name, g.basis, g.source_document, g.source_locator, 'draft', g.may_support_promotion, 'pc:vd_hard_negatives_seed']));
  await run('reference_lookalike_members', ['group_id','member_key','manufacturer','series_or_model'], '(group_id, member_key)',
    plan.members.map(m => [m.group_id, m.member_key, m.manufacturer, m.series_or_model]));
  await run('reference_lookalike_pairs', ['id','group_id','member_a','member_b','confusion_basis','basis_statement','does_not_establish','document_number','source_locator'], '(id)',
    plan.pairs.map(p => [p.id, p.group_id, p.member_a, p.member_b, p.confusion_basis, p.basis_statement, p.does_not_establish, p.document_number, p.source_locator]));
  const after = await tableCounts(db);
  return Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] ?? 0)]));
}

export const LIBRARY_TABLES = ['reference_documents','reference_document_models','reference_pages','reference_conflicts','reference_products',
  'reference_dimensions','reference_lookalike_groups','reference_lookalike_members','reference_lookalike_pairs','reference_assets'] as const;
export async function tableCounts(db: Q) {
  const out: Record<string, number> = {};
  for (const t of LIBRARY_TABLES) out[t] = Number((await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n);
  return out;
}

/**
 * One-time copy from the opening-intelligence-staging library into the app schema. Dedupe by sha256:
 * documents already present are skipped with their models/pages. Everything lands as draft with
 * licences 'unknown'; the source status is kept only in metadata.source_status. Read-only on the source.
 */
export async function copyFromLibrary(source: Q, target: Q, opts: { batch?: number; sourceRef: string }) {
  const existing = new Set((await target.query('SELECT sha256 FROM reference_documents')).rows.map((r: any) => r.sha256));
  const docs = (await source.query(`SELECT sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,superseded_by,duplicate_of,approved_at
    FROM reference_documents ORDER BY sha256`)).rows;
  const res = { source_documents: docs.length, copied_documents: 0, skipped_existing: 0, copied_models: 0, copied_pages: 0, copied_conflicts: 0 };
  for (const d of docs) {
    if (existing.has(d.sha256)) { res.skipped_existing++; continue; }
    const meta = { ...(typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata ?? {}), source_status: d.status, source_superseded_by: d.superseded_by,
      source_duplicate_of: d.duplicate_of, source_approved_at: d.approved_at, source_project: opts.sourceRef };
    await target.query(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,imported_from)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9) ON CONFLICT (sha256) DO NOTHING`,
      [d.sha256, d.manufacturer, d.brand, d.title, d.doc_type, d.page_count, d.storage_key, JSON.stringify(meta), opts.sourceRef]);
    existing.add(d.sha256); res.copied_documents++;
    for (const m of (await source.query('SELECT model,series,variant,evidence_page,evidence_quote FROM reference_document_models WHERE doc_sha256=$1', [d.sha256])).rows) {
      await target.query(`INSERT INTO reference_document_models(doc_sha256,model,series,variant,evidence_page,evidence_quote) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (doc_sha256, model, evidence_page) DO NOTHING`, [d.sha256, m.model, m.series, m.variant, m.evidence_page, m.evidence_quote]); res.copied_models++;
    }
    for (const p of (await source.query(`SELECT page_no,page_id,text,text_sha256,page_class,transcription_status,citable,fraction_unverified,image_key,image_sha256
      FROM reference_pages WHERE doc_sha256=$1`, [d.sha256])).rows) {
      await target.query(`INSERT INTO reference_pages(doc_sha256,page_no,page_id,text,text_sha256,page_class,transcription_status,citable,fraction_unverified,image_key,image_sha256,search_vector)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_tsvector('english',$4)) ON CONFLICT (doc_sha256,page_no) DO NOTHING`,
        [d.sha256, p.page_no, p.page_id, p.text, p.text_sha256, p.page_class, p.transcription_status, p.citable, p.fraction_unverified, p.image_key, p.image_sha256]); res.copied_pages++;
    }
    for (const c of (await source.query('SELECT field,"values" FROM reference_conflicts WHERE doc_sha256=$1', [d.sha256])).rows) {
      await target.query('INSERT INTO reference_conflicts(doc_sha256,field,"values") VALUES($1,$2,$3)', [d.sha256, c.field, JSON.stringify(c.values)]); res.copied_conflicts++;
    }
  }
  return res;
}

const FORBIDDEN_PROJECTS = ['fadihkhdwpfffpelqjtg', 'fdudsigbxumcpbxxxerb'];
/** Only local databases may be written by the import CLI. */
export function assertLocalTarget(url: string) {
  if (FORBIDDEN_PROJECTS.some(p => url.includes(p))) throw new Error('forbidden_project');
  const u = new URL(url);
  if (!['localhost', '127.0.0.1', '::1'].includes(u.hostname)) throw new Error('target_not_local');
}
export function assertAllowedSource(url: string) {
  if (FORBIDDEN_PROJECTS.some(p => url.includes(p))) throw new Error('forbidden_project');
}
