import {verifiedDocument} from '../services/commercialStorage';
import {canReadCommercialDocument} from './commercial';
import {Router} from 'express';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {pool} from '../db/pool';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {enforceRolePermissions} from '../middleware/permissions';
import {installationFactSchema} from '../services/installationFacts';
import {canonicalPayloadHash,findSyncReceipt,writeSyncReceiptAndAudit} from '../services/syncProtocol';
export const lifecycleOperationsRouter=Router();
lifecycleOperationsRouter.use(requireAuth,enforceRolePermissions);
const uuid=z.string().uuid();
const envelope=z.object({operation_id:uuid,entity_id:uuid,opening_id:uuid,device_id:uuid,schema_version:z.literal(3),app_version:z.string().min(1).max(100),protocol_version:z.literal(1),expected_revision:z.number().int().positive().safe()});
export class LifecycleConflict extends Error {constructor(public code:string,public status=409){super(code);}}
// All lifecycle writes share opening/property lock order, tenant authorization and replay binding.
export function registerLifecycleCommand(path:string,entityType:any,schema:z.ZodType<Record<string,unknown>>,apply:(c:any,b:any,actor:string,req:AuthedRequest)=>Promise<any>){
 lifecycleOperationsRouter.post(path,async(req:AuthedRequest,res)=>{
  const parsed=envelope.extend({payload:schema}).strict().safeParse(req.body);
  if(!parsed.success)return res.status(422).json({error:'invalid_lifecycle_record',details:parsed.error.flatten()});
  const b=parsed.data,org=req.auth!.organizationId,actor=req.auth!.userId,hash=canonicalPayloadHash({command:entityType,entity_id:b.entity_id,opening_id:b.opening_id,expected_revision:b.expected_revision,payload:b.payload});
  const c=await pool.connect();try{
   await c.query('BEGIN');
   await c.query('SELECT id FROM openings WHERE id=$1 FOR UPDATE',[b.opening_id]);
   await c.query('SELECT p.id FROM properties p JOIN buildings b ON b.property_id=p.id JOIN openings o ON o.building_id=b.id WHERE o.id=$1 FOR SHARE OF p',[b.opening_id]);
   const o=(await c.query(`SELECT * FROM openings WHERE id=$1 AND id IN (${openingsForOrgSubquery(2)})`,[b.opening_id,org])).rows[0];
   if(!o)throw new LifecycleConflict('not_found',404);
   const prior=await findSyncReceipt(c,org,b.operation_id);
   if(prior){if(prior.actor_user_id!==actor||prior.payload_hash!==hash||prior.entity_id!==b.entity_id||prior.entity_type!==entityType)throw new LifecycleConflict('idempotency_key_reused');await c.query('ROLLBACK');return res.json(prior);}
   if(o.status==='decommissioned')throw new LifecycleConflict('opening_retired');
   if(Number(o.revision)!==b.expected_revision)throw new LifecycleConflict('revision_conflict');
   const result=await apply(c,b,actor,req);
   const revision=Number((await c.query('UPDATE openings SET revision=revision+1 WHERE id=$1 RETURNING revision',[b.opening_id])).rows[0].revision);
   const receipt=await writeSyncReceiptAndAudit(c,{organizationId:org,openingId:b.opening_id,operationId:b.operation_id,operationType:'create',entityType,entityId:b.entity_id,payloadHash:hash,baseServerRevision:b.expected_revision,resultingServerRevision:revision,actorUserId:actor,deviceId:b.device_id,schemaVersion:3,appVersion:b.app_version,protocolVersion:1,responsePayload:result,action:entityType+'_recorded',changedFields:Object.keys(b.payload)});
   await c.query('COMMIT');res.status(201).json(receipt);
  }catch(e:any){await c.query('ROLLBACK');if(e instanceof LifecycleConflict)return res.status(e.status).json({error:e.code});if(e.code==='23505'||e.code==='23503')return res.status(409).json({error:'lifecycle_identity_conflict'});console.error(e);res.status(500).json({error:'lifecycle_unavailable'});}finally{c.release();}
 });
}
const replacement=z.object({predecessor_id:uuid,expected_component_revision:z.number().int().positive(),successor_id:uuid,position_key:z.string().trim().min(1).max(120),
 manufacturer:z.string().trim().max(200),model_number:z.string().trim().max(200),serial_number:z.string().trim().max(200),
 installation:installationFactSchema}).strict().refine(p=>p.installation.target.type==='component'&&p.installation.target.id===p.successor_id&&p.installation.correction_of===null);
registerLifecycleCommand('/replacements','replacement',replacement,async(c,b,actor)=>{
 const p=b.payload,old=(await c.query('SELECT * FROM hardware_components WHERE id=$1 AND opening_id=$2 FOR UPDATE',[p.predecessor_id,b.opening_id])).rows[0];
 if(!old)throw new LifecycleConflict('component_not_in_opening');
 if(old.lifecycle_state!=='active'||Number(old.revision)!==p.expected_component_revision)throw new LifecycleConflict('component_revision_or_retirement_conflict');
 if(p.successor_id===old.id)throw new LifecycleConflict('replacement_requires_new_identity');
 if((await c.query('SELECT 1 FROM hardware_components WHERE id=$1',[p.successor_id])).rows[0])throw new LifecycleConflict('successor_identity_exists');
 const key=p.position_key.toLowerCase();let position=old.position_id;
 if(position){const pos=(await c.query('SELECT * FROM component_positions WHERE id=$1',[position])).rows[0];if(pos.position_key!==key)throw new LifecycleConflict('position_key_mismatch');}
 else{
  const existing=(await c.query('SELECT id FROM component_positions WHERE opening_id=$1 AND mounting_scope=$2 AND frame_id IS NOT DISTINCT FROM $3::uuid AND door_leaf_id IS NOT DISTINCT FROM $4::uuid AND component_type=$5 AND position_key=$6',[b.opening_id,old.mounting_scope,old.frame_id,old.door_leaf_id,old.component_type,key])).rows[0];
  if(existing)throw new LifecycleConflict('position_already_assigned_review_required');
  position=randomUUID();await c.query('INSERT INTO component_positions(id,opening_id,mounting_scope,frame_id,door_leaf_id,component_type,position_key) VALUES($1,$2,$3,$4,$5,$6,$7)',[position,b.opening_id,old.mounting_scope,old.frame_id,old.door_leaf_id,old.component_type,key]);
 }
 await c.query("UPDATE hardware_components SET position_id=$2,lifecycle_state='retired',revision=revision+1 WHERE id=$1",[old.id,position]);
 const successor=(await c.query(`INSERT INTO hardware_components(id,opening_id,component_type,tracker_id,manufacturer,model_number,serial_number,mounting_scope,frame_id,door_leaf_id,position_label,position_id,supersedes_component_id,condition,review_state,identity_status)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'unverified','pending','unresolved') RETURNING *`,[p.successor_id,b.opening_id,old.component_type,'TRK-'+randomUUID(),p.manufacturer||null,p.model_number||null,p.serial_number||null,old.mounting_scope,old.frame_id,old.door_leaf_id,old.position_label,position,old.id])).rows[0];
 const i=p.installation,d=i.date;
 const fact=(await c.query(`INSERT INTO installation_facts(id,opening_id,hardware_component_id,certainty,precision,year,month,day,source_type,source_reference,note,recorded_by_user_id,recording_organization_id,correction_reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,(SELECT organization_id FROM users WHERE id=$12),'') RETURNING *`,[randomUUID(),b.opening_id,p.successor_id,d.certainty,d.precision,d.year,d.month,d.day,i.source_type,i.source_reference,i.note,actor])).rows[0];
 const event=(await c.query('INSERT INTO component_replacements(id,opening_id,position_id,predecessor_id,successor_id,evidence,recorded_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[b.entity_id,b.opening_id,position,old.id,p.successor_id,JSON.stringify(i),actor])).rows[0];
 return {...event,successor,installation_fact:fact};
});

import {downtimeSchema,warrantySchema} from '../services/lifecycleRecords';
for(const [kind,schema] of [['downtime',downtimeSchema],['warranty',warrantySchema]] as const){
 registerLifecycleCommand('/'+kind,kind,schema,async(c,b,actor,req)=>{
  const p=b.payload,ids=kind==='warranty'?[p.component_id]:p.component_ids;
  for(const id of ids)if(!(await c.query('SELECT id FROM hardware_components WHERE id=$1 AND opening_id=$2 FOR SHARE',[id,b.opening_id])).rows[0])throw new LifecycleConflict('component_not_in_opening');
  if(p.correction_of){
   const old=(await c.query('SELECT * FROM lifecycle_records WHERE id=$1 AND opening_id=$2 AND kind=$3',[p.correction_of,b.opening_id,kind])).rows[0];
   if(!old)throw new LifecycleConflict('correction_not_found');
   if(kind==='warranty'&&(old.payload.component_id!==p.component_id||old.payload.warranty_type!==p.warranty_type))throw new LifecycleConflict('warranty_identity_mismatch');
   if((await c.query('SELECT 1 FROM lifecycle_records WHERE correction_of=$1',[p.correction_of])).rows[0])throw new LifecycleConflict('record_already_corrected');
  }
  if(kind==='warranty'&&p.proof_document_version_id){
   if(!await canReadCommercialDocument(c,p.proof_document_version_id,req.auth!.organizationId))throw new LifecycleConflict('document_not_authorized');
   let d:any;try{d=await verifiedDocument(c,p.proof_document_version_id,req.app.locals.commercialStore);}catch{throw new LifecycleConflict('verified_private_warranty_document_required');}
   const facility=(await c.query('SELECT b.property_id FROM openings o JOIN buildings b ON b.id=o.building_id WHERE o.id=$1',[b.opening_id])).rows[0];
   if(d.kind!=='warranty'||d.property_id!==facility.property_id)throw new LifecycleConflict('warranty_document_scope_mismatch');
  }
  const record=(await c.query('INSERT INTO lifecycle_records(id,opening_id,kind,payload,correction_of,recorded_by_user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[b.entity_id,b.opening_id,kind,JSON.stringify(p),p.correction_of,actor])).rows[0];
  for(const id of ids)await c.query('INSERT INTO lifecycle_record_components(record_id,component_id,opening_id) VALUES($1,$2,$3)',[b.entity_id,id,b.opening_id]);
  if(kind==='warranty'&&p.proof_document_version_id)await c.query('INSERT INTO commercial_document_links(document_version_id,lifecycle_record_id) VALUES($1,$2)',[p.proof_document_version_id,b.entity_id]);
  return record;
 });
}
