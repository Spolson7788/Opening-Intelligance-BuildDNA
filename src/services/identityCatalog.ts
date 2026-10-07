import {pool} from '../db/pool';
import pdq from './pdqCatalog.json';
import reviewed from './reviewedExitCatalog.json';
const entries=[...pdq,...reviewed];
import type {IdentityCatalogEntry} from './catalogIdentityReview';
// One resolver uses reviewed static rows and approved/citable document rows.
// Missing series, class or form remains unknown; never infer it from a prefix.
export async function loadIdentityCatalog():Promise<{entries:IdentityCatalogEntry[];availability:'available'|'partial';reason?:string}>{
 try{
  const rows=(await pool.query(`SELECT DISTINCT d.brand AS manufacturer,m.model,m.series,d.metadata->>'component_class' AS component_class,d.metadata->>'device_type' AS device_type,d.metadata->>'display_name' AS display_name,d.metadata->>'source_url' AS source_url,m.evidence_page AS page,d.sha256 AS source_sha256
   FROM reference_document_models m JOIN reference_documents d ON d.sha256=m.doc_sha256
   JOIN reference_pages p ON p.doc_sha256=m.doc_sha256 AND p.page_no=m.evidence_page
   WHERE d.status='approved' AND p.citable AND NOT p.fraction_unverified
   ORDER BY d.brand,m.model,m.series LIMIT 501`)).rows;
  if(rows.length>500)return {entries,availability:'partial',reason:'reference_catalog_limit'};
  const unique=new Map<string,IdentityCatalogEntry>();
  for(const row of [...entries,...rows])unique.set(`${row.manufacturer.toUpperCase()}|${row.model.toUpperCase()}`,{...row,display_name:row.display_name||'hardware'});
  return {entries:[...unique.values()],availability:'available'};
 }catch{return {entries,availability:'partial',reason:'reference_catalog_unavailable'};}
}
