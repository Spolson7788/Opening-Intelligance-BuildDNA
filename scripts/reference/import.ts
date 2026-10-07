// Default is offline validation/dry-run. --apply is an explicit storage/DB mutation.
import {readFile,stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {pool} from '../../src/db/pool';
import {getPresignedUploadUrl,verifyPrivatePhotoRetrieval} from '../../src/services/storage';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function main(){
 const args=process.argv.slice(2),root=resolve(args[0]||''),corpus=resolve(args[1]||''),images=resolve(args[2]||'');
 if(args.length<3)throw Error('Usage: tsx scripts/reference/import.ts MANIFEST_DIR CORPUS_DIR PAGE_IMAGE_DIR [--apply]');
 const names=['reference_manifest.jsonl','reference_pages.jsonl','conflicts.jsonl','corpus_identity.json','audit_doc_manifest.csv'];
 const before=await Promise.all(names.map(n=>readFile(resolve(root,n))));
 execFileSync('python3',[resolve(__dirname,'validate_manifest.py'),root,'--corpus',corpus],{stdio:'inherit'});
 const after=await Promise.all(names.map(n=>readFile(resolve(root,n))));
 if(before.some((b,i)=>!b.equals(after[i])))throw Error('Manifest changed during validation');
 const parse=(b:Buffer)=>b.toString().trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
 const [docs,pages,conflicts]=before.slice(0,3).map(parse);
 if(!args.includes('--apply')&&!args.includes('--check-assets')){console.log(JSON.stringify({dry_run:true,manifest_validated:true,asset_upload_ready:false,documents:docs.length,pages:pages.length,approved:0}));return;}
 const existing=args.includes('--apply')?(await pool.query('SELECT sha256,metadata FROM reference_documents WHERE sha256=ANY($1::text[])',[docs.map(d=>d.sha256)])).rows:[];
 const existingHashes=new Set(existing.map(d=>d.sha256));
 for(const old of existing){if(!isDeepStrictEqual(old.metadata,docs.find(d=>d.sha256===old.sha256)))throw Error('Existing immutable document metadata differs; explicit revision review required');}
 // Validate every asset before any upload or row write. Never allow ../ paths.
 const assets:{key:string;contentType:string;path:string;sha256:string;size:number}[]=[];
 for(const d of docs){
  if(existingHashes.has(d.sha256))continue;
  const p=resolve(corpus,d.path);if(!p.startsWith(corpus+sep))throw Error('Unsafe PDF path');
  const bytes=await readFile(p);if(hash(bytes)!==d.sha256)throw Error('PDF checksum mismatch');
  assets.push({key:`reference/${d.manufacturer}/${d.sha256}/original.pdf`,contentType:'application/pdf',path:p,sha256:hash(bytes),size:bytes.length});
 }
 for(const p of pages){
  if(existingHashes.has(p.doc_sha256))continue;
  const local=resolve(images,p.doc_sha256,`p${String(p.page_no).padStart(3,'0')}.png`);
  const bytes=await readFile(local);if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid page PNG');
  p.image_sha256=hash(bytes);
  p.image_key=p.image_key.replace(/\.png$/,'.'+p.image_sha256+'.png');
  assets.push({key:p.image_key,contentType:'image/png',path:local,sha256:p.image_sha256,size:bytes.length});
 }
 if(!args.includes('--apply')){console.log(JSON.stringify({dry_run:true,manifest_validated:true,asset_upload_ready:true,documents:docs.length,pages:pages.length,assets:assets.length,approved:0}));return;}
 for(const a of assets){
  const bytes=await readFile(a.path);if(hash(bytes)!==a.sha256)throw Error('Asset changed after validation');
  const url=await getPresignedUploadUrl(a.key,a.contentType);
  const r=await fetch(url,{method:'PUT',headers:{'Content-Type':a.contentType},body:new Uint8Array(bytes)});
  if(!r.ok||!await verifyPrivatePhotoRetrieval(a.key,a.sha256,a.size))throw Error('Reference upload verification failed');
 }
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');
  const insertedHashes=new Set<string>();
  for(const d of docs){
   if(existingHashes.has(d.sha256))continue;
   // Idempotent same-hash import never rewrites approved metadata or approvals.
   const inserted=await c.query(`INSERT INTO reference_documents(sha256,manufacturer,brand,title,doc_type,page_count,storage_key,metadata,status,superseded_by,duplicate_of)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(sha256) DO NOTHING RETURNING sha256`,[d.sha256,d.manufacturer,d.brand,d.title,d.doc_type,d.page_count,`reference/${d.manufacturer}/${d.sha256}/original.pdf`,JSON.stringify(d),d.status,d.superseded_by,d.duplicate_of]);
   if(inserted.rows.length)insertedHashes.add(d.sha256);
  }
  for(const p of pages)if(insertedHashes.has(p.doc_sha256))await c.query(`INSERT INTO reference_pages(doc_sha256,page_no,text,text_sha256,page_class,transcription_status,citable,fraction_unverified,image_key,image_sha256)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[p.doc_sha256,p.page_no,p.text,p.text_sha256,p.page_class,p.transcription_status,p.citable,p.fraction_unverified,p.image_key,p.image_sha256]);
  for(const d of docs)if(insertedHashes.has(d.sha256))for(const m of d.models)await c.query(`INSERT INTO reference_document_models(doc_sha256,model,series,variant,evidence_page,evidence_quote) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[d.sha256,m.model,m.series,m.variant,m.evidence_page,m.evidence_quote]);
  for(const f of conflicts)if(insertedHashes.has(f.doc_sha256))await c.query('INSERT INTO reference_conflicts(doc_sha256,field,values) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[f.doc_sha256,f.field,JSON.stringify(f.values)]);
  // Supersession is an explicit reviewed relation, never a filename/date guess.
  for(const d of docs)if(d.status==='superseded')await c.query("UPDATE reference_documents SET status='superseded',superseded_by=$2 WHERE sha256=$1",[d.sha256,d.superseded_by]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 console.log(JSON.stringify({imported:docs.length,approved:0}));
}
main().catch(()=>{console.error('Reference import failed; no approvals made.');process.exitCode=1;}).finally(()=>pool.end());
