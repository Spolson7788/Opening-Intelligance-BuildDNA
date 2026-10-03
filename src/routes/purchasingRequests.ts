import {Router} from 'express';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {pool} from '../db/pool';
import {AuthedRequest,requireRole} from '../middleware/auth';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {purchasingReview} from '../services/purchasingReview';

export const PURCHASING_ACKNOWLEDGMENT='I reviewed the product selection and supporting information and confirm this request is ready for purchasing department review.';
const preparedAction='Prepared purchasing department request';
const sentAction='Technician confirmed purchasing email sent';
const signature=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const purchasingRequestsRouter=Router();
purchasingRequestsRouter.use(requireRole('admin','technician','facilities_manager'));
const bodySchema=z.object({request_id:z.string().uuid(),opening_id:z.string().uuid(),recipient_email:z.string().email().max(254),acknowledged:z.literal(true)}).strict();

purchasingRequestsRouter.post('/',async(req:AuthedRequest,res)=>{
 const parsed=bodySchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'acknowledgment_and_recipient_required'});
 const b=parsed.data,a=req.auth!;const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.organizationId+':'+b.request_id]);
  const review=await purchasingReview(c,a.organizationId,[b.opening_id],true);
  if(!review){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
  if(review.blocked||!review.items.length){await c.query('ROLLBACK');return res.status(409).json({error:'request_not_ready',review});}
  const old=await c.query('SELECT user_id,request_body FROM audit_log WHERE organization_id=$1 AND action=$2 AND request_body->>\'request_id\'=$3',[a.organizationId,preparedAction,b.request_id]);
  if(old.rows.length){
   const prior=old.rows[0];if(prior.user_id!==a.userId){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
   if(prior.request_body.opening_id!==b.opening_id||prior.request_body.recipient_email!==b.recipient_email||prior.request_body.selection_hash!==signature(review.items)){await c.query('ROLLBACK');return res.status(409).json({error:'request_changed_prepare_again'});}
   await c.query('COMMIT');return res.json(prior.request_body);
  }
  const refs=await c.query(`SELECT DISTINCT d.brand,m.model,d.title,d.metadata->>'source_url' source_url FROM reference_documents d JOIN reference_document_models m ON m.doc_sha256=d.sha256 WHERE d.status='approved' AND EXISTS(SELECT 1 FROM reference_pages p WHERE p.doc_sha256=d.sha256 AND p.citable AND NOT p.fraction_unverified) AND EXISTS(SELECT 1 FROM hardware_components h WHERE h.opening_id=$1 AND h.replacement_required AND lower(h.model_number)=lower(m.model) AND regexp_replace(lower(h.manufacturer),'[^a-z0-9]','','g') IN (regexp_replace(lower(d.brand),'[^a-z0-9]','','g'),regexp_replace(lower(d.manufacturer),'[^a-z0-9]','','g'))) ORDER BY d.title LIMIT 12`,[b.opening_id]);
  const sources=refs.rows.filter(r=>{try{return new URL(r.source_url).protocol==='https:';}catch{return false;}});
  const photos=(await c.query('SELECT count(*)::int count FROM photos WHERE opening_id=$1',[b.opening_id])).rows[0].count;
  const subject='Product request for purchasing review — '+b.request_id;
  const mailBody=['Request ID: '+b.request_id,'Opening ID: '+b.opening_id,'',PURCHASING_ACKNOWLEDGMENT,'','Requested replacement products:',...review.items.map(i=>`${i.manufacturer} ${i.model_number} (component ${i.component_id})`),'','Supporting manufacturer references:',...sources.map(r=>`${r.brand} ${r.model}: ${r.source_url}`),...(sources.length?[]:['No approved reference link found. Purchasing must verify the product and documentation.']),'',`Saved photographs: ${photos}. Attach relevant photographs from the opening record before sending.`,'','Purchasing department: verify product selection, fit, quantities, pricing, and authorization before purchasing. This email is a request for review and does not authorize an order.'].join('\n');
  const record={request_id:b.request_id,opening_id:b.opening_id,recipient_email:b.recipient_email,acknowledgment:PURCHASING_ACKNOWLEDGMENT,acknowledged_by:a.userId,acknowledged_at:new Date().toISOString(),status:'prepared_for_purchasing_review',email_sent:false,purchase_authorized:false,selection_hash:signature(review.items),items:review.items,references:sources,photo_count:photos,email:{recipient:b.recipient_email,subject,body:mailBody}};
  await c.query(`INSERT INTO audit_log(organization_id,user_id,action,method,path,request_body,status_code) VALUES($1,$2,$3,'POST','/api/purchasing/requests',$4,201)`,[a.organizationId,a.userId,preparedAction,JSON.stringify(record)]);
  await c.query('COMMIT');return res.status(201).json(record);
 }catch{await c.query('ROLLBACK');return res.status(503).json({error:'request_preparation_failed'});}finally{c.release();}
});

purchasingRequestsRouter.post('/:id/email-sent',async(req:AuthedRequest,res)=>{
 if(!z.string().uuid().safeParse(req.params.id).success||!z.object({email_sent:z.literal(true)}).strict().safeParse(req.body).success)return res.status(400).json({error:'email_sent_confirmation_required'});
 const a=req.auth!,c=await pool.connect();try{
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.organizationId+':'+req.params.id]);
  const old=await c.query('SELECT request_body FROM audit_log WHERE organization_id=$1 AND user_id=$2 AND action=$3 AND request_body->>\'request_id\'=$4',[a.organizationId,a.userId,preparedAction,req.params.id]);
  if(!old.rows.length){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
  const prior=old.rows[0].request_body,review=await purchasingReview(c,a.organizationId,[prior.opening_id],true);
  if(!review){await c.query('ROLLBACK');return res.status(404).json({error:'not_found'});}
  const sent=await c.query('SELECT request_body FROM audit_log WHERE organization_id=$1 AND user_id=$2 AND action=$3 AND request_body->>\'request_id\'=$4',[a.organizationId,a.userId,sentAction,req.params.id]);
  if(sent.rows.length){await c.query('COMMIT');return res.json(sent.rows[0].request_body);}
  if(review.blocked||signature(review.items)!==prior.selection_hash){await c.query('ROLLBACK');return res.status(409).json({error:'request_changed_prepare_again'});}
  const record={request_id:req.params.id,opening_id:prior.opening_id,status:'submitted_for_purchasing_review',email_sent:true,delivery_confirmation:'technician_reported',submitted_by:a.userId,submitted_at:new Date().toISOString(),purchase_authorized:false};
  await c.query(`INSERT INTO audit_log(organization_id,user_id,action,method,path,request_body,status_code) VALUES($1,$2,$3,'POST','/api/purchasing/requests/email-sent',$4,200)`,[a.organizationId,a.userId,sentAction,JSON.stringify(record)]);
  await c.query('COMMIT');return res.json(record);
 }catch{await c.query('ROLLBACK');return res.status(503).json({error:'submission_recording_failed'});}finally{c.release();}
});

purchasingRequestsRouter.get('/opening/:id',async(req:AuthedRequest,res)=>{
 res.setHeader('Cache-Control','no-store');if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'invalid_opening_id'});
 const a=req.auth!;try{
  const scope=await pool.query(`SELECT 1 FROM (${openingsForOrgSubquery(2)}) o WHERE o.id=$1`,[req.params.id,a.organizationId]);if(!scope.rows.length)return res.status(404).json({error:'not_found'});
  const result=await pool.query(`SELECT p.request_body || COALESCE(s.request_body,'{}'::jsonb) request FROM audit_log p LEFT JOIN audit_log s ON s.organization_id=p.organization_id AND s.user_id=p.user_id AND s.action=$4 AND s.request_body->>'request_id'=p.request_body->>'request_id' WHERE p.organization_id=$1 AND p.user_id=$2 AND p.action=$3 AND p.request_body->>'opening_id'=$5 ORDER BY p.created_at DESC LIMIT 10`,[a.organizationId,a.userId,preparedAction,sentAction,req.params.id]);return res.json({requests:result.rows.map(r=>r.request)});
 }catch{return res.status(503).json({error:'request_history_unavailable'});}
});
