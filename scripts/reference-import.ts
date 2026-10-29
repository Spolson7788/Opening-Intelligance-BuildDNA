// Reference library import CLI. DRY-RUN BY DEFAULT: parses the PC manifests and prints counts only.
//   npx tsx scripts/reference-import.ts --dir <folder with the manifest CSVs> [--apply --database-url postgres://localhost/...]
// --apply writes draft rows to a LOCAL database only (localhost/127.0.0.1); any other host, and the
// fadihkhdwpfffpelqjtg / production projects, are refused. Nothing is approved; LCN Part A is interim-only.
// Copy from the opening-intelligence-staging library (one-time, separately approved):
//   npx tsx scripts/reference-import.ts --copy-from <source url> --database-url <local url> [--apply]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { emptyPlan, planRegistry, planAssetManifest, planVdDimensions, planHardNegatives, planCounts, applyPlan, copyFromLibrary,
  assertLocalTarget, assertAllowedSource } from '../src/services/referenceImport';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const apply = process.argv.includes('--apply');
const FILES = { registry: 'registry_v17.csv', vdCombined: 'vd_combined_manifest.csv', vdDims: 'vd_dimension_manifest.csv',
  lcn: 'lcn_asset_manifest.csv', hnSets: 'hn_CS__COMPARISON_SET_DEFINITIONS.csv', hnMembers: 'hn_CF__SET_MEMBERS.csv', hnPairs: 'hn_CF__CONFUSER_ROWS_SEED.csv' };

export function planFromDir(dir: string) {
  const r = (f: string) => { const p = join(dir, f); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  const plan = emptyPlan();
  const reg = r(FILES.registry); if (reg) planRegistry(plan, reg);
  const vdc = r(FILES.vdCombined); if (vdc) planAssetManifest(plan, vdc, { pkg: 'VD_Complete_Image_Packages_B001_013', manufacturer: 'Von Duprin' });
  const vdd = r(FILES.vdDims); if (vdd) planVdDimensions(plan, vdd);
  const lcn = r(FILES.lcn); if (lcn) planAssetManifest(plan, lcn, { pkg: 'OI_Interim_Imagery_Handoff_2026-09-04_PART_A_LCN', manufacturer: 'LCN', interim: true });
  const s = r(FILES.hnSets), m = r(FILES.hnMembers), p = r(FILES.hnPairs); if (s && m && p) planHardNegatives(plan, { sets: s, members: m, pairs: p });
  return plan;
}

async function main() {
  const url = arg('--database-url'); const from = arg('--copy-from');
  if ((apply || from) && !url) throw new Error('--database-url (local) required');
  if (url) assertLocalTarget(url);
  const pg = await import('pg');
  if (from) {
    assertAllowedSource(from);
    const src = new pg.default.Pool({ connectionString: from, max: 1 }); const dst = new pg.default.Pool({ connectionString: url, max: 1 });
    await src.query('SET default_transaction_read_only = on');
    if (!apply) { const n = (await src.query('SELECT count(*)::int n FROM reference_documents')).rows[0].n; console.log(JSON.stringify({ dry_run: true, source_documents: n })); }
    else console.log(JSON.stringify(await copyFromLibrary(src, dst, { sourceRef: new URL(from).hostname })));
    await src.end(); await dst.end(); return;
  }
  const dir = arg('--dir'); if (!dir) throw new Error('--dir required');
  const plan = planFromDir(dir);
  console.log(JSON.stringify({ dry_run: !apply, plan: planCounts(plan) }, null, 2));
  if (apply) { const db = new pg.default.Pool({ connectionString: url, max: 1 }); console.log(JSON.stringify({ inserted: await applyPlan(db, plan) })); await db.end(); }
}
if (process.argv[1] && /reference-import/.test(process.argv[1])) main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
