import { acquireClient } from '../db/acquireClient';
import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,AuthedRequest} from '../middleware/auth';
import {enforceRolePermissions} from '../middleware/permissions';
import {canonicalPayloadHash} from '../services/syncProtocol';
import {conditionCohorts,PROCUREMENT_GAPS} from '../services/planningProjection';
import {downtimeSummary} from '../services/lifecycleRecords';
import {requireCustomerOffice} from '../middleware/facilityOffice';
export const planningRouter=Router();planningRouter.use(requireAuth,enforceRolePermissions,requireCustomerOffice);
const uuid=z.string().uuid();
class DomainError extends Error {constructor(public code:string,public status=409){super(code);}}
function endpoint(method:'get'|'post',path:string,fn:(c:any,r:AuthedRequest)=>Promise<any>){planningRouter[method](path,async(req:AuthedRequest,res)=>{
 const c = await acquireClient(res); if (!c) return;try{await c.query('BEGIN');const data=await fn(c,req);await c.query('COMMIT');res.set('Cache-Control','no-store').json(data);}catch(e:any){await c.query('ROLLBACK');if(e instanceof z.ZodError)return res.status(422).json({error:'invalid_planning_record'});if(e instanceof DomainError)return res.status(e.status).json({error:e.code});if(['23505','23503'].includes(e.code))return res.status(409).json({error:'planning_identity_conflict'});console.error(e);res.status(500).json({error:'planning_unavailable'});}finally{c.release();}
});}
async function owner(c:any,id:string,org:string){
 const o=(await c.query(`SELECT o.* FROM openings o JOIN buildings b ON b.id=o.building_id JOIN properties p ON p.id=b.property_id JOIN portfolios pf ON pf.id=p.portfolio_id WHERE o.id=$1 AND pf.organization_id=$2 FOR UPDATE OF o`,[uuid.parse(id),org])).rows[0];
 if(!o)throw new DomainError('not_found',404);return o;
}
function enabled(req:AuthedRequest){if(req.app.locals.planningSandboxEnabled!==true)throw new DomainError('planning_sandbox_disabled',503);}
const command=z.object({id:uuid,version_id:uuid,expected_version:z.number().int().nonnegative(),opening_id:uuid,kind:z.enum(['order','scenario']),estimate_version_id:uuid,label:z.string().trim().min(1).max(200),fiscal_period:z.string().trim().max(100),assumptions:z.string().trim().max(4000)}).strict().refine(b=>b.kind!=='scenario'||!!b.fiscal_period,'Scenario fiscal period is required');
endpoint('post','/versions',async(c,req)=>{
 enabled(req);const b=command.parse(req.body),a=req.auth!,o=await owner(c,b.opening_id,a.organizationId);if(o.status==='decommissioned')throw new DomainError('opening_retired');
 const e=(await c.query('SELECT v.*,e.opening_id,e.provider_id,e.head_version FROM replacement_estimate_versions v JOIN replacement_estimates e ON e.id=v.estimate_id WHERE v.id=$1 AND e.opening_id=$2',[b.estimate_version_id,o.id])).rows[0];if(!e)throw new DomainError('estimate_not_found',404);
 await c.query('INSERT INTO sandbox_plans(id,organization_id,opening_id,kind) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[b.id,a.organizationId,o.id,b.kind]);
 const plan=(await c.query('SELECT * FROM sandbox_plans WHERE id=$1 FOR UPDATE',[b.id])).rows[0];if(plan.organization_id!==a.organizationId||plan.opening_id!==o.id||plan.kind!==b.kind)throw new DomainError('not_found',404);
 const hash=canonicalPayloadHash(b),prior=(await c.query('SELECT * FROM sandbox_plan_versions WHERE id=$1',[b.version_id])).rows[0];
 if(prior){if(prior.plan_id!==plan.id||prior.recorded_by!==a.userId||prior.request_hash!==hash)throw new DomainError('operation_reused');return prior;}
 if(plan.head_version!==b.expected_version)throw new DomainError('version_conflict');
 // Drafting is not approval: stale/missing evidence stays visible and cannot dispatch.
 const snapshot={...b,estimate:e.snapshot,provider_id:e.provider_id,estimate_recorded_at:new Date(e.recorded_at).toISOString(),estimate_superseded_at_draft:e.version!==e.head_version,opening_revision:Number(o.revision),sandbox:true,business_state:'draft',financial_authority:false,configuration_gaps:PROCUREMENT_GAPS};
 const row=(await c.query('INSERT INTO sandbox_plan_versions(id,plan_id,version,snapshot,snapshot_hash,request_hash,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[b.version_id,b.id,plan.head_version+1,JSON.stringify(snapshot),canonicalPayloadHash(snapshot),hash,a.userId])).rows[0];
 await c.query("UPDATE sandbox_delivery_holds SET state='superseded',reason='new_revision_requires_new_review' WHERE version_id IN (SELECT id FROM sandbox_plan_versions WHERE plan_id=$1 AND id<>$2)",[b.id,b.version_id]);
 await c.query('UPDATE sandbox_plans SET head_version=head_version+1 WHERE id=$1',[b.id]);
 await c.query("INSERT INTO sandbox_plan_events(id,version_id,actor_id,action,request_hash) VALUES($1,$1,$2,'draft_created',$3)",[b.version_id,a.userId,hash]);return row;
});
endpoint('post','/versions/:id/request-review',async(c,req)=>{
 enabled(req);const b=z.object({operation_id:uuid}).strict().parse(req.body),a=req.auth!,id=uuid.parse(req.params.id);
 const v=(await c.query('SELECT v.*,p.opening_id,p.organization_id,p.kind FROM sandbox_plan_versions v JOIN sandbox_plans p ON p.id=v.plan_id WHERE v.id=$1',[id])).rows[0];if(!v||v.organization_id!==a.organizationId)throw new DomainError('not_found',404);
 await owner(c,v.opening_id,a.organizationId);const p=(await c.query('SELECT * FROM sandbox_plans WHERE id=$1 FOR UPDATE',[v.plan_id])).rows[0];
 const hash=canonicalPayloadHash({version_id:id,action:'review_requested'}),old=(await c.query('SELECT * FROM sandbox_plan_events WHERE id=$1',[b.operation_id])).rows[0];
 if(old){if(old.actor_id!==a.userId||old.version_id!==id||old.request_hash!==hash)throw new DomainError('operation_reused');return {...old,sandbox:true,nothing_sent_or_ordered:true};}
 if(v.kind!=='order')throw new DomainError('order_required');if(p.head_version!==v.version)throw new DomainError('version_superseded');
 const event=(await c.query("INSERT INTO sandbox_plan_events(id,version_id,actor_id,action,request_hash) VALUES($1,$2,$3,'review_requested',$4) RETURNING *",[b.operation_id,id,a.userId,hash])).rows[0];
 await c.query("INSERT INTO sandbox_delivery_holds(version_id,state,reason) VALUES($1,'disabled','financial_authority_and_external_delivery_not_configured') ON CONFLICT(version_id) DO NOTHING",[id]);
 return {...event,sandbox:true,nothing_sent_or_ordered:true};
});
endpoint('get','/:openingId',async(c,req)=>{
 const o=await owner(c,req.params.openingId,req.auth!.organizationId),id=o.id;
 const components=(await c.query('SELECT * FROM hardware_components WHERE opening_id=$1',[id])).rows;
 const versions=(await c.query('SELECT v.*,p.kind,p.head_version,h.state AS delivery_state,h.reason AS delivery_reason FROM sandbox_plan_versions v JOIN sandbox_plans p ON p.id=v.plan_id LEFT JOIN sandbox_delivery_holds h ON h.version_id=v.id WHERE p.opening_id=$1 ORDER BY v.recorded_at DESC',[id])).rows;
 const sourceEstimates=(await c.query('SELECT v.id,v.version,e.head_version FROM replacement_estimate_versions v JOIN replacement_estimates e ON e.id=v.estimate_id WHERE e.opening_id=$1',[id])).rows;
 const events=(await c.query('SELECT e.* FROM sandbox_plan_events e JOIN sandbox_plan_versions v ON v.id=e.version_id JOIN sandbox_plans p ON p.id=v.plan_id WHERE p.opening_id=$1 ORDER BY e.recorded_at',[id])).rows;
 const lifecycle=(await c.query('SELECT r.*,NOT EXISTS(SELECT 1 FROM lifecycle_records x WHERE x.correction_of=r.id) AS is_current FROM lifecycle_records r WHERE r.opening_id=$1',[id])).rows;
 const service=(await c.query('SELECT id FROM service_events WHERE opening_id=$1',[id])).rows;
 const replacements=(await c.query('SELECT id FROM component_replacements WHERE opening_id=$1',[id])).rows;
 const facts=(await c.query('SELECT f.* FROM installation_facts f WHERE f.opening_id=$1 AND NOT EXISTS(SELECT 1 FROM installation_facts x WHERE x.correction_of=f.id)',[id])).rows;
 const current=components.filter((x:any)=>x.lifecycle_state==='active');
 return {opening_id:id,opening_code:o.opening_code,as_of:new Date().toISOString(),sandbox_enabled:req.app.locals.planningSandboxEnabled===true,configuration_gaps:PROCUREMENT_GAPS,condition:conditionCohorts(components),lifecycle:{service_event_count:service.length,service_event_ids:service.map((s:any)=>s.id),recorded_replacements:replacements.length,replacement_ids:replacements.map((r:any)=>r.id),current_component_count:current.length,installation_unknown_count:current.filter((h:any)=>!facts.some((f:any)=>f.hardware_component_id===h.id&&f.certainty!=='unknown')).length,exposure_component_years:null,downtime:downtimeSummary(lifecycle)},versions:versions.map((v:any)=>({...v,is_current:v.version===v.head_version,estimate_expired:Date.parse(v.snapshot.estimate.expires_at)<=Date.now(),estimate_currently_superseded:!sourceEstimates.some((e:any)=>e.id===v.snapshot.estimate_version_id&&e.version===e.head_version),review_requested:events.some((e:any)=>e.version_id===v.id&&e.action==='review_requested')})),events,financial:{approved_reservation_minor:null,issued_commitment_minor:null,recognized_actual_minor:null,status:'unavailable_accounting_policy_and_accepted_cost_evidence_required',combined_total_minor:null}};
});
