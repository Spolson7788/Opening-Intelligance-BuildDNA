import {Router} from 'express';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {enforceRolePermissions} from '../middleware/permissions';
import {facilityAccessPredicate} from '../db/tenantScope';
import {canonicalPayloadHash} from '../services/syncProtocol';
import {documentHash,verifiedDocument} from '../services/commercialStorage';
import {money,laborSchema,estimateTotals} from '../services/estimateMath';
import {purchasingReview} from '../services/purchasingReview';
export const commercialRouter=Router();commercialRouter.use(requireAuth,enforceRolePermissions);
const uuid=z.string().uuid(),revision=z.number().int().min(0),currency=z.string().regex(/^[A-Z]{3}$/),precision=z.number().int().min(0).max(3);
const versionCommand={id:uuid,version_id:uuid,expected_version:revision};
class Conflict extends Error {constructor(public code:string,public status=409){super(code);}}
function endpoint(method:'get'|'post',path:string,fn:(c:any,req:AuthedRequest)=>Promise<any>){
 commercialRouter[method](path,async(req:AuthedRequest,res)=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c,req);await c.query('COMMIT');res.set('Cache-Control','no-store').json(result);}catch(e:any){await c.query('ROLLBACK');if(e instanceof z.ZodError)return res.status(422).json({error:'invalid_commercial_record',details:e.flatten()});if(e instanceof Conflict)return res.status(e.status).json({error:e.code});if(['23505','23503','22P02'].includes(e.code))return res.status(409).json({error:'commercial_identity_conflict'});if(/^(verified_private_document_required|document_object_unavailable|document_integrity_failed|labor_fractional_minor_unit_use_fixed_price|amount_out_of_range)$/.test(e.message))return res.status(409).json({error:e.message});console.error(e);res.status(500).json({error:'commercial_unavailable'});}finally{c.release();}});
}
async function facility(c:any,opening:string,org:string){
 uuid.parse(opening);await c.query('SELECT id FROM openings WHERE id=$1 FOR SHARE',[opening]);
 await c.query('SELECT p.id FROM properties p JOIN buildings b ON b.property_id=p.id JOIN openings o ON o.building_id=b.id WHERE o.id=$1 FOR SHARE OF p',[opening]);
 const row=(await c.query(`SELECT o.*,p.id AS property_id,pf.organization_id AS owner_id FROM openings o JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id JOIN portfolios pf ON pf.id=p.portfolio_id WHERE o.id=$1 AND ${facilityAccessPredicate(2)}`,[opening,org])).rows[0];
 if(!row)throw new Conflict('not_found',404);return row;
}
async function property(c:any,id:string,org:string){
 await c.query('SELECT id FROM properties WHERE id=$1 FOR SHARE',[id]);
 const row=(await c.query(`SELECT p.id,pf.organization_id AS owner_id FROM properties p JOIN portfolios pf ON pf.id=p.portfolio_id WHERE p.id=$1 AND ${facilityAccessPredicate(2)}`,[id,org])).rows[0];if(!row)throw new Conflict('not_found',404);return row;
}
async function replay(c:any,table:string,id:string,hash:string,actor:string){const old=(await c.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];if(old&&(old.request_hash!==hash||old.recorded_by!==actor))throw new Conflict('version_id_reused');return old;}
const documentSchema=z.object({...versionCommand,property_id:uuid.nullable(),title:z.string().trim().min(1).max(200),kind:z.enum(['technical','cut_sheet','installation','warranty','estimate']),pdf_base64:z.string().min(1).max(4_000_000)}).strict();
endpoint('post','/documents',async(c,req)=>{
 const b=documentSchema.parse(req.body),a=req.auth!,store=req.app.locals.commercialStore;
 if(!store?.privateImmutable)throw new Conflict('private_immutable_storage_not_configured',503);
 if(b.property_id)await property(c,b.property_id,a.organizationId);
 const bytes=Buffer.from(b.pdf_base64,'base64');if(!bytes.length||bytes.length>2_000_000||bytes.subarray(0,5).toString()!=='%PDF-'||bytes.toString('base64')!==b.pdf_base64)throw new Conflict('invalid_pdf',422);
 const hash=canonicalPayloadHash({...b,pdf_base64:documentHash(bytes)});
 await c.query('INSERT INTO commercial_documents(id,organization_id,property_id,title,kind) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[b.id,a.organizationId,b.property_id,b.title,b.kind]);
 const d=(await c.query('SELECT * FROM commercial_documents WHERE id=$1 FOR UPDATE',[b.id])).rows[0];
 if(d.organization_id!==a.organizationId)throw new Conflict('not_found',404);
 if(d.property_id!==b.property_id||d.title!==b.title||d.kind!==b.kind)throw new Conflict('document_identity_mismatch');
 const old=await replay(c,'commercial_document_versions',b.version_id,hash,a.userId);if(old)return publicDoc(old);
 if(d.head_version!==b.expected_version)throw new Conflict('version_conflict');
 const key=randomUUID();await store.putOnce(key,bytes);const stored=await store.read(key);
 if(documentHash(stored)!==documentHash(bytes))throw new Conflict('document_integrity_failed');
 const row=(await c.query(`INSERT INTO commercial_document_versions(id,document_id,version,object_key,sha256,byte_size,content_type,recorded_by,request_hash) VALUES($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8) RETURNING *`,[b.version_id,b.id,d.head_version+1,key,documentHash(stored),stored.length,a.userId,hash])).rows[0];
 await c.query('UPDATE commercial_documents SET head_version=head_version+1 WHERE id=$1',[b.id]);return publicDoc(row);
});
function publicDoc(d:any){const {object_key,request_hash,bytes,...safe}=d;return safe;}
export async function canReadCommercialDocument(c:any,id:string,org:string){
 const d=(await c.query('SELECT d.* FROM commercial_documents d JOIN commercial_document_versions v ON v.document_id=d.id WHERE v.id=$1',[id])).rows[0];if(!d)return false;
 if(d.property_id){const p=await property(c,d.property_id,org);return org===d.organization_id||org===p.owner_id;}
 if(d.organization_id===org)return true;
 return !!(await c.query(`SELECT 1 FROM commercial_document_links l JOIN replacement_estimate_versions v ON v.id=l.estimate_version_id JOIN replacement_estimates e ON e.id=v.estimate_id JOIN openings o ON o.id=e.opening_id JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id JOIN portfolios pf ON pf.id=p.portfolio_id WHERE l.document_version_id=$1 AND pf.organization_id=$2`,[id,org])).rows[0];
}
endpoint('get','/documents/:id',async(c,req)=>{const id=uuid.parse(req.params.id);if(!await canReadCommercialDocument(c,id,req.auth!.organizationId))throw new Conflict('not_found',404);const d=await verifiedDocument(c,id,req.app.locals.commercialStore);return {...publicDoc(d),pdf_base64:d.bytes.toString('base64')};});
const catalogSchema=z.object({...versionCommand,sku:z.string().trim().min(1).max(120),description:z.string().trim().min(1).max(2000),manufacturer:z.string().trim().min(1).max(200),model:z.string().trim().min(1).max(200),component_type:z.string().trim().min(1).max(100),currency,minor_unit_digits:precision,unit_price_minor:money.nullable(),document_version_ids:z.array(uuid).min(1).max(20)}).strict();
endpoint('post','/catalog',async(c,req)=>{
 const b=catalogSchema.parse(req.body),a=req.auth!,hash=canonicalPayloadHash(b);
 await c.query('INSERT INTO provider_catalog_items(id,provider_id,sku) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[b.id,a.organizationId,b.sku]);
 const item=(await c.query('SELECT * FROM provider_catalog_items WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(item.provider_id!==a.organizationId)throw new Conflict('not_found',404);if(item.sku!==b.sku)throw new Conflict('sku_identity_mismatch');
 const prior=await replay(c,'provider_catalog_versions',b.version_id,hash,a.userId);if(prior)return prior;
 if(item.head_version!==b.expected_version)throw new Conflict('version_conflict');
 for(const id of b.document_version_ids){const d=await verifiedDocument(c,id,req.app.locals.commercialStore);if(d.organization_id!==a.organizationId||d.property_id!==null||!['technical','cut_sheet','installation'].includes(d.kind))throw new Conflict('provider_catalog_document_required');}
 const row=(await c.query('INSERT INTO provider_catalog_versions(id,item_id,version,payload,recorded_by,request_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[b.version_id,b.id,item.head_version+1,JSON.stringify(b),a.userId,hash])).rows[0];await c.query('UPDATE provider_catalog_items SET head_version=head_version+1 WHERE id=$1',[b.id]);return row;
});
const estimateSchema=z.object({...versionCommand,opening_id:uuid,currency,minor_unit_digits:precision,expires_at:z.string().datetime({offset:true}),parts:z.array(z.object({component_id:uuid,catalog_version_id:uuid,quantity:z.number().int().min(1).max(10000)}).strict()).min(1).max(100),labor:laborSchema,tax_minor:money.nullable(),fees_minor:money.nullable(),tax_note:z.string().trim().max(2000),fees_note:z.string().trim().max(2000),note:z.string().trim().max(4000)}).strict();
endpoint('post','/estimates',async(c,req)=>{
 const b=estimateSchema.parse(req.body),a=req.auth!,scope=await facility(c,b.opening_id,a.organizationId);if(scope.status==='decommissioned')throw new Conflict('opening_retired');
 await c.query('INSERT INTO replacement_estimates(id,provider_id,opening_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[b.id,a.organizationId,b.opening_id]);
 const e=(await c.query('SELECT * FROM replacement_estimates WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(e.provider_id!==a.organizationId||e.opening_id!==b.opening_id)throw new Conflict('not_found',404);
 const hash=canonicalPayloadHash(b),prior=await replay(c,'replacement_estimate_versions',b.version_id,hash,a.userId);if(prior)return prior;if(e.head_version!==b.expected_version)throw new Conflict('version_conflict');
 if(new Set(b.parts.map(p=>p.component_id)).size!==b.parts.length)throw new Conflict('duplicate_component_line');
 const parts=[],documents=new Set<string>();
 for(const p of b.parts){
  const component=(await c.query("SELECT id,component_type,door_leaf_id,frame_id FROM hardware_components WHERE id=$1 AND opening_id=$2 AND lifecycle_state='active'",[p.component_id,b.opening_id])).rows[0];if(!component)throw new Conflict('component_not_current');
  const v=(await c.query('SELECT v.*,i.provider_id,i.sku FROM provider_catalog_versions v JOIN provider_catalog_items i ON i.id=v.item_id WHERE v.id=$1 AND i.provider_id=$2',[p.catalog_version_id,a.organizationId])).rows[0];if(!v)throw new Conflict('catalog_version_not_owned');
  const catalog=v.payload;if(catalog.currency!==b.currency||catalog.minor_unit_digits!==b.minor_unit_digits)throw new Conflict('currency_or_precision_mismatch');if(catalog.component_type!==component.component_type)throw new Conflict('component_type_mismatch');
  for(const id of catalog.document_version_ids){const d=await verifiedDocument(c,id,req.app.locals.commercialStore);if(d.organization_id!==a.organizationId)throw new Conflict('document_provider_mismatch');documents.add(id);}
  parts.push({...p,component,catalog_version:v.version,sku:v.sku,catalog,unit_price_minor:catalog.unit_price_minor});
 }
 const snapshot={...b,provider_id:a.organizationId,parts,totals:estimateTotals(parts,b.labor,b.tax_minor,b.fees_minor),document_version_ids:[...documents],opening_revision:Number(scope.revision),review_only:true};
 const row=(await c.query('INSERT INTO replacement_estimate_versions(id,estimate_id,version,snapshot,recorded_by,request_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[b.version_id,b.id,e.head_version+1,JSON.stringify(snapshot),a.userId,hash])).rows[0];
 for(const id of documents)await c.query('INSERT INTO commercial_document_links(document_version_id,estimate_version_id) VALUES($1,$2)',[id,b.version_id]);
 await c.query('UPDATE replacement_estimates SET head_version=head_version+1 WHERE id=$1',[b.id]);return row;
});
endpoint('get','/context/:openingId',async(c,req)=>{
 const a=req.auth!,o=await facility(c,req.params.openingId,a.organizationId),owner=o.owner_id===a.organizationId;
 const catalog=(await c.query(`SELECT v.*,i.provider_id,i.sku,i.head_version FROM provider_catalog_versions v JOIN provider_catalog_items i ON i.id=v.item_id WHERE i.provider_id=$1 OR ($2::boolean AND EXISTS(SELECT 1 FROM facility_provider_assignments f WHERE f.property_id=$3 AND f.provider_organization_id=i.provider_id AND f.revoked_at IS NULL)) ORDER BY i.sku,v.version DESC`,[a.organizationId,owner,o.property_id])).rows;
 const estimates=(await c.query('SELECT v.*,e.provider_id,e.head_version FROM replacement_estimate_versions v JOIN replacement_estimates e ON e.id=v.estimate_id WHERE e.opening_id=$1 AND ($2::boolean OR e.provider_id=$3) ORDER BY v.recorded_at DESC',[o.id,owner,a.organizationId])).rows;
 const reviews=(await c.query('SELECT r.* FROM estimate_reviews r JOIN replacement_estimate_versions v ON v.id=r.estimate_version_id JOIN replacement_estimates e ON e.id=v.estimate_id WHERE e.opening_id=$1 AND ($2::boolean OR e.provider_id=$3)',[o.id,owner,a.organizationId])).rows;
 const documents=(await c.query('SELECT v.id,v.document_id,v.version,v.sha256,v.byte_size,d.title,d.kind,d.property_id,d.head_version FROM commercial_document_versions v JOIN commercial_documents d ON d.id=v.document_id WHERE d.organization_id=$1 AND (d.property_id IS NULL OR d.property_id=$2)',[a.organizationId,o.property_id])).rows;
 return {opening_id:o.id,opening_code:o.opening_code,property_id:o.property_id,owner,storage_available:!!req.app.locals.commercialStore?.privateImmutable,storage_mode:req.app.locals.commercialStore?.mode||'unconfigured',documents,catalog,estimates:estimates.map((e:any)=>({...e,stale:Date.parse(e.snapshot.expires_at)<=Date.now(),superseded:e.version!==e.head_version,review_recorded:reviews.some((r:any)=>r.estimate_version_id===e.id),review_requires_revalidation:true})),reviews,components:(await c.query("SELECT id,component_type,manufacturer,model_number,door_leaf_id FROM hardware_components WHERE opening_id=$1 AND lifecycle_state='active'",[o.id])).rows};
});
endpoint('post','/estimates/:id/review',async(c,req)=>{
 const b=z.object({operation_id:uuid,note:z.string().trim().min(1).max(2000)}).strict().parse(req.body),a=req.auth!;
 const e=(await c.query('SELECT v.*,e.opening_id,e.provider_id,e.head_version FROM replacement_estimate_versions v JOIN replacement_estimates e ON e.id=v.estimate_id WHERE v.id=$1',[uuid.parse(req.params.id)])).rows[0];if(!e)throw new Conflict('not_found',404);
 const o=await facility(c,e.opening_id,a.organizationId);if(o.owner_id!==a.organizationId||a.role!=='admin')throw new Conflict('owner_admin_review_required',403);
 // Lock order is opening -> property -> estimate, same as creation.
 const head=(await c.query('SELECT head_version FROM replacement_estimates WHERE id=$1 FOR UPDATE',[e.estimate_id])).rows[0];
 const hash=canonicalPayloadHash({estimate_version_id:e.id,note:b.note}),prior=(await c.query('SELECT * FROM estimate_reviews WHERE id=$1',[b.operation_id])).rows[0];
 if(prior){if(prior.reviewed_by!==a.userId||prior.estimate_version_id!==e.id||prior.request_hash!==hash)throw new Conflict('review_operation_reused');return {...prior,review_only:true,nothing_ordered_or_sent:true};}
 if(head.head_version!==e.version)throw new Conflict('estimate_superseded');if(Date.parse(e.snapshot.expires_at)<=Date.now())throw new Conflict('estimate_expired');if(e.snapshot.totals.missing.length)throw new Conflict('estimate_missing_price');
 if(e.provider_id!==o.owner_id&&!(await c.query('SELECT 1 FROM facility_provider_assignments WHERE property_id=$1 AND provider_organization_id=$2 AND revoked_at IS NULL',[o.property_id,e.provider_id])).rows[0])throw new Conflict('provider_assignment_revoked');
 await c.query("SELECT id FROM hardware_components WHERE opening_id=$1 AND lifecycle_state='active' ORDER BY id FOR SHARE",[o.id]);
 await c.query('SELECT id FROM opening_frames WHERE opening_id=$1 ORDER BY id FOR SHARE',[o.id]);
 await c.query('SELECT id FROM door_leaves WHERE opening_id=$1 ORDER BY id FOR SHARE',[o.id]);
 const gate=await purchasingReview(c,a.organizationId,[o.id]);if(!gate||gate.blocked||!gate.openings[0].opening_complete||o.status==='decommissioned')throw new Conflict('whole_opening_review_required');
 for(const line of e.snapshot.parts){const h=(await c.query("SELECT * FROM hardware_components WHERE id=$1 AND opening_id=$2 AND lifecycle_state='active'",[line.component_id,o.id])).rows[0];if(!h||!h.replacement_required||!['worn','failed'].includes(h.condition)||h.review_state!=='reviewed'||h.identity_status!=='established')throw new Conflict('component_review_required');}
 for(const id of e.snapshot.document_version_ids)await verifiedDocument(c,id,req.app.locals.commercialStore);
 const review=(await c.query('INSERT INTO estimate_reviews(id,estimate_version_id,reviewed_by,opening_revision,note,request_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[b.operation_id,e.id,a.userId,o.revision,b.note,hash])).rows[0];return {...review,review_only:true,nothing_ordered_or_sent:true};
});
