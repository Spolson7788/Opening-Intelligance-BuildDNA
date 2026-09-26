import {PoolClient} from 'pg';
import {openingsForOrgSubquery} from '../db/tenantScope';
export async function purchasingReview(client:PoolClient,orgId:string,ids:string[]){
 const unique=[...new Set(ids)];
 const ops=await client.query(`SELECT * FROM openings WHERE id=ANY($1::uuid[]) AND id IN (${openingsForOrgSubquery(2)}) ORDER BY id`,[unique,orgId]);
 if(ops.rowCount!==unique.length)return null;
 const parts=await client.query(`SELECT h.*,a.document_url,a.document_sha256,a.provenance,
 (a.revoked_at IS NULL AND a.component_id IS NOT NULL AND a.manufacturer=h.manufacturer AND a.model_number=h.model_number AND a.component_type=h.component_type) AS approved
 FROM hardware_components h LEFT JOIN component_purchasing_approvals a ON a.component_id=h.id WHERE h.opening_id=ANY($1::uuid[]) ORDER BY h.id`,[unique]);
 const frames=await client.query('SELECT opening_id,condition FROM opening_frames WHERE opening_id=ANY($1::uuid[])',[unique]);
 const leaves=await client.query('SELECT opening_id,leaf_role,condition FROM door_leaves WHERE opening_id=ANY($1::uuid[])',[unique]);
 const openingDecisions=ops.rows.map(o=>{
 const hardware=parts.rows.filter(h=>h.opening_id===o.id),roles=new Set(leaves.rows.filter(l=>l.opening_id===o.id).map(l=>l.leaf_role));
 const complete=o.completion_state==='complete' && frames.rows.some(f=>f.opening_id===o.id && ['good','worn','failed'].includes(f.condition)) && leaves.rows.filter(l=>l.opening_id===o.id).every(l=>['good','worn','failed'].includes(l.condition)) &&
 (o.opening_configuration==='pair'?roles.has('active')&&roles.has('inactive'):roles.has('single')) && hardware.length>0 && hardware.every(h=>h.review_state==='reviewed' && ['good','worn','failed'].includes(h.condition));
 return {opening_id:o.id,opening_complete:complete};
 });
 const decisions=parts.rows.map(h=>{
 const required=h.replacement_required&&h.condition!=='good';
 const reasons:string[]=[];
 if(!required)reasons.push('replacement_not_required');
 else{
 if(!['worn','failed'].includes(h.condition))reasons.push('condition_unverified');
 if(!openingDecisions.find(o=>o.opening_id===h.opening_id)!.opening_complete)reasons.push('opening_not_complete');
 if(h.review_state!=='reviewed')reasons.push('component_not_reviewed');
 if(h.identity_status!=='established'||!h.manufacturer?.trim()||!h.model_number?.trim())reasons.push('identity_unresolved');
 if(!h.approved)reasons.push('approved_document_required');
 }
 return {opening_id:h.opening_id,component_id:h.id,replacement_required:required,eligible:reasons.length===0,reasons,
 ...(reasons.length===0?{manufacturer:h.manufacturer,model_number:h.model_number,document_url:h.document_url,document_sha256:h.document_sha256,provenance:h.provenance}: {})};
 });
 const blocked=openingDecisions.some(o=>!o.opening_complete)||decisions.some(d=>d.replacement_required&&!d.eligible);
 return {review_only:true,nothing_sent_or_ordered:true,blocked,openings:openingDecisions,decisions,
 items:blocked?[]:decisions.filter(d=>d.eligible),excluded:decisions.filter(d=>!d.replacement_required),
 status:blocked?'blocked':decisions.some(d=>d.eligible)?'eligible':'no_replacements'};
}
