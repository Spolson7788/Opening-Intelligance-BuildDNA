import {classifierObject} from '../services/providerReply';
import recognitionBuild from '../generated/recognitionBuild.json';
import {LABEL_RESPONSE_VERSION} from '../services/labelResponse';
import sharp from 'sharp';
import {normalizeRecognitionImage} from '../services/recognitionImage';
import {recognitionAudit,recordRecognitionEvidence} from '../services/recognitionAudit';
import {registerStabilityRun,stabilityTrialId,reconcileRejectedAttempt} from '../services/recognitionStabilityBudget';
import {withinRecognitionBudget,referenceComparisonBudget} from '../services/recognitionDeadline';
import {approvedInstallationGeometry} from '../services/installationGeometry';
import {Router} from 'express';
import {z} from 'zod';
import {pool} from '../db/pool';
import {requireAuth,requireRole,AuthedRequest} from '../middleware/auth';
import {openingsForOrgSubquery} from '../db/tenantScope';
import {legacyVisionHandler} from '../services/legacyVision';
import {createHash} from 'node:crypto';
import {readLabels,readTargetedLabels,applyLabelEvidence,LABEL_PROMPT_VERSION} from '../services/labelReading';
import {catalogIdentityReview} from '../services/catalogIdentityReview';
import {originalInputsEnabled,MAX_RECOGNITION_ORIGINAL_BYTES,MAX_RECOGNITION_SET_BYTES} from '../services/recognitionOriginalLimits';
import {loadRecognitionOriginals} from '../services/recognitionOriginals';
import {retrieveReferences,referenceFailureCode,resolvePartialMarkings,compareWithReferences,validateCitations,componentType,conservativeSuggestion,reportedReferenceHint,sanitizeReferenceComparison,REFERENCE_PROMPT_VERSION,RECOGNITION_MODEL} from '../services/referenceEvidence';

const schema=z.object({
  opening_id:z.string().uuid(),
  request_id:z.string().uuid().optional(),
  images:z.array(z.string().min(4).max(2800000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)).min(1).max(5).optional(),
  photo_ids:z.array(z.string().uuid()).min(3).max(5).optional(),
  media_type:z.enum(['image/jpeg','image/png','image/webp']),
  mode:z.enum(['identify','label_blind','marking_regions','hardware_regions']).default('identify'),
  technician_attributes:z.record(z.string().min(1).max(80),z.string().max(300)).refine(v=>Object.keys(v).length<=30).default({}),
}).strict().refine(b=>Boolean(b.images)!==Boolean(b.photo_ids));
export const recognitionRouter=Router();
recognitionRouter.use(requireAuth,requireRole('admin','technician','inspector','facilities_manager'));
function recognitionAvailability(){
  const enabled=process.env.OI_RECOGNITION_ENABLED==='true'&&process.env.OI_RECOGNITION_SHADOW_ENABLED==='true';
  const providerConfigured=Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return {...(originalInputsEnabled()?{original_photo_input_available:true,maximum_original_bytes:MAX_RECOGNITION_ORIGINAL_BYTES,maximum_original_set_bytes:MAX_RECOGNITION_SET_BYTES}:{}),available:enabled&&providerConfigured,blocking_reasons:[...(!enabled?['recognition_disabled']:[]),...(!providerConfigured?['recognition_provider_not_configured']:[])],reason:!enabled?'recognition_disabled':!providerConfigured?'recognition_provider_not_configured':null,reference_comparison_enabled:process.env.OI_REFERENCE_COMPARISON_ENABLED==='true'};
}
// Report configuration presence only; credentials never leave the server.
recognitionRouter.get('/availability',(_req,res)=>{
  res.setHeader('Cache-Control','no-store');
  return res.json(recognitionAvailability());
});
recognitionRouter.post('/stability/reconcile',requireRole('admin'),async(req:AuthedRequest,res)=>{
 const body=z.object({attempt_id:z.string().uuid(),evidence:z.string().trim().min(1).max(1000)}).strict().safeParse(req.body);
 if(!body.success)return res.status(400).json({error:'invalid_reconciliation_request'});
 try{return res.json(await reconcileRejectedAttempt(body.data.attempt_id,req.auth!,body.data.evidence));}
 catch{return res.status(409).json({error:'stability_reconciliation_not_permitted'});}
});
recognitionRouter.post('/',async(req:AuthedRequest,res)=>{
  res.setHeader('Cache-Control','no-store');
  const parsed=schema.safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:'invalid_recognition_request'});
  const b=parsed.data;
  let images:Buffer[]=(b.images||[]).map(s=>Buffer.from(s,'base64'));
  let sourceManifest:unknown[]=[];
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
    const started=Date.now();
    if(b.photo_ids){
      if(!originalInputsEnabled())return res.status(403).json({error:'recognition_originals_disabled'});
      const sources=await loadRecognitionOriginals(b.photo_ids,{openingId:b.opening_id,organizationId:req.auth!.organizationId,userId:req.auth!.userId},b.media_type);
      images=sources.images;sourceManifest=sources.sources;
      const metadata=await Promise.all(images.map(x=>sharp(x,{limitInputPixels:16_000_000}).metadata()));
      const formats:Record<string,string>={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
      if(metadata.some(m=>m.format!==formats[b.media_type]))return res.status(400).json({error:'image_type_mismatch'});
      if(metadata.reduce((n,m)=>n+(m.width||0)*(m.height||0),0)>48_000_000)return res.status(413).json({error:'recognition_source_pixel_limit'});
    }
    const sourceHashes=images.map(x=>createHash('sha256').update(x).digest('hex'));
    // Native source pixels reach normalization/cropping without client resizing.
    const normalized:Buffer[]=[];for(const image of images)normalized.push(await normalizeRecognitionImage(image));
    images=normalized;
    b.images=images.map(x=>x.toString('base64'));b.media_type='image/png';
    phase='recording';
    const initial=(await pool.query(`INSERT INTO recognition_runs
     (organization_id,opening_id,user_id,photo_hashes,technician_attributes,component_type,stage_one,suggestion,retrieved_pages,citations,rejected_citations,conflicts,status,model_id,prompt_version)
     VALUES($1,$2,$3,$4,$5,NULL,$6,'{}','[]','[]','[]','[]','running',$7,$8) RETURNING id`,[
     req.auth!.organizationId,b.opening_id,req.auth!.userId,JSON.stringify(sourceHashes),JSON.stringify(b.technician_attributes),JSON.stringify({request_id:b.request_id,shadow_mode:true,source_inputs:sourceManifest,recognition_versions:{...recognitionBuild,label_prompt:LABEL_PROMPT_VERSION,label_response:LABEL_RESPONSE_VERSION,reference_prompt:REFERENCE_PROMPT_VERSION},libraries:{sharp:sharp.versions,tesseract:require('tesseract.js/package.json').version}}),RECOGNITION_MODEL,REFERENCE_PROMPT_VERSION])).rows[0];
    return await recognitionAudit.run({runId:initial.id,deadline:started+49000,trialControl:{}},async()=>{try{
    if(stabilityTrialId()&&b.mode!=='identify')throw Error('stability_identify_mode_required');
    await registerStabilityRun(initial.id,b.request_id);
    phase='provider';
    const bounded=<T>(work:()=>Promise<T>,deadline:number,fallback:()=>T)=>withinRecognitionBudget(signal=>recognitionAudit.run({...recognitionAudit.getStore()!,signal},work),deadline,fallback);
    const classify=()=>bounded(()=>legacyVisionHandler({httpMethod:'POST',body:JSON.stringify({...b,technician_attributes:{},timeout_ms:18000,include_provider_diagnostic:req.auth!.role==='admin'})}),stabilityTrialId()?Math.min(started+46000,Date.now()+18000):started+20000,()=>({statusCode:502,body:JSON.stringify({error:'recognition_provider_timeout'})}));
    const label=()=>b.mode==='identify'?bounded(()=>readLabels(images,b.media_type,Math.min(started+46000,Date.now()+24000)),Math.min(started+46000,Date.now()+24000),()=>({version:LABEL_PROMPT_VERSION,status:'unavailable' as const,reads:[],limiting_factor:'label_processing_timeout'})):Promise.resolve(null);
    // Trial calls are sequenced so the conservative per-call ceiling settles
    // before the next reservation. Ordinary shadow mode retains its concurrency.
    let response:Awaited<ReturnType<typeof classify>>,labels:Awaited<ReturnType<typeof label>>;
    if(stabilityTrialId()){
     await recordRecognitionEvidence('label_strategy',{version:'targeted-label-1',order:'label_before_classifier',reader_budget_ms:32000,ocr_order:'after_reader'});
     labels=await bounded(()=>readTargetedLabels(images,b.media_type,started+32000),started+32000,()=>({version:'oi-targeted-label-reading-1',status:'unavailable' as const,reads:[],limiting_factor:'label_processing_timeout'}));
     response=recognitionAudit.getStore()?.trialControl?.stopped?{statusCode:503,body:JSON.stringify({error:'recognition_provider_failed'})}:await classify();
    }else [response,labels]=await Promise.all([classify(),label()]);
    await pool.query(`UPDATE recognition_runs SET stage_one=stage_one || $2::jsonb WHERE id=$1`,[initial.id,JSON.stringify({label_reading:labels})]);
    if(response.statusCode!==200){
      // Only allow known safe categories through; never forward provider bodies.
      const safeErrors=new Set(['recognition_provider_authentication_failed','recognition_provider_permission_denied','recognition_provider_model_unavailable','recognition_provider_rate_limited','recognition_provider_image_rejected','recognition_provider_billing_blocked','recognition_provider_usage_limit_reached','recognition_provider_request_rejected','recognition_provider_image_format_rejected','recognition_provider_image_dimensions_rejected','recognition_provider_context_limit','recognition_provider_temporarily_unavailable','recognition_provider_invalid_response','recognition_provider_timeout','recognition_provider_connection_failed','recognition_engine_failed']);
      let error='recognition_provider_failed';let providerDiagnostic:string|undefined;
      try{const failed=JSON.parse(response.body);if(safeErrors.has(failed?.error))error=failed.error;
       if(req.auth!.role==='admin'&&typeof failed.provider_diagnostic==='string')providerDiagnostic=failed.provider_diagnostic.slice(0,400);
      }catch{}
      await recordRecognitionEvidence('failure',{http_status:502,code:error});
      return res.status(502).json({error,...(providerDiagnostic?{provider_diagnostic:providerDiagnostic}:{})});
    }
    let result:any;try{result=JSON.parse(response.body);if(b.mode==='identify')result=classifierObject(result);}catch{result=null;}
    if(!result||typeof result!=='object'||Array.isArray(result)){await recordRecognitionEvidence('failure',{http_status:502,code:'recognition_provider_failed'});return res.status(502).json({error:'recognition_provider_failed'});}
    if(labels&&b.mode==='identify'){
      try{
        const matches=await resolvePartialMarkings(labels);
        if(matches.length){
          const exact=(labels.candidates||[]).filter(c=>c.manufacturer_basis!=='catalog_partial_model_match');
          labels.candidates=exact.length?exact:matches;
        }
      }catch{/* Preserve photograph and raw label evidence if the catalog is unavailable. */}
    }
    if(stabilityTrialId()&&b.mode==='identify'&&result.component_class==='EXIT_DEVICE'&&labels){
      const review=catalogIdentityReview(labels,result);
      result.catalog_identity_review=review;
      await recordRecognitionEvidence('catalog_identity_review',review);
    }
    result=applyLabelEvidence(result,labels||{version:'unavailable',status:'unavailable',reads:[],limiting_factor:'label_evidence_unavailable'});
    result=conservativeSuggestion(result,null);
    if(b.request_id)result.request_id=b.request_id;
    let pages:Awaited<ReturnType<typeof retrieveReferences>>=[];
    let conflicts:unknown[]=[];let comparison:any=null;let status='no_reference_evidence';let comparisonStarted=false;let comparisonAt=0;let comparisonBudget=0;
    try{
      if(b.mode==='identify'){
        if(result.component_class==='DOOR_CLOSER'){
          try{result.installation_geometry=await approvedInstallationGeometry(result.installation_geometry_views,images.length);}catch{result.installation_geometry={status:'reference_geometry_unavailable',candidates:[],limitation:'Installation geometry could not be retrieved. Label reading continues.'};}
        }
        const candidate=labels?.candidates?.length===1?labels.candidates[0]:null;
        const retrievalStage=!result.model&&!result.series&&candidate?{...result,manufacturer:candidate.manufacturer,series:candidate.series,model:candidate.model||candidate.catalog_model}:result;
        pages=await retrieveReferences(retrievalStage,{});
        if(!result.model&&!result.series&&(labels?.candidates?.length||0)>1){
          const groups=await Promise.all(labels!.candidates!.map(c=>retrieveReferences({...result,manufacturer:c.manufacturer,series:c.series,model:c.model||c.catalog_model},{})));
          pages=[...new Map(groups.flat().map(p=>[p.page_id,p])).values()].slice(0,8);
        }
      }
      if(!pages.length&&b.mode==='identify'&&result.component_class==='DOOR_CLOSER'&&result.installation_geometry?.status==='shared_pattern_compatible'&&result.installation_geometry?.candidates?.length){
        const groups=await Promise.all(result.installation_geometry.candidates.map((c:any)=>retrieveReferences({manufacturer:c.manufacturer,model:c.model||c.catalog_model},{})));
        pages=[...new Map(groups.flat().map((p:any)=>[p.page_id,p])).values()].slice(0,8) as any;
        result.reference_lookup_basis='installation_geometry_pilot_candidates';
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
          comparisonBudget=referenceComparisonBudget(started);
          if(!comparisonBudget)throw Error('reference_comparison_budget_exhausted');
          comparisonStarted=true;
          comparisonAt=Date.now();
          comparison=await compareWithReferences({images:b.images!,media_type:b.media_type,stage_one:result,attributes:{},pages,conflicts,timeout_ms:comparisonBudget});
          comparison.processing={...comparison.processing,elapsed_ms:Date.now()-comparisonAt,budget_ms:comparisonBudget};
          status='reference_evidence';
        }else status='reference_comparison_disabled';
      }
    }catch(error){status=pages.length?'reference_comparison_unavailable':'reference_store_unavailable';if(comparisonStarted||(error as any)?.message==='reference_comparison_budget_exhausted')result.reference_comparison_failure={code:referenceFailureCode(error),budget_ms:comparisonBudget,elapsed_ms:comparisonAt?Date.now()-comparisonAt:0};}
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
    const comparisonProcessing=comparison?.processing;
    const shapeAdjustments=comparison?.reasoning_adjustments;
    if(comparison){delete comparison.processing;delete comparison.reasoning_adjustments;}
    comparison=sanitizeReferenceComparison(clean(comparison),result,pages);
    if(comparison){comparison.processing=comparisonProcessing;comparison.reasoning_adjustments=[...(shapeAdjustments||[]),...(comparison.reasoning_adjustments||[])];}
    const conflictFields=new Set(conflicts.map((c:any)=>c.field));
    const unresolve=(v:any):any=>Array.isArray(v)?v.map(unresolve):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,conflictFields.has(k)?null:unresolve(x)])):v;
    comparison=unresolve(comparison);
    if(comparison&&conflicts.length)comparison.unresolved=[...(Array.isArray(comparison.unresolved)?comparison.unresolved:[]),...conflicts.map((c:any)=>`Conflicting source specifications for ${c.field}; no controlling value selected.`)];
    if(comparison)comparison.citations=validated.accepted;
    if(status==='reference_evidence'&&!validated.accepted.length)status='no_valid_reference_citations';
    result.processing={version:'oi-recognition-budget-2',analysis_elapsed_ms:Date.now()-started};
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
      run=(await client.query(`UPDATE recognition_runs SET component_type=$2,raw_class_code=$3,stage_one=stage_one || $4::jsonb,retrieved_pages=$5,stage_two=$6,citations=$7,rejected_citations=$8,conflicts=$9,status=$10,suggestion=$11 WHERE id=$1 RETURNING id`,[
       initial.id,componentType(result.component_class),result.component_class||null,JSON.stringify(result),JSON.stringify(pages.map(p=>({page_id:p.page_id,doc_sha256:p.doc_sha256,page_no:p.page_no,text_sha256:p.text_sha256}))),JSON.stringify(comparison),JSON.stringify(validated.accepted),JSON.stringify(validated.rejected),JSON.stringify(conflicts),status,JSON.stringify(suggestion)])).rows[0];
      await client.query(`INSERT INTO audit_log (organization_id,user_id,action,method,path,request_body,status_code) VALUES ($1,$2,'Recorded recognition evidence','POST','/api/recognition',$3,200)`,[req.auth!.organizationId,req.auth!.userId,JSON.stringify({run_id:run.id,opening_id:b.opening_id,model:RECOGNITION_MODEL,prompt_version:REFERENCE_PROMPT_VERSION,rejected_citation_count:validated.rejected.length})]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    return res.json({shadow_mode:true,suggestion,label_candidates:labels?.candidates||[],label_candidate:labels?.candidates?.length===1?labels.candidates[0]:null,reported_identity:reportedReferenceHint(b.technician_attributes),run_id:run.id,status,reference_comparison_failure:result.reference_comparison_failure||null,comparison,citations:validated.accepted,conflicts,requires_technician_review:true});
    }finally{await pool.query(`UPDATE recognition_runs SET status='failed' WHERE id=$1 AND status='running'`,[initial.id]);}});
  }catch{return res.status(503).json({error:phase==='opening_access'?'recognition_opening_access_unavailable':phase==='recording'?'recognition_recording_unavailable':'recognition_provider_failed'});}
});

// Recover a committed response after a gateway timeout, never start another AI call.
recognitionRouter.get('/request/:id',async(req:AuthedRequest,res)=>{
 res.setHeader('Cache-Control','no-store');
 const opening=z.string().uuid().safeParse(req.query.opening_id);
 if(!z.string().uuid().safeParse(req.params.id).success||!opening.success)return res.status(400).json({error:'invalid_recognition_request'});
 try{
  const allowed=await pool.query(`SELECT 1 FROM (${openingsForOrgSubquery(2)}) a WHERE a.id=$1`,[opening.data,req.auth!.organizationId]);
  if(!allowed.rows.length)return res.status(404).json({error:'opening_not_found'});
  const r=(await pool.query(`SELECT * FROM recognition_runs WHERE organization_id=$1 AND user_id=$2 AND opening_id=$3 AND stage_one->>'request_id'=$4 ORDER BY created_at DESC LIMIT 1`,[req.auth!.organizationId,req.auth!.userId,opening.data,req.params.id])).rows[0];
  if(!r||r.status==='running')return res.status(202).json({status:'awaiting_saved_result'});
  if(r.status==='failed')return res.status(502).json({error:'recognition_provider_failed'});
  if(!r.suggestion||typeof r.suggestion!=='object'||Array.isArray(r.suggestion)||!Object.keys(r.suggestion).length)
    return res.status(502).json({error:'recognition_result_missing'});
  const labels=r.stage_one?.label_reading?.candidates||[];
  return res.json({request_id:req.params.id,recovered:true,shadow_mode:r.stage_one?.shadow_mode===true,suggestion:r.suggestion,label_candidates:labels,label_candidate:labels.length===1?labels[0]:null,reported_identity:reportedReferenceHint(r.technician_attributes||{}),run_id:r.id,status:r.status,reference_comparison_failure:r.stage_one?.reference_comparison_failure||null,comparison:r.stage_two,citations:r.citations||[],conflicts:r.conflicts||[],requires_technician_review:true});
 }catch{return res.status(503).json({error:'recognition_history_unavailable'});}
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
