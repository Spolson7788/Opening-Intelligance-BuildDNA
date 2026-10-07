import {useEffect,useRef,useState} from 'react';
import {fetchSavedRecognitionReview,fetchRecognitionAvailability,recognizeHardware,uploadRecognitionOriginals,checkSavedRecognitionOriginals,fetchPhotoAccessUrl} from '../lib/api';
import {labelConfirmationMessage,visionReadMessage} from '../lib/labelReadStatus';
import {ReferenceEvidence} from './ReferenceEvidence';
import {getOrCreateDeviceId} from '../lib/sync';
import {CatalogIdentityEvidence,type CatalogReview} from './CatalogIdentityEvidence';

const photographedComponentTypes:Record<string,string>={DOOR_CLOSER:'closer',EXIT_DEVICE:'exit_device',LOCKSET:'lockset',HINGE_BUTT:'hinge',HINGE_CONT:'hinge',FLUSH_BOLT:'other',ELECTRIC_STRIKE:'electric_strike',POWER_TRANSFER:'power_transfer'};

export function recognitionFailureMessage(code:string){
  const messages:Record<string,string>={
    stability_trial_scope_mismatch:'These photos are saved, but this device set is not enabled for the current staging test. No AI call was made. The staging administrator must enable this saved set.',
    stability_photo_set_already_run:'This photo set has already been tested. Its saved result is retained. No new AI call was made.',
    stability_run_limit:'The enabled staging tests have been used. Your originals are saved. No AI call was made; the next device test must be enabled.',
    stability_budget_exhausted:'The remaining test budget cannot cover this request. Your originals are saved. No AI call was made.',
    stability_unknown_spend:'Testing is paused after an interrupted AI request. Existing charges remain reserved; no new AI call was made.',
    stability_trial_unavailable:'This staging trial is paused or unavailable. Your originals are saved. No AI call was made.',
    stability_trial_not_configured:'The staging trial is not configured. No AI call was made.',

    recognition_stage_not_resumable:'This stage has already started or cannot be resumed safely. No additional analysis was started.',
 recognition_saved_review_unavailable:'No completed grouped-photo analysis is saved for this account and opening.',
 recognition_stage_input_changed:'The saved run belongs to different inputs or an older build. No additional analysis was started.',
 recognition_stage_not_found:'The saved recognition stage is unavailable to this account.',
 recognition_label_reader_timeout:'The label readers timed out. Saved evidence and originals are retained. Do not retry this paid stage.',
 recognition_client_update_required:'This page is an older app build. Reload the updated app before analysis. No AI call was made.',
    recognition_label_locator_timeout:'The marking locator timed out before label or logo reading could start. The saved originals are retained. Do not retry this test yet.',
    recognition_label_locator_failed:'The marking locator failed before label or logo reading could start. The saved originals are retained. Do not retry this test yet.',
    request_failed_504:'Analysis took too long and the server stopped the request. No identification result was returned. Your selected photograph remains available.',
    recognition_result_missing:'The server returned no usable analysis result. No identification was applied. Your selected photograph remains available.',
    recognition_saved_result_not_found:'The connection timed out and no saved result was found for this request. Your photograph remains selected. No analysis was retried automatically.',
    recognition_disabled:'Photograph recognition is switched off on this server. The staging administrator must enable OI_RECOGNITION_ENABLED for this preview.',
    recognition_provider_not_configured:'The recognition provider key is missing from this server. The staging administrator must configure ANTHROPIC_API_KEY for this preview.',
    recognition_opening_access_unavailable:'Recognition could not check opening access. Please try again when the server connection is restored.',
    recognition_original_preparation_failed:'The saved originals could not be prepared for analysis. Use Check saved originals without analysis to locate the failure.',
    recognition_recording_unavailable:'Recognition could not save its evidence. No suggestion was applied. The staging administrator must check recognition storage.',
    recognition_provider_authentication_failed:'The recognition provider rejected the server API key. The staging administrator must verify its Anthropic credential. Your app login is unaffected.',
    recognition_provider_permission_denied:'The recognition provider denied this server permission to use the API. The staging administrator must check provider access.',
    recognition_provider_model_unavailable:'The configured recognition model is unavailable to this server. The staging administrator must check model access.',
    recognition_provider_rate_limited:'The recognition provider has reached a usage rate limit. Wait before trying again.',
    recognition_provider_image_rejected:'The recognition provider rejected the image size. Try a smaller JPEG or PNG photograph.',
    recognition_provider_usage_limit_reached:'Recognition is paused because the AI provider’s API usage limit has been reached. The account owner must review the API spending limits before testing again.',
    recognition_provider_billing_blocked:'The recognition provider reports an API credit or spending limit problem. The provider account owner must check API billing and limits.',
    recognition_provider_image_format_rejected:'The recognition provider could not decode an image or rejected its format. No identification was returned.',
    recognition_provider_image_dimensions_rejected:'The recognition provider rejected an image’s dimensions. The staging image preparation needs correction.',
    recognition_provider_context_limit:'The recognition request exceeded the provider’s input limit. The staging request preparation needs correction.',
    recognition_provider_request_rejected:'The recognition provider rejected the request format or content. The staging administrator must check the image request.',
    recognition_provider_temporarily_unavailable:'The recognition provider is temporarily unavailable. Please try again later.',
    recognition_provider_invalid_response:'The recognition provider returned an unreadable identification. No suggestion was applied.',
    recognition_provider_timeout:'The recognition provider did not finish within the analysis time limit. Please try again.',
    recognition_provider_connection_failed:'The server could not connect to the recognition provider. The staging administrator must check provider connectivity.',
    recognition_engine_failed:'The server could not process the recognition response. The staging administrator must check the recognition engine.',
    recognition_run_interrupted:'Analysis was interrupted before a final result was saved. Any saved photo readings are retained for review. Do not retry this test yet.',
    recognition_provider_failed:'The recognition provider could not complete the request. No suggestion was applied.',
    recognition_unavailable:'Photograph recognition is unavailable on this server. No suggestion was applied.',
  };
  return messages[code]||code;
}

export function RecognitionReview({openingId,attributes={},onUse,onComponentType,onRun,onFilesChange,onBusyChange}:{openingId:string;onRun?:(runId:string)=>void;onComponentType?:(type:string,runId:string)=>boolean;attributes?:Record<string,string>;onBusyChange?:(busy:boolean)=>void;onFilesChange:(files:File[])=>void;onUse:(manufacturer:string,model:string,runId:string,componentType:string|null)=>void}) {
  const [files,setFiles]=useState<File[]>([]);
  const [providerDiagnostic,setProviderDiagnostic]=useState('');
  const [progress,setProgress]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [result,setResult]=useState<Record<string,unknown>|null>(null);
  const [response,setResponse]=useState<any>(null);
  const [markings,setMarkings]=useState('');
  const [features,setFeatures]=useState('');
  const generation=useRef(0);
  const fileInput=useRef<HTMLInputElement>(null);
  const originalSources=useRef<{openingId:string;ids:string[]}|null>(null);
  const [savedOriginalCount,setSavedOriginalCount]=useState(0);
  const [savedOriginalMediaType,setSavedOriginalMediaType]=useState('');
  const [originalCheck,setOriginalCheck]=useState<any>(null);
  const [savedPreviews,setSavedPreviews]=useState<{photoId:string;url:string}[]>([]);
  const [availability,setAvailability]=useState<{build_sha?:string;available:boolean;blocking_reasons:string[];reason:string|null;reference_comparison_enabled:boolean;original_photo_input_available?:boolean;maximum_original_bytes?:number;maximum_original_set_bytes?:number}|null>(null);
  const originalsEnabled=availability?.original_photo_input_available===true;
  const selectedBytes=files.reduce((n,f)=>n+f.size,0);
  const selectionError=files.length>5?'Select at most five photographs of the same component.':originalsEnabled?(files.length>0&&files.length<3?'Select at least three views: maker mark, identifying detail and full device.':files.some(f=>f.size>(availability?.maximum_original_bytes||0))||selectedBytes>(availability?.maximum_original_set_bytes||0)?'Original photographs exceed the bounded upload limits (12 MB each, 40 MB combined).':''):selectedBytes>2*1024*1024?'The combined photograph limit is 2 MB on this build.':'';
  const [typeApplied,setTypeApplied]=useState(false);
  useEffect(()=>()=>{generation.current++;},[openingId]);
  useEffect(()=>{originalSources.current=null;setSavedOriginalCount(0);setSavedPreviews([]);},[openingId]);
  useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
  const [availabilityError,setAvailabilityError]=useState('');
  useEffect(()=>{
    let active=true;
    setAvailability(null);setAvailabilityError('');
    fetchRecognitionAvailability().then(value=>{if(active)setAvailability(value);}).catch(e=>{if(active)setAvailabilityError(recognitionFailureMessage(e instanceof Error?e.message:'Recognition availability could not be checked.'));});
    return ()=>{active=false;};
  },[openingId]);
  async function ensureOriginalUploads(current:number){
    if(originalSources.current?.openingId===openingId)return originalSources.current.ids;
    if(!files.length)throw Error('Select at least three photographs.');
    if(selectionError)throw Error(selectionError);
    if(!['image/jpeg','image/png','image/webp'].includes(files[0].type)||files.some(f=>f.type!==files[0].type))throw Error('Use JPEG, PNG or WebP photographs of the same format.');
    if(originalSources.current?.openingId!==openingId){
      const ids=await uploadRecognitionOriginals(openingId,files,await getOrCreateDeviceId(),message=>{if(current===generation.current)setProgress(message);});
      if(current!==generation.current)throw Error('Photo selection changed during upload.');
      originalSources.current={openingId,ids};
    }
    setSavedOriginalCount(originalSources.current!.ids.length);
    setSavedOriginalMediaType(files[0].type);
    onFilesChange([]);
    return originalSources.current!.ids;
  }
  async function saveOriginals(){
    const current=++generation.current;
    setError('');setProviderDiagnostic('');setProgress('Saving originals…');setBusy(true);
    try{
      if(!originalsEnabled)throw Error('Original photo upload is unavailable.');
      await ensureOriginalUploads(current);
      if(current===generation.current)setProgress('Original photos saved. No AI analysis was run.');
    }catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Original photo upload failed.');}
    finally{if(current===generation.current)setBusy(false);}
  }
  async function checkOriginals(){
    const current=++generation.current;originalSources.current=null;setSavedOriginalCount(0);setSavedOriginalMediaType('');setSavedPreviews([]);setBusy(true);setError('');setOriginalCheck(null);setProgress('Checking saved originals — no AI call…');
    try{const checked=await checkSavedRecognitionOriginals(openingId);if(current===generation.current){
      setOriginalCheck(checked);
      if(checked.ok&&Array.isArray(checked.sources)&&checked.sources.length>=3&&checked.sources.length<=5&&['image/jpeg','image/png','image/webp'].includes(checked.media_type)){
        originalSources.current={openingId,ids:checked.sources.map((s:any)=>s.photo_id)};
        setSavedOriginalCount(checked.sources.length);setSavedOriginalMediaType(checked.media_type);
        setFiles([]);if(fileInput.current)fileInput.current.value='';onFilesChange([]);
        const previews=await Promise.all(checked.sources.map(async(s:any)=>({photoId:s.photo_id,url:(await fetchPhotoAccessUrl(s.photo_id)).url})));
        if(current===generation.current)setSavedPreviews(previews);
      }
    }}
    catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Original check failed.');}
    finally{if(current===generation.current)setBusy(false);}
  }
  async function reviewSaved(){
    const current=++generation.current;setBusy(true);setError('');setProgress('Reviewing saved evidence — no AI charge…');
    setFiles([]);setSavedPreviews([]);setSavedOriginalCount(0);originalSources.current=null;onFilesChange([]);if(fileInput.current)fileInput.current.value='';
    try{const saved=await fetchSavedRecognitionReview(openingId);if(current===generation.current){setResult(saved.suggestion);setResponse(saved);setTypeApplied(false);}}
    catch(e){if(current===generation.current)setError(recognitionFailureMessage(e instanceof Error?e.message:'recognition_history_unavailable'));}
    finally{if(current===generation.current)setBusy(false);}
  }
  async function analyze(){
    const current=++generation.current;
    setTypeApplied(false);setError('');setProviderDiagnostic('');setResult(null);setResponse(null);setProgress('');setBusy(true);
    try{
      if(availability?.build_sha&&availability.build_sha!==import.meta.env.VITE_OI_BUILD_SHA)throw Error('recognition_client_update_required');
      const restored=originalsEnabled&&originalSources.current?.openingId===openingId;
      if(!files.length&&!restored)throw Error('Select one to five photographs.');
      if(selectionError)throw Error(selectionError);
      const mediaType=files[0]?.type||savedOriginalMediaType;
      if(!['image/jpeg','image/png','image/webp'].includes(mediaType)||files.some(f=>f.type!==mediaType))throw Error('Use JPEG, PNG or WebP photographs of the same format.');
      let photoIds:string[]|undefined;
      if(originalsEnabled){
       photoIds=await ensureOriginalUploads(current);
      }
      const images=originalsEnabled?[]:await Promise.all(files.map(f=>new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();reader.onerror=()=>reject(Error('Could not read photograph.'));
        reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(f);
      })));
      const response=await recognizeHardware(openingId,images,mediaType,{...attributes,visible_markings:markings,observed_features:features},message=>{if(current===generation.current)setProgress(message||'Retrieving saved analysis…');},photoIds);
      if(current===generation.current){
        setResult(response.suggestion);setResponse(response);
        const componentType=photographedComponentTypes[String(response.suggestion.component_class||'')];
        if(componentType)setTypeApplied(onComponentType?.(componentType,response.run_id)===true);
        onRun?.(response.run_id);
      }
    }catch(e){if(current===generation.current){setError(recognitionFailureMessage(e instanceof Error&&e.message?e.message:'recognition_provider_failed'));setProviderDiagnostic(typeof (e as any)?.providerDiagnostic==='string'?(e as any).providerDiagnostic:'');}}
    finally{if(current===generation.current)setBusy(false);}
  }
  const text=(key:string)=>typeof result?.[key]==='string'?String(result[key]):'';
  const labelReads:any[]=(result?.label_reading as any)?.reads||[];
  const labelTexts=[...new Set(labelReads.map(read=>read.vision_text?.trim()).filter(Boolean))] as string[];
  const agreedTexts=[...new Set(labelReads.flatMap(read=>read.agreed_markings||[]))] as string[];
  return <section className="card" aria-label="Photograph recognition" onKeyDown={e=>{if(e.key==='Enter'&&e.target instanceof HTMLInputElement&&e.target.type!=='file')e.preventDefault();}}>
    <h2>Identify from photographs</h2>
    <p>Photograph one component from several views: maker mark, identifying detail and full device. Review the suggestion before using it.</p>
    {originalsEnabled&&<p>Capture at least three views. If the maker mark cannot be read, leave the brand unresolved rather than guessing.</p>}
    {!availability&&!availabilityError&&<p role="status">Checking recognition availability…</p>}
    {availabilityError&&<p role="alert">{availabilityError}</p>}
    {availability&&!availability.available&&<div role="alert">{(availability.blocking_reasons||[availability.reason||'recognition_unavailable']).map(reason=><p key={reason}>{recognitionFailureMessage(reason)}</p>)}</div>}
    <p>App build: <code>{import.meta.env.VITE_OI_BUILD_SHA}</code></p>
    {availability?.available&&!availability.reference_comparison_enabled&&<p>Photograph recognition is available. Manufacturer reference comparison is switched off on this server.</p>}
    <label>Reported model or readable markings<input value={markings} maxLength={300} disabled={busy} onChange={e=>{setMarkings(e.target.value);setResult(null);setResponse(null);}} placeholder="e.g. CR441 or Cal-Royal CR441"/></label>
    <label>Observed features or measurements<input value={features} maxLength={300} onChange={e=>setFeatures(e.target.value)}/></label>
    <input ref={fileInput} aria-label="Recognition photographs" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={e=>{generation.current++;originalSources.current=null;setSavedOriginalCount(0);setSavedPreviews([]);setProgress('');const selected=Array.from(e.target.files||[]).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);setFiles(selected);onFilesChange(originalsEnabled?[]:selected);setResult(null);setResponse(null);setError('');setProviderDiagnostic('');}}/>
    {files.length>0&&<div aria-label="Selected photograph files">
      <p>Total: <strong>{selectedBytes.toLocaleString()} bytes</strong> ({(selectedBytes/1024/1024).toFixed(2)} MB). {originalsEnabled?'Original upload limit: 12 MB each, 40 MB combined.':'Combined limit: 2 MB.'}</p>
      <ol>{files.map((file,i)=><li key={i}>{file.name} — {file.size.toLocaleString()} bytes</li>)}</ol>
      <button type="button" disabled={busy} onClick={()=>{generation.current++;originalSources.current=null;setSavedOriginalCount(0);setSavedPreviews([]);setProgress('');if(fileInput.current)fileInput.current.value='';setFiles([]);onFilesChange([]);setResult(null);setResponse(null);setError('');setProviderDiagnostic('');}}>Clear selected photographs</button>
    </div>}
    {selectionError&&<p role="alert">{selectionError}</p>}
    {originalsEnabled&&<button type="button" disabled={busy} onClick={checkOriginals}>Check saved originals without analysis</button>}
    {originalCheck&&<p role={originalCheck.ok?'status':'alert'}>{originalCheck.ok?`${originalCheck.photo_count} originals downloaded, checksummed and prepared successfully.`:`Original check failed at ${originalCheck.stage}: ${originalCheck.reason}.`} No AI call was made.</p>}
    {originalsEnabled&&<button type="button" disabled={busy||!files.length||!!selectionError||savedOriginalCount===files.length} onClick={saveOriginals}>Save original photos without analysis</button>}
    {originalsEnabled&&savedOriginalCount>0&&<p role="status">{savedOriginalCount} original photos saved privately to this opening. Analyze uses this same saved set.</p>}
    {!!savedPreviews.length&&<section aria-label="Exact saved recognition photographs">
      <h3>Saved photographs used for recognition</h3>
      <p>These are the original stored photographs in submission order. No AI call is made to display them.</p>
      {savedPreviews.map((photo,i)=><figure key={photo.photoId}>
        <img src={photo.url} alt={`Saved recognition photograph ${i+1}`} style={{maxWidth:'100%',maxHeight:480,objectFit:'contain'}} referrerPolicy="no-referrer"/>
        <figcaption>Photo {i+1}</figcaption>
      </figure>)}
    </section>}
    <button type="button" disabled={busy} onClick={reviewSaved}>Review saved analysis without AI</button>
    <button type="button" disabled={busy||(!files.length&&!(savedOriginalCount>0&&originalSources.current?.openingId===openingId))||!!selectionError||!availability?.available} onClick={analyze}>{busy?progress||'Analyzing…':'Analyze photographs'}</button>
    {error&&<p role="alert">{error}</p>}
    {providerDiagnostic&&<p>Administrator diagnostic: {providerDiagnostic}</p>}
    {files.length>0&&<p role="status">{files.length} photograph{files.length===1?"":"s"} selected — {originalsEnabled?'originals are saved privately to this opening before analysis.':'will attach when you save this hardware.'}</p>}
    {result&&<div>
      {response?.derived_saved_evidence&&<p>Saved evidence reviewed without a new AI call. Original build: {response.source_build_sha}; review build: {response.review_build_sha}. The original test result is unchanged.</p>}
      {!!result.catalog_identity_review&&<CatalogIdentityEvidence review={result.catalog_identity_review as CatalogReview} files={response?.derived_saved_evidence?[]:files} identified={result.identity_basis==='readable_maker_and_exact_catalog_model'}/>}
      {onComponentType&&photographedComponentTypes[text('component_class')]&&<p>Photograph component type: <strong>{photographedComponentTypes[text('component_class')].replace(/_/g,' ')}</strong>. {typeApplied?'Component type filled automatically. You can change it below.':'Your selected component type was preserved. You can change it below.'}</p>}
      {response?.reported_identity&&<p>Technician-reported product: <strong>{response.reported_identity.manufacturer} {response.reported_identity.model}</strong> — awaiting verification.</p>}
      {labelReads.some(read=>read.ocr_model_conflicts?.length>0)&&<p role="alert">The readers disagree on model characters. The candidate is retained for your review; verify the label before accepting it. OCR alternatives: {[...new Set(labelReads.flatMap(read=>read.ocr_model_conflicts||[]))].join(', ')}.</p>}
      {response?.label_candidate&&!text('model')&&<p>Label candidate: <strong>{response.label_candidate.manufacturer} {response.label_candidate.model||`${response.label_candidate.series} family`}</strong> — single AI reader; technician verification required.{response.label_candidate.manufacturer_basis==='catalog_model_match'&&' Manufacturer suggested by the catalog model match; manufacturer marking not confirmed.'}{response.label_candidate.manufacturer_basis==='catalog_partial_model_match'&&` Partial marking: ${response.label_candidate.transcribed_marking}. Catalog candidate suggested from readable characters; missing characters and manufacturer marking require verification.`}</p>}
      {response?.label_candidates?.length>1&&<div><p>Partial markings match several catalog products. Reference comparison follows; no exact model selected.</p><ul>{response.label_candidates.map((c:any,i:number)=><li key={i}>{c.manufacturer} {c.model||c.catalog_model||c.series} — read: {c.transcribed_marking||'partial marking'}</li>)}</ul></div>}
      <p>Photograph suggestion: {text('model')?`${text('manufacturer')} ${text('model')}`:text('series')?`${text('manufacturer')} ${text('series')} family — exact model unconfirmed.`:text('manufacturer')?`${text('manufacturer')} — exact model unconfirmed.`:response?.label_candidate?'The model marking supports the candidate above; technician verification is pending.':'Exact manufacturer and model not confirmed from this photograph.'}</p>
      {(result.label_reading as any)?.status==='partial'&&<p role="status">Label reading did not finish successfully. Missing text does not mean the label is unreadable.</p>}
      {(result.label_reading as any)?.status==='unavailable'&&<p role="status">Label reading could not complete. Photograph analysis remains available.</p>}
      {(result.label_reading as any)?.status==='no_regions'&&<p>No product label was located in this photograph.</p>}
      {(result.label_reading as any)?.locator_preprocessing?.enlarged_views>0&&<p>Full photograph enlarged automatically before locating the label. Original photograph preserved.</p>}
      {(result.label_reading as any)?.enhancement?.regions>0&&<p>Label visibility enhanced automatically with contrast and sharpening. Original photograph preserved.</p>}
      {!!labelReads.length&&<section aria-label="Label readings"><h3>Label readings</h3>{agreedTexts.length>0?<p>Two readers agree on: <strong>{agreedTexts.join(', ')}</strong></p>:labelTexts.length>0?<p>Unverified AI transcription: <strong>{labelTexts.join('; ')}</strong>. These readings support the identity proposal above only where the evidence checks pass. Review excluded readings and verify the displayed identity before recording it. {labelConfirmationMessage(labelReads)}</p>:<p>No reliable marking was read from these image regions.</p>}<details><summary>Reader details</summary>{labelReads.map((read:any,i:number)=><div key={i}><p>{read.region?.kind==='search_tile'?'Search area':'Detected marking area'} {i+1}</p><p>OCR: {read.ocr_text||(read.ocr_status==='timeout'?'Timed out':read.ocr_status==='unavailable'?'Reader unavailable':read.ocr_status==='not_attempted'?'Not attempted':'Unreadable')}{read.ocr_scope==='model_line'&&' (focused model line)'}</p>{read.vision_initial_text&&<p>Initial AI read: {read.vision_initial_text}. Focused reread follows; these are the same reader.</p>}<p>AI: {visionReadMessage(read)}</p></div>)}</details></section>}
      {(result.installation_geometry as any)&&<section aria-label="Installation geometry"><h3>Installation-sheet comparison</h3>{!(result.installation_geometry as any).candidates?.length&&<p>No dimensional match.</p>}{(result.installation_geometry as any).candidates?.length>0&&<p>Based on the visible mounting pattern, this closer may be one of the following. Other models may share this pattern.</p>}<p>{(result.installation_geometry as any).limitation}</p>{(result.installation_geometry as any).candidates?.length>0&&<ul>{(result.installation_geometry as any).candidates.map((c:any,i:number)=><li key={i}>{c.manufacturer} {c.model} — compatible shared mounting pattern</li>)}</ul>}{(result.installation_geometry as any).candidates?.length>0&&<details><summary>Verified drawing dimensions</summary>{(result.installation_geometry as any).reference_dimensions?.map((s:any,i:number)=><p key={i}>{s.manufacturer} {s.models.join(' / ')}: horizontal hole intervals 1–3–1 inches; row separation 2¼ inches. {s.mount}; installation sheet page {s.page_no}, {s.drawing}. These are reference dimensions, not measurements of your photo.</p>)}</details>}</section>}
      {text('component_class')==='DOOR_CLOSER'&&<section aria-label="Closer arm analysis"><h3>Arm analysis</h3><p>Arm type: {String((result.attributes as any)?.arm_type||'unconfirmed').replace(/_/g,' ')}. Mounting: {String((result.attributes as any)?.mounting||'unconfirmed').replace(/_/g,' ')}.</p><ul>{((result.evidence as any[])||[]).filter(e=>['arm_type','mounting'].includes(e.supports)).map((e,i)=><li key={i}>{String(e.observation)}</li>)}</ul><p>These observed features support comparison; they do not uniquely identify the manufacturer or model.</p></section>}
      <details><summary>Recognition evidence</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(result,null,2)}</pre></details>
      {response&&<ReferenceEvidence run={response}/>}
      {response?.build_sha&&<p>Recognition build: <code>{response.build_sha}</code></p>}
      <button type="button" disabled={response?.derived_saved_evidence||(!text('model')&&!response?.label_candidate?.model)||['CONFLICT','TYPE_CONFLICT'].includes((result?.catalog_identity_review as any)?.status)} onClick={()=>onUse(text('model')?text('manufacturer'):response?.label_candidate?.manufacturer||'',text('model')||response?.label_candidate?.model||'',response?.run_id||'',photographedComponentTypes[text('component_class')]||null)}>{text('model')?'Use photograph suggestion for technician review':'Use complete label candidate for technician review'}</button>
      {response?.shadow_mode&&<p>Staging analysis. A suggestion fills the review form only; acknowledge or correct the installed identity before saving.</p>}
      {response?.reported_identity&&<p>Enter or correct the installed manufacturer and model below, then acknowledge the identity. Your confirmation remains linked to this run.</p>}
      <p>Identity and review remain pending until you verify them. This does not approve a purchase.</p>
    </div>}
  </section>;
}
