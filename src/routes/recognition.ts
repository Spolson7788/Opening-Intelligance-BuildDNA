import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,requireRole,AuthedRequest} from '../middleware/auth';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {legacyVisionHandler} from '../services/legacyVision';
import {createHash} from 'node:crypto';
import {readLabels,applyLabelEvidence} from '../services/labelReading';
import {retrieveReferences,resolvePartialMarkings,compareWithReferences,validateCitations,componentType,conservativeSuggestion,reportedReferenceHint,REFERENCE_PROMPT_VERSION,RECOGNITION_MODEL} from '../services/referenceEvidence';

const schema=z.object({
  opening_id:z.string().uuid(),
  images:z.array(z.string().min(4).max(2800000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)).min(1).max(5),
  media_type:z.enum(['image/jpeg','image/png','image/webp']),
  mode:z.enum(['identify','label_blind','marking_regions','hardware_regions']).default('identify'),
  technician_attributes:z.record(z.string().min(1).max(80),z.string().max(300)).refine(v=>Object.keys(v).length<=30).default({}),
}).strict();
export const recognitionRouter=Router();
recognitionRouter.use(requireAuth,requireRole('admin','technician','inspector','facilities_manager'));
function recognitionAvailability(){
  const enabled=process.env.OI_RECOGNITION_ENABLED==='true';
  const providerConfigured=Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return {available:enabled&&providerConfigured,blocking_reasons:[...(!enabled?['recognition_disabled']:[]),...(!providerConfigured?['recognition_provider_not_configured']:[])],reason:!enabled?'recognition_disabled':!providerConfigured?'recognition_provider_not_configured':null,reference_comparison_enabled:process.env.OI_REFERENCE_COMPARISON_ENABLED==='true'};
}
// Report configuration presence only; credentials never leave the server.
recognitionRouter.get('/availability',(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  return res.json(recognitionAvailability());
});
recognitionRouter.post('/',async(req:AuthedRequest,res)=>{
  res.setHeader('Cache-Control','no-store');
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'invalid_recognition_request'});
  const b=parsed.data;
  const images=b.images.map(s=>Buffer.from(s,'base64'));
  if(images.reduce((n,x)=>n+x.length,0)>2*1024*1024)return res.status(413).json({error:'recognition_images_too_large'});
  const valid=images.every(x=>b.media_type==='image/jpeg'?x[0]===255&&x[1]===216&&x[2]===255:
    b.media_type==='image/png'?x.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    x.subarray(0,4).toString()==='RIFF'&&x.subarray(8,12).toString()==='WEBP');
  if(!valid)return res.status(400).json({error:'image_type_mismatch'});
  let phase:'opening_access'|'provider'|'recording'='opening_access';
  try{
    const allowed=await pool.query(`SELECT 1 FROM (${openingsForOrgSubquery(2)}) a WHERE a.id=$1`,[b.opening_id,req.auth!.organizationId]);
    if(!allowed.rows.length)return res.status(404).json({error:'opening_not_found'});
    // Explicit release switch prevents unintended paid calls during preview tests.
    const availability=recognitionAvailability();
    if(!availability.available)return res.status(503).json({error:availability.reason});
    phase='provider';
    const deadline=Date.now()+50000;
    const [response,labels]=await Promise.all([
      legacyVisionHandler({httpMethod:'POST',body:JSON.stringify({...b,timeout_ms:18000})}),
      b.mode==='identify'?readLabels(images,b.media_type,Date.now()+35000):Promise.resolve(null),
    ]);
    if(response.statusCode!==200){
      // Only allow known safe categories through; never forward provider bodies.
      const safeErrors=new Set(['recognition_provider_authentication_failed','recognition_provider_permission_denied','recognition_provider_model_unavailable','recognition_provider_rate_limited','recognition_provider_image_rejected','recognition_provider_billing_blocked','recognition_provider_request_rejected','recognition_provider_temporarily_unavailable','recognition_provider_invalid_response','recognition_provider_timeout','recognition_provider_connection_failed','recognition_engine_failed']);
      let error='recognition_provider_failed';
      try{const code=JSON.parse(response.body)?.error;if(safeErrors.has(code))error=code;}catch{}
      return res.status(502).json({error});
    }
    let result=JSON.parse(response.body);
    if(!result||typeof result!=='object'||Array.isArray(result))return res.status(502).json({error:'recognition_provider_failed'});
    if(labels&&b.mode==='identify'){
      try{
        const matches=await resolvePartialMarkings(labels,String(result.manufacturer||''));
        if(matches.length){
          const exact=(labels.candidates||[]).filter(c=>c.manufacturer_basis!=='catalog_partial_model_match');
          labels.candidates=exact.length?exact:matches;
        }
      }catch{/* Preserve photograph and raw label evidence if the catalog is unavailable. */}
    }
    if(labels)result=applyLabelEvidence(result,labels);
    let pages:Awaited<ReturnType<typeof retrieveReferences>>=[];
    let conflicts:unknown[]=[];let comparison:any=null;let status='no_reference_evidence';
    try{
      if(b.mode==='identify'){
        const candidate=labels?.candidates?.length===1?labels.candidates[0]:null;
        const retrievalStage=!result.model&&!result.series&&!reportedReferenceHint(b.technician_attributes)&&candidate?{...result,manufacturer:result.manufacturer||candidate.manufacturer,series:candidate.series,model:candidate.model}:result;
        pages=await retrieveReferences(retrievalStage,b.technician_attributes);
        if(!result.model&&!result.series&&!reportedReferenceHint(b.technician_attributes)&&(labels?.candidates?.length||0)>1){
          const groups=await Promise.all(labels!.candidates!.map(c=>retrieveReferences({...result,manufacturer:c.manufacturer,series:c.series,model:c.model},b.technician_attributes)));
          pages=[...new Map(groups.flat().map(p=>[p.page_id,p])).values()].slice(0,8);
        }
      }
      if(!pages.length&&b.mode==='identify'&&result.component_class==='DOOR_CLOSER'&&Array.isArray(result.scale_measurements)&&result.scale_measurements.length){
        // Dimensions without a readable model still warrant candidate comparison.
        // The classifier does not establish identity through this broader search.
        pages=await retrieveReferences({visible_text:['closer']},{});
        result.reference_lookup_basis='marker_dimensions_candidate_search';
      }
      if(pages.length){
        conflicts=(await pool.query('SELECT * FROM reference_conflicts WHERE doc_sha256=ANY($1::text[])',[pages.map(p=>p.doc_sha256)])).rows.map(c=>({...c,values:c.values.map((v:any)=>({...v,page_id:`sha256:${c.doc_sha256}#p${v.page}`,doc_sha256:c.doc_sha256}))}));
        // A conflicting page must be retrieved and citable before its values
        // can be shown as reference evidence.
        conflicts=conflicts.filter((c:any)=>c.values.every((v:any)=>pages.some(p=>p.page_id===v.page_id)));
        if(process.env.OI_REFERENCE_COMPARISON_ENABLED==='true'){
          comparison=await compareWithReferences({images:b.images,media_type:b.media_type,stage_one:result,attributes:b.technician_attributes,pages,conflicts,timeout_ms:Math.max(1000,Math.min(18000,deadline-Date.now()))});
          status='reference_evidence';
        }else status='reference_comparison_disabled';
      }
    }catch{status=pages.length?'reference_comparison_unavailable':'reference_store_unavailable';}
    const proposed:any[]=Array.isArray(comparison?.citations)?[...comparison.citations]:[];
    const collect=(value:any):void=>{
      if(Array.isArray(value)){value.forEach(collect);return;}
      if(!value||typeof value!=='object')return;
      for(const [key,v] of Object.entries(value)){
        if(key==='citations')continue;
        if(key==='citation')proposed.push(v);
        else if(v&&typeof v==='object'&&'page_id' in v)proposed.push(v);
        else collect(v);
      }
    };
    collect(comparison);
    const validation=validateCitations(proposed,pages);
    const validated={accepted:Array.from(new Map(validation.accepted.map(c=>[JSON.stringify(c),c])).values()),rejected:validation.rejected};
    // Sanitize nested citations as well as the top-level citation list.
    const clean=(value:any):any=>{
      if(Array.isArray(value))return value.map(clean);
      if(!value||typeof value!=='object')return value;
      if('page_id' in value)return validateCitations([value],pages).accepted[0]||null;
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='citation'?(validateCitations([v],pages).accepted[0]||null):clean(v)]));
    };
    comparison=clean(comparison);
    const conflictFields=new Set(conflicts.map((c:any)=>c.field));
    const unresolve=(v:any):any=>Array.isArray(v)?v.map(unresolve):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,conflictFields.has(k)?null:unresolve(x)])):v;
    comparison=unresolve(comparison);
    if(comparison&&conflicts.length)comparison.unresolved=[...(Array.isArray(comparison.unresolved)?comparison.unresolved:[]),...conflicts.map((c:any)=>`Conflicting source specifications for ${c.field}; no controlling value selected.`)];
    if(comparison)comparison.citations=validated.accepted;
    if(status==='reference_evidence'&&!validated.accepted.length)status='no_valid_reference_citations';
    const suggestion=conservativeSuggestion(result,comparison);
    phase='recording';
    const client=await pool.connect();let run;
    try{
      await client.query('BEGIN');
      // Recheck current opening access after provider calls, before persisting.
      const scope=await client.query(`SELECT 1 FROM (${openingsForOrgSubquery(2)}) a WHERE a.id=$1`,[b.opening_id,req.auth!.organizationId]);
      if(!scope.rows.length){await client.query('ROLLBACK');return res.status(404).json({error:'opening_not_found'});}
      const current=await client.query('SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND is_active AND role IN (\'admin\',\'technician\',\'inspector\',\'facilities_manager\')',[req.auth!.userId,req.auth!.organizationId]);
      if(!current.rows.length){await client.query('ROLLBACK');return res.status(403).json({error:'forbidden'});}
      run=(await client.query(`INSERT INTO recognition_runs (organization_id,opening_id,user_id,photo_hashes,technician_attributes,component_type,raw_class_code,stage_one,retrieved_pages,stage_two,citations,rejected_citations,conflicts,status,model_id,prompt_version,suggestion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,[
       req.auth!.organizationId,b.opening_id,req.auth!.userId,JSON.stringify(images.map(x=>createHash('sha256').update(x).digest('hex'))),JSON.stringify(b.technician_attributes),componentType(result.component_class),result.component_class||null,JSON.stringify(result),JSON.stringify(pages.map(p=>({page_id:p.page_id,doc_sha256:p.doc_sha256,page_no:p.page_no,text_sha256:p.text_sha256}))),JSON.stringify(comparison),JSON.stringify(validated.accepted),JSON.stringify(validated.rejected),JSON.stringify(conflicts),status,RECOGNITION_MODEL,REFERENCE_PROMPT_VERSION,JSON.stringify(suggestion)])).rows[0];
      await client.query(`INSERT INTO audit_log (organization_id,user_id,action,method,path,request_body,status_code) VALUES ($1,$2,'Recorded recognition evidence','POST','/api/recognition',$3,200)`,[req.auth!.organizationId,req.auth!.userId,JSON.stringify({run_id:run.id,opening_id:b.opening_id,model:RECOGNITION_MODEL,prompt_version:REFERENCE_PROMPT_VERSION,rejected_citation_count:validated.rejected.length})]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    return res.json({suggestion,label_candidates:labels?.candidates||[],label_candidate:labels?.candidates?.length===1?labels.candidates[0]:null,reported_identity:reportedReferenceHint(b.technician_attributes),run_id:run.id,status,comparison,citations:validated.accepted,conflicts,requires_technician_review:true});
  }catch{return res.status(503).json({error:phase==='opening_access'?'recognition_opening_access_unavailable':phase==='recording'?'recognition_recording_unavailable':'recognition_provider_failed'});}
});

recognitionRouter.get('/opening/:id',async(req:AuthedRequest,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!z.string().uuid().safeParse(req.params.id).success)return res.status(400).json({error:'invalid_opening_id'});
  try{
    const allowed=await pool.query(`SELECT 1 FROM (${openingsForOrgSubquery(2)}) a WHERE a.id=$1`,[req.params.id,req.auth!.organizationId]);
    if(!allowed.rows.length)return res.status(404).json({error:'opening_not_found'});
    // Sharing follows current opening authorization. Draft page content is
    // never exposed here; historical citations identify their original source.
    const runs=await pool.query('SELECT * FROM recognition_runs WHERE opening_id=$1 ORDER BY created_at DESC LIMIT 50',[req.params.id]);
    return res.json({runs:runs.rows});
  }catch{return res.status(503).json({error:'recognition_history_unavailable'});}
});

recognitionRouter.post('/:id/component',async(req:AuthedRequest,res)=>{
  const parsed=z.object({component_id:z.string().uuid()}).strict().safeParse(req.body);
  if(!z.string().uuid().safeParse(req.params.id).success||!parsed.success)return res.status(400).json({error:'invalid_recognition_link'});
  try{
    const r=await pool.query(`UPDATE recognition_runs r SET component_id=$1 FROM hardware_components h
     WHERE r.id=$2 AND r.user_id=$3 AND h.id=$1 AND h.opening_id=r.opening_id
     AND r.opening_id IN (${openingsForOrgSubquery(4)}) AND (r.component_id IS NULL OR r.component_id=$1) RETURNING r.id`,[parsed.data.component_id,req.params.id,req.auth!.userId,req.auth!.organizationId]);
    if(!r.rows.length)return res.status(404).json({error:'recognition_or_component_not_found'});
    return res.json({run_id:r.rows[0].id});
  }catch{return res.status(503).json({error:'recognition_link_unavailable'});}
});
