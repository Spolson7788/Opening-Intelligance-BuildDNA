// Recognition use of the reference library. Reads ONLY the single active, immutable reference release
// (reference_release_items), never draft tables. Facts get short stable ids the model must cite;
// citations are validated against exactly the ids that were sent. With no active release (or no
// library tables yet) recognition runs as before and cites nothing.
export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const REFERENCE_CONTEXT_VERSION = 'reference-context-v1';
export const MAX_REFERENCE_FACTS = 60;
export const MAX_REFERENCE_CHARS = 12000;

export interface ReferenceFact { id: string; kind: 'product' | 'page' | 'dimension' | 'lookalike_group'; source_key: string; text: string }
export interface ReferenceContext { release_id: string; version: number; facts: ReferenceFact[]; prompt: string }

export async function activeRelease(db: Q): Promise<{ id: string; version: number } | null> {
  try { const r = (await db.query("SELECT id, version FROM reference_releases WHERE status='active' LIMIT 1")).rows[0]; return r ? { id: r.id, version: Number(r.version) } : null; }
  catch { return null; }
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Candidate retrieval. hints = manufacturer / model strings already known for the opening (e.g. from the
 * hardware schedule); matching products, their verified dimensions, their source pages and any look-alike
 * group they belong to rank first. Everything comes from the release snapshot.
 */
export async function buildReferenceContext(db: Q, hints: string[] = []): Promise<ReferenceContext | null> {
  const rel = await activeRelease(db); if (!rel) return null;
  let items: any[];
  try { items = (await db.query('SELECT item_kind, item_key, content FROM reference_release_items WHERE release_id=$1 ORDER BY item_kind, item_key', [rel.id])).rows; }
  catch { return null; }
  const c = (x: any) => (typeof x.content === 'string' ? JSON.parse(x.content) : x.content);
  const products = items.filter(i => i.item_kind === 'product').map(c);
  const dims = items.filter(i => i.item_kind === 'dimension').map(c);
  const pages = new Map(items.filter(i => i.item_kind === 'page').map(i => [i.item_key, c(i)]));
  const groups = items.filter(i => i.item_kind === 'lookalike_group').map(c);
  const h = hints.map(norm).filter(Boolean);
  const score = (p: any) => h.some(x => x && (norm(p.model).includes(x) || x.includes(norm(p.model)))) ? 2 : h.some(x => norm(p.manufacturer) === x) ? 1 : 0;
  products.sort((a, b) => score(b) - score(a) || String(a.manufacturer).localeCompare(b.manufacturer) || String(a.model).localeCompare(b.model));
  const facts: ReferenceFact[] = []; let chars = 0; let n = 0;
  const push = (f: Omit<ReferenceFact, 'id'>) => {
    if (facts.length >= MAX_REFERENCE_FACTS || chars + f.text.length > MAX_REFERENCE_CHARS) return false;
    const id = `R${++n}`; facts.push({ id, ...f }); chars += f.text.length; return true;
  };
  for (const p of products) {
    if (!push({ kind: 'product', source_key: p.id, text: `${p.manufacturer} | series ${p.series ?? '-'} | model ${p.model} | class ${p.component_class ?? '-'}` })) break;
    for (const d of dims.filter(d => d.product_id === p.id))
      push({ kind: 'dimension', source_key: d.id, text: `${p.manufacturer} ${p.model}: ${d.name} = ${d.value} ${d.units}${d.tolerance ? ' (' + d.tolerance + ')' : ''}${d.endpoint_a ? ' from ' + d.endpoint_a + ' to ' + d.endpoint_b : ''}${d.orientation ? ', ' + d.orientation : ''}${d.configuration ? ', ' + d.configuration : ''}; source ${String(d.source_doc_sha256).slice(0, 12)} p.${d.source_page}` });
    for (const s of (p.sources ?? []).slice(0, 2)) {
      const pg = pages.get(`${s.doc_sha256}:${s.page_no}`);
      if (pg) push({ kind: 'page', source_key: `${s.doc_sha256}:${s.page_no}`, text: `${p.manufacturer} ${p.model} source ${String(s.doc_sha256).slice(0, 12)} p.${s.page_no}: ${String(pg.text).slice(0, 600)}` });
    }
  }
  for (const g of groups) push({ kind: 'lookalike_group', source_key: g.id, text: `LOOK-ALIKES (do not collapse; name a member only with a distinguishing marking or feature): ${(g.members ?? []).map((m: any) => m.manufacturer + ' ' + m.series_or_model).join(', ')}` });
  if (!facts.length) return { release_id: rel.id, version: rel.version, facts, prompt: '' };
  const prompt = `\n\nREFERENCE FACTS from OI reference release v${rel.version} (approved manufacturer documents). They are background, NOT evidence that the photographed item is any of these products. Identify only from what is visible. When a fact below supports a conclusion (for example a printed dimension or a marking format matches what you see), add its id to an extra top-level field "reference_citations": [<id>, ...]. Cite ONLY ids listed here; never invent ids. Use [] if none apply.\n` +
    facts.map(f => `[${f.id}] ${f.text}`).join('\n');
  return { release_id: rel.id, version: rel.version, facts, prompt };
}

/** Keeps only citations that were sent in this run's context; everything else is recorded as rejected. */
export function validateCitations(result: any, ctx: ReferenceContext | null) {
  const raw = Array.isArray(result?.reference_citations) ? result.reference_citations : [];
  const sent = new Map((ctx?.facts ?? []).map(f => [f.id, f]));
  const cited: { id: string; kind: string; source_key: string }[] = []; const rejected: string[] = []; const seen = new Set<string>();
  for (const x of raw) {
    const id = typeof x === 'string' ? x.trim() : '';
    if (!id || seen.has(id)) { if (!id) rejected.push(String(x).slice(0, 40)); continue; }
    seen.add(id);
    const f = sent.get(id); if (f) cited.push({ id, kind: f.kind, source_key: f.source_key }); else rejected.push(id.slice(0, 40));
  }
  return { cited, rejected };
}
