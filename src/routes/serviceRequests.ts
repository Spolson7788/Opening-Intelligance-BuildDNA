import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { openingsForOrgSubquery } from '../db/tenantScope';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { enforceRolePermissions } from '../middleware/permissions';
import { canonicalPayloadHash, findSyncReceipt, writeSyncReceiptAndAudit } from '../services/syncProtocol';

export const serviceRequestsRouter=Router();
serviceRequestsRouter.use(requireAuth,enforceRolePermissions);
const target=z.object({type:z.enum(['frame','door_leaf','component']),id:z.string().uuid()}).strict();
const payload=z.object({symptom:z.string().trim().min(1).max(4000),impact:z.string().trim().max(2000),
  priority:z.enum(['low','normal','high','urgent']),provider_organization_id:z.string().uuid(),
  uncertain_target:z.boolean(),targets:z.array(target).max(100),photo_ids:z.array(z.string().uuid()).max(30)
}).strict().refine(b=>b.uncertain_target?b.targets.length===0:b.targets.length>0)
 .refine(b=>new Set(b.targets.map(t=>`${t.type}:${t.id}`)).size===b.targets.length && new Set(b.photo_ids).size===b.photo_ids.length);
const command=z.object({operation_id:z.string().uuid(),entity_id:z.string().uuid(),opening_id:z.string().uuid(),
  device_id:z.string().uuid(),schema_version:z.number().int().min(1).max(3),app_version:z.string().min(1).max(100),
  protocol_version:z.literal(1),payload}).strict();
async function scope(client:any,id:string,org:string,lock=false){
  return (await client.query(`SELECT o.*,b.property_id,pf.organization_id AS owner_organization_id
    FROM openings o JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id
    JOIN portfolios pf ON pf.id=p.portfolio_id WHERE o.id=$1 AND o.id IN (${openingsForOrgSubquery(2)})
    ${lock?'FOR SHARE OF o,p':''}`,[id,org])).rows[0];
}

serviceRequestsRouter.get('/context/:openingId',async(req:AuthedRequest,res)=>{
  if(!z.string().uuid().safeParse(req.params.openingId).success)return res.status(400).json({error:'invalid_opening'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const opening=await scope(client,req.params.openingId,req.auth!.organizationId);
    if(!opening){await client.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
    const providers=(await client.query(`SELECT org.id,org.name FROM facility_provider_assignments a JOIN organizations org ON org.id=a.provider_organization_id
      WHERE a.property_id=$1 AND a.revoked_at IS NULL ORDER BY org.name`,[opening.property_id])).rows;
    const frame=(await client.query('SELECT id FROM opening_frames WHERE opening_id=$1',[opening.id])).rows[0]??null;
    const leaves=(await client.query('SELECT id,leaf_role FROM door_leaves WHERE opening_id=$1',[opening.id])).rows;
    const components=(await client.query('SELECT id,component_type,manufacturer,model_number,door_leaf_id,frame_id,mounting_scope FROM current_hardware_components WHERE opening_id=$1',[opening.id])).rows;
    const photos=(await client.query("SELECT id,related_entity_type,related_entity_id FROM photos WHERE opening_id=$1 AND upload_state='verified'",[opening.id])).rows;
    const requests=(await client.query(`SELECT id,symptom,priority,status,notification_status,created_at FROM service_requests
      WHERE opening_id=$1 AND ($2::uuid=$3::uuid OR requesting_organization_id=$2::uuid OR provider_organization_id=$2::uuid) ORDER BY created_at DESC`,
      [opening.id,req.auth!.organizationId,opening.owner_organization_id])).rows;
    await client.query('COMMIT');return res.json({opening_id:opening.id,opening_code:opening.opening_code,status:opening.status,providers,frame,door_leaves:leaves,hardware_components:components,photos,requests});
  }catch(err){await client.query('ROLLBACK');console.error(err);return res.status(500).json({error:'request_context_unavailable'});}
  finally{client.release();}
});

serviceRequestsRouter.post('/',async(req:AuthedRequest,res)=>{
  const parsed=command.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'invalid_service_request'});
  const b=parsed.data,p=b.payload,org=req.auth!.organizationId,actor=req.auth!.userId;
  const hash=canonicalPayloadHash({command:'service_request',opening_id:b.opening_id,entity_id:b.entity_id,payload:p});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // All request submissions lock the opening before checking the receipt.
    // Same-opening retries therefore serialize; unique receipts also reject cross-opening reuse.
    await client.query('SELECT id FROM openings WHERE id=$1 FOR UPDATE',[b.opening_id]);
    // Revocation takes the same property lock. Authorize in a subsequent statement
    // so a request that waited for revocation uses its committed assignment state.
    await client.query('SELECT p.id FROM properties p JOIN buildings b ON b.property_id=p.id JOIN openings o ON o.building_id=b.id WHERE o.id=$1 FOR SHARE OF p',[b.opening_id]);
    const opening=await scope(client,b.opening_id,org,true);
    if(!opening){await client.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
    const assignment=(await client.query(`SELECT 1 FROM facility_provider_assignments WHERE property_id=$1
      AND provider_organization_id=$2 AND revoked_at IS NULL FOR SHARE`,[opening.property_id,p.provider_organization_id])).rows[0];
    if(!assignment){await client.query('ROLLBACK');return res.status(403).json({error:'provider_assignment_revoked_or_missing'});}
    // Scope and provider assignment are checked even when replaying a prior receipt.
    const prior=await findSyncReceipt(client,org,b.operation_id);
    if(prior){await client.query('ROLLBACK');if(prior.actor_user_id!==actor||prior.payload_hash!==hash||prior.entity_id!==b.entity_id||prior.entity_type!=='service_request')return res.status(409).json({error:'idempotency_key_reused'});return res.json(prior);}
    if(opening.status==='decommissioned'){await client.query('ROLLBACK');return res.status(409).json({error:'opening_retired'});}
    for(const t of p.targets){
      const table={frame:'opening_frames',door_leaf:'door_leaves',component:'hardware_components'}[t.type];
      const activeComponent=t.type==='component'?" AND lifecycle_state='active'":'';
      if(!(await client.query(`SELECT id FROM ${table} WHERE id=$1 AND opening_id=$2${activeComponent} FOR SHARE`,[t.id,b.opening_id])).rows[0]){
        await client.query('ROLLBACK');return res.status(409).json({error:'target_not_in_opening'});
      }
    }
    for(const id of p.photo_ids){
      const photo=(await client.query("SELECT related_entity_type,related_entity_id FROM photos WHERE id=$1 AND opening_id=$2 AND upload_state='verified' FOR SHARE",[id,b.opening_id])).rows[0];
      const matching=photo&&(photo.related_entity_type==='opening'||p.targets.some(t=>photo.related_entity_type===(t.type==='component'?'hardware_component':t.type)&&photo.related_entity_id===t.id));
      if(!matching){await client.query('ROLLBACK');return res.status(409).json({error:'photo_not_verified_for_request_target'});}
    }
    const record=(await client.query(`INSERT INTO service_requests(id,opening_id,requesting_organization_id,created_by_user_id,provider_organization_id,symptom,impact,priority,uncertain_target)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[b.entity_id,b.opening_id,org,actor,p.provider_organization_id,p.symptom,p.impact,p.priority,p.uncertain_target])).rows[0];
    for(const t of p.targets)await client.query(`INSERT INTO service_request_targets(request_id,opening_id,frame_id,door_leaf_id,hardware_component_id) VALUES($1,$2,$3,$4,$5)`,
      [b.entity_id,b.opening_id,t.type==='frame'?t.id:null,t.type==='door_leaf'?t.id:null,t.type==='component'?t.id:null]);
    for(const id of p.photo_ids)await client.query('INSERT INTO service_request_photos(request_id,opening_id,photo_id) VALUES($1,$2,$3)',[b.entity_id,b.opening_id,id]);
    const receipt=await writeSyncReceiptAndAudit(client,{organizationId:org,openingId:b.opening_id,operationId:b.operation_id,operationType:'create',entityType:'service_request',entityId:b.entity_id,
      payloadHash:hash,baseServerRevision:null,resultingServerRevision:1,actorUserId:actor,deviceId:b.device_id,schemaVersion:b.schema_version,appVersion:b.app_version,protocolVersion:1,
      responsePayload:{...record,targets:p.targets,photo_ids:p.photo_ids},action:'service_request_submitted',changedFields:Object.keys(p)});
    await client.query('COMMIT');return res.status(201).json(receipt);
  }catch(err:any){await client.query('ROLLBACK');if(err.code==='23505')return res.status(409).json({error:'request_identity_already_used'});console.error(err);return res.status(500).json({error:'request_unavailable'});}
  finally{client.release();}
});
