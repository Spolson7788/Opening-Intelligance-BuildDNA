import { acquireClient } from '../db/acquireClient';
import {downtimeSummary} from '../services/lifecycleRecords';
import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {enforceRolePermissions} from '../middleware/permissions';
import {installationFactSchema} from '../services/installationFacts';
import {canonicalPayloadHash,findSyncReceipt,writeSyncReceiptAndAudit} from '../services/syncProtocol';
export const lifecycleRouter=Router();
lifecycleRouter.use(requireAuth,enforceRolePermissions);
const uuid=z.string().uuid();
const command=z.object({operation_id:uuid,entity_id:uuid,opening_id:uuid,device_id:uuid,
 schema_version:z.literal(3),app_version:z.string().min(1).max(100),protocol_version:z.literal(1),
 expected_revision:z.number().int().positive().safe(),payload:installationFactSchema}).strict();
async function scope(c:any,id:string,org:string){return (await c.query(`SELECT o.* FROM openings o WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})`,[id,org])).rows[0];}
function targetOf(f:any){return f.frame_id?{type:'frame',id:f.frame_id}:f.door_leaf_id?{type:'door_leaf',id:f.door_leaf_id}:f.hardware_component_id?{type:'component',id:f.hardware_component_id}:{type:'opening',id:f.opening_id};}

lifecycleRouter.get('/:openingId',async(req:AuthedRequest,res)=>{
 if(!uuid.safeParse(req.params.openingId).success)return res.status(400).json({error:'invalid_opening'});
 const c = await acquireClient(res); if (!c) return;try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const o=await scope(c,req.params.openingId,req.auth!.organizationId);
  if(!o){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
  const frames=(await c.query('SELECT id FROM opening_frames WHERE opening_id=$1',[o.id])).rows;
  const leaves=(await c.query('SELECT id,leaf_role FROM door_leaves WHERE opening_id=$1',[o.id])).rows;
  const components=(await c.query('SELECT id,component_type,manufacturer,model_number,door_leaf_id,frame_id,mounting_scope,install_date::text,lifecycle_state,position_id,supersedes_component_id,revision,tracker_id,warranty_expiration::text FROM hardware_components WHERE opening_id=$1',[o.id])).rows;
  const facts=(await c.query(`SELECT f.*,NOT EXISTS(SELECT 1 FROM installation_facts n WHERE n.correction_of=f.id) AS is_current FROM installation_facts f WHERE opening_id=$1 ORDER BY recorded_at,id`,[o.id])).rows.map(f=>({...f,target:targetOf(f)}));
  const legacyOpening=(await c.query('SELECT install_date::text FROM openings WHERE id=$1',[o.id])).rows[0].install_date;
  // These are source values, never implicitly promoted to confirmed installation.
  const legacy=[...(legacyOpening?[{target:{type:'opening',id:o.id},date:legacyOpening,review_state:'unreviewed'}]:[]),...components.filter(v=>v.install_date).map(v=>({target:{type:'component',id:v.id},date:v.install_date,review_state:'unreviewed'}))];
  const records=(await c.query('SELECT r.*,NOT EXISTS(SELECT 1 FROM lifecycle_records n WHERE n.correction_of=r.id) AS is_current FROM lifecycle_records r WHERE opening_id=$1 ORDER BY recorded_at,id',[o.id])).rows;
  const replacements=(await c.query('SELECT * FROM component_replacements WHERE opening_id=$1 ORDER BY recorded_at,id',[o.id])).rows;
  const positions=(await c.query('SELECT * FROM component_positions WHERE opening_id=$1 ORDER BY position_key',[o.id])).rows;
  const services=(await c.query('SELECT * FROM service_events WHERE opening_id=$1 ORDER BY event_date,id',[o.id])).rows;
  await c.query('COMMIT');res.json({opening_id:o.id,opening_code:o.opening_code,status:o.status,revision:Number(o.revision),installation_facts:facts,legacy_installation_dates:legacy,frames,door_leaves:leaves,hardware_components:components,service_events:services,replacements,positions,records,downtime: downtimeSummary(records)});
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'lifecycle_unavailable'});}finally{c.release();}
});

lifecycleRouter.post('/installation-facts',async(req:AuthedRequest,res)=>{
 const parsed=command.safeParse(req.body);if(!parsed.success)return res.status(422).json({error:'invalid_installation_fact',details:parsed.error.flatten()});
 const b=parsed.data,p=b.payload,org=req.auth!.organizationId,actor=req.auth!.userId;
 const hash=canonicalPayloadHash({command:'installation_fact',entity_id:b.entity_id,opening_id:b.opening_id,expected_revision:b.expected_revision,payload:p});
 const c = await acquireClient(res); if (!c) return;try{
  await c.query('BEGIN');
  await c.query('SELECT id FROM openings WHERE id=$1 FOR UPDATE',[b.opening_id]);
  await c.query('SELECT p.id FROM properties p JOIN buildings b ON b.property_id=p.id JOIN openings o ON o.building_id=b.id WHERE o.id=$1 FOR SHARE OF p',[b.opening_id]);
  const o=await scope(c,b.opening_id,org);
  if(!o){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
  const prior=await findSyncReceipt(c,org,b.operation_id);
  if(prior){await c.query('ROLLBACK');return prior.actor_user_id!==actor||prior.payload_hash!==hash||prior.entity_id!==b.entity_id||prior.entity_type!=='installation_fact'?res.status(409).json({error:'idempotency_key_reused'}):res.json(prior);}
  if(o.status==='decommissioned'||Number(o.revision)!==b.expected_revision){await c.query('ROLLBACK');return res.status(409).json({error:o.status==='decommissioned'?'opening_retired':'revision_conflict'});}
  if(p.target.type==='opening'&&p.target.id!==b.opening_id){await c.query('ROLLBACK');return res.status(409).json({error:'target_not_in_opening'});}
  if(p.target.type!=='opening'){
   const table={frame:'opening_frames',door_leaf:'door_leaves',component:'hardware_components'}[p.target.type];
   if(!(await c.query(`SELECT id FROM ${table} WHERE id=$1 AND opening_id=$2 FOR SHARE`,[p.target.id,b.opening_id])).rows[0]){await c.query('ROLLBACK');return res.status(409).json({error:'target_not_in_opening'});}
  }
  if(p.correction_of){
   const old=(await c.query('SELECT * FROM installation_facts WHERE id=$1 AND opening_id=$2',[p.correction_of,b.opening_id])).rows[0];
   if(!old||JSON.stringify(targetOf(old))!==JSON.stringify(p.target)){await c.query('ROLLBACK');return res.status(409).json({error:'correction_target_mismatch'});}
   if((await c.query('SELECT 1 FROM installation_facts WHERE correction_of=$1',[p.correction_of])).rows[0]){await c.query('ROLLBACK');return res.status(409).json({error:'fact_already_corrected'});}
  }
  const f=(await c.query(`INSERT INTO installation_facts(id,opening_id,frame_id,door_leaf_id,hardware_component_id,certainty,precision,year,month,day,source_type,source_reference,note,recorded_by_user_id,recording_organization_id,correction_of,correction_reason)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[b.entity_id,b.opening_id,p.target.type==='frame'?p.target.id:null,p.target.type==='door_leaf'?p.target.id:null,p.target.type==='component'?p.target.id:null,p.date.certainty,p.date.precision,p.date.year,p.date.month,p.date.day,p.source_type,p.source_reference,p.note,actor,org,p.correction_of,p.correction_reason])).rows[0];
  const revision=Number((await c.query('UPDATE openings SET revision=revision+1 WHERE id=$1 RETURNING revision',[b.opening_id])).rows[0].revision);
  const receipt=await writeSyncReceiptAndAudit(c,{organizationId:org,openingId:b.opening_id,operationId:b.operation_id,operationType:'create',entityType:'installation_fact',entityId:b.entity_id,payloadHash:hash,baseServerRevision:b.expected_revision,resultingServerRevision:revision,actorUserId:actor,deviceId:b.device_id,schemaVersion:3,appVersion:b.app_version,protocolVersion:1,responsePayload:{...f,target:p.target},action:p.correction_of?'installation_corrected':'installation_recorded',changedFields:Object.keys(p)});
  await c.query('COMMIT');return res.status(201).json(receipt);
 }catch(e:any){await c.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'installation_identity_or_root_exists'});console.error(e);return res.status(500).json({error:'installation_unavailable'});}finally{c.release();}
});
