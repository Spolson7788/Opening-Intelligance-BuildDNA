import {useEffect,useRef,useState} from 'react';
import {fetchRecognitionAvailability,recognizeHardware} from '../lib/api';
import {ReferenceEvidence} from './ReferenceEvidence';

const photographedComponentTypes:Record<string,string>={DOOR_CLOSER:'closer',EXIT_DEVICE:'exit_device',LOCKSET:'lockset',HINGE_BUTT:'hinge',HINGE_CONT:'hinge',FLUSH_BOLT:'other',ELECTRIC_STRIKE:'electric_strike',POWER_TRANSFER:'power_transfer'};

export function recognitionFailureMessage(code:string){
  const messages:Record<string,string>={
    request_failed_504:'Analysis took too long and the server stopped the request. No identification result was returned. Your selected photograph remains available.',
    recognition_result_missing:'The server returned no usable analysis result. No identification was applied. Your selected photograph remains available.',
    recognition_saved_result_not_found:'The connection timed out and no saved result was found for this request. Your photograph remains selected. No analysis was retried automatically.',
    recognition_disabled:'Photograph recognition is switched off on this server. The staging administrator must enable OI_RECOGNITION_ENABLED for this preview.',
    recognition_provider_not_configured:'The recognition provider key is missing from this server. The staging administrator must configure ANTHROPIC_API_KEY for this preview.',
    recognition_opening_access_unavailable:'Recognition could not check opening access. Please try again when the server connection is restored.',
    recognition_recording_unavailable:'Recognition could not save its evidence. No suggestion was applied. The staging administrator must check recognition storage.',
    recognition_provider_authentication_failed:'The recognition provider rejected the server API key. The staging administrator must verify its Anthropic credential. Your app login is unaffected.',
    recognition_provider_permission_denied:'The recognition provider denied this server permission to use the API. The staging administrator must check provider access.',
    recognition_provider_model_unavailable:'The configured recognition model is unavailable to this server. The staging administrator must check model access.',
    recognition_provider_rate_limited:'The recognition provider has reached a usage rate limit. Wait before trying again.',
    recognition_provider_image_rejected:'The recognition provider rejected the image size. Try a smaller JPEG or PNG photograph.',
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
    recognition_provider_failed:'The recognition provider could not complete the request. No suggestion was applied.',
    recognition_unavailable:'Photograph recognition is unavailable on this server. No suggestion was applied.',
  };
  return messages[code]||code;
}

export function RecognitionReview({openingId,attributes={},onUse,onFilesChange,onBusyChange}:{openingId:string;attributes?:Record<string,string>;onBusyChange?:(busy:boolean)=>void;onFilesChange:(files:File[])=>void;onUse:(manufacturer:string,model:string,runId:string,componentType:string|null)=>void}) {
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
  useEffect(()=>{onBusyChange?.(busy);},[busy,onBusyChange]);
  const [availability,setAvailability]=useState<{available:boolean;blocking_reasons:string[];reason:string|null;reference_comparison_enabled:boolean}|null>(null);
  const [availabilityError,setAvailabilityError]=useState('');
  useEffect(()=>{
    let active=true;
    setAvailability(null);setAvailabilityError('');
    fetchRecognitionAvailability().then(value=>{if(active)setAvailability(value);}).catch(e=>{if(active)setAvailabilityError(recognitionFailureMessage(e instanceof Error?e.message:'Recognition availability could not be checked.'));});
    return ()=>{active=false;};
  },[openingId]);
  async function analyze(){
    const current=++generation.current;
    setError('');setProviderDiagnostic('');setResult(null);setResponse(null);setProgress('');setBusy(true);
    try{
      if(!files.length||files.length>5||files.reduce((n,f)=>n+f.size,0)>2*1024*1024)throw Error('Select one to five photographs, totaling at most 2 MB.');
      if(!['image/jpeg','image/png','image/webp'].includes(files[0].type)||files.some(f=>f.type!==files[0].type))throw Error('Use JPEG, PNG or WebP photographs of the same format.');
      const images=await Promise.all(files.map(f=>new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();reader.onerror=()=>reject(Error('Could not read photograph.'));
        reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(f);
      })));
      const response=await recognizeHardware(openingId,images,files[0].type,{...attributes,visible_markings:markings,observed_features:features},()=>{if(current===generation.current)setProgress('Retrieving saved analysis…');});
      if(current===generation.current){setResult(response.suggestion);setResponse(response);}
    }catch(e){if(current===generation.current){setError(recognitionFailureMessage(e instanceof Error&&e.message?e.message:'recognition_provider_failed'));setProviderDiagnostic(typeof (e as any)?.providerDiagnostic==='string'?(e as any).providerDiagnostic:'');}}
    finally{if(current===generation.current)setBusy(false);}
  }
  const text=(key:string)=>typeof result?.[key]==='string'?String(result[key]):'';
  const labelReads:any[]=(result?.label_reading as any)?.reads||[];
  const labelTexts=[...new Set(labelReads.map(read=>read.vision_text?.trim()).filter(Boolean))] as string[];
  const agreedTexts=[...new Set(labelReads.flatMap(read=>read.agreed_markings||[]))] as string[];
  return <section className="card" aria-label="Photograph recognition" onKeyDown={e=>{if(e.key==='Enter'&&e.target instanceof HTMLInputElement&&e.target.type!=='file')e.preventDefault();}}>
    <h2>Identify from photographs</h2>
    <p>Photograph the same component from up to five views. Review the suggestion before using it. Selected photographs are attached automatically when you save the hardware.</p>
    {!availability&&!availabilityError&&<p role="status">Checking recognition availability…</p>}
    {availabilityError&&<p role="alert">{availabilityError}</p>}
    {availability&&!availability.available&&<div role="alert">{(availability.blocking_reasons||[availability.reason||'recognition_unavailable']).map(reason=><p key={reason}>{recognitionFailureMessage(reason)}</p>)}</div>}
    {availability?.available&&!availability.reference_comparison_enabled&&<p>Photograph recognition is available. Manufacturer reference comparison is switched off on this server.</p>}
    <label>Reported model or readable markings<input value={markings} maxLength={300} disabled={busy} onChange={e=>{setMarkings(e.target.value);setResult(null);setResponse(null);}} placeholder="e.g. CR441 or Cal-Royal CR441"/></label>
    <label>Observed features or measurements<input value={features} maxLength={300} onChange={e=>setFeatures(e.target.value)}/></label>
    <input aria-label="Recognition photographs" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={e=>{generation.current++;const selected=Array.from(e.target.files||[]);setFiles(selected);onFilesChange(selected);setResult(null);setError('');}}/>
    <button type="button" disabled={busy||!files.length||!availability?.available} onClick={analyze}>{busy?progress||'Analyzing…':'Analyze photographs'}</button>
    {error&&<p role="alert">{error}</p>}
    {providerDiagnostic&&<p>Administrator diagnostic: {providerDiagnostic}</p>}
    {files.length>0&&<p role="status">{files.length} photograph{files.length===1?"":"s"} selected — will attach when you save this hardware.</p>}
    {result&&<div>
      {response?.reported_identity&&<p>Technician-reported product: <strong>{response.reported_identity.manufacturer} {response.reported_identity.model}</strong> — awaiting verification.</p>}
      {response?.label_candidate&&!text('model')&&<p>Label candidate: <strong>{response.label_candidate.manufacturer} {response.label_candidate.model||`${response.label_candidate.series} family`}</strong> — single AI reader; technician verification required.{response.label_candidate.manufacturer_basis==='catalog_model_match'&&' Manufacturer suggested by the catalog model match; manufacturer marking not confirmed.'}{response.label_candidate.manufacturer_basis==='catalog_partial_model_match'&&` Partial marking: ${response.label_candidate.transcribed_marking}. Catalog candidate suggested from readable characters; missing characters and manufacturer marking require verification.`}</p>}
      {response?.label_candidates?.length>1&&<div><p>Partial markings match several catalog products. Reference comparison follows; no exact model selected.</p><ul>{response.label_candidates.map((c:any,i:number)=><li key={i}>{c.manufacturer} {c.model||c.series} — read: {c.transcribed_marking||'partial marking'}</li>)}</ul></div>}
      <p>Photograph suggestion: {text('model')?`${text('manufacturer')} ${text('model')}`:text('series')?`${text('manufacturer')} ${text('series')} family — exact model unconfirmed.`:text('manufacturer')?`${text('manufacturer')} — exact model unconfirmed.`:response?.label_candidate?'The model marking supports the candidate above; technician verification is pending.':'Exact manufacturer and model not confirmed from this photograph.'}</p>
      {(result.label_reading as any)?.status==='unavailable'&&<p role="status">Label reading could not complete. Photograph analysis remains available.</p>}
      {(result.label_reading as any)?.status==='no_regions'&&<p>No product label was located in this photograph.</p>}
      {(result.label_reading as any)?.locator_preprocessing?.enlarged_views>0&&<p>Full photograph enlarged automatically before locating the label. Original photograph preserved.</p>}
      {(result.label_reading as any)?.enhancement?.regions>0&&<p>Label visibility enhanced automatically with contrast and sharpening. Original photograph preserved.</p>}
      {!!labelReads.length&&<section aria-label="Label readings"><h3>Label readings</h3>{agreedTexts.length>0?<p>Two readers agree on: <strong>{agreedTexts.join(', ')}</strong></p>:labelTexts.length>0?<p>AI read: <strong>{labelTexts.join('; ')}</strong>. {labelReads.some((r:any)=>r.ocr_status==='timeout')?'OCR timed out before confirmation; verify the AI reading before using.':labelReads.some((r:any)=>r.ocr_status==='unavailable')?'OCR could not run; verify the AI reading before using.':labelReads.some((r:any)=>r.ocr_status==='read')?'OCR returned different or incomplete characters; verify before using.':'OCR could not read the characters; verify before using.'}</p>:<p>No reliable marking was read from these image regions.</p>}<details><summary>Reader details</summary>{labelReads.map((read:any,i:number)=><div key={i}><p>{read.region?.kind==='search_tile'?'Search area':'Detected marking area'} {i+1}</p><p>OCR: {read.ocr_text||(read.ocr_status==='timeout'?'Timed out':read.ocr_status==='unavailable'?'Reader unavailable':read.ocr_status==='not_attempted'?'Not reached within the time budget':'Unreadable')}{read.ocr_scope==='model_line'&&' (focused model line)'}</p>{read.vision_initial_text&&<p>Initial AI read: {read.vision_initial_text}. Focused reread follows; these are the same reader.</p>}<p>AI: {read.vision_text||'Unreadable'}</p></div>)}</details></section>}
      {(result.installation_geometry as any)&&<section aria-label="Installation geometry"><h3>Installation-sheet comparison</h3>{(result.installation_geometry as any).candidates?.length>0&&<p>Based on the visible mounting pattern, this closer may be one of the following. Other models may share this pattern.</p>}<p>{(result.installation_geometry as any).limitation}</p>{(result.installation_geometry as any).candidates?.length>0&&<ul>{(result.installation_geometry as any).candidates.map((c:any,i:number)=><li key={i}>{c.manufacturer} {c.model} — compatible shared mounting pattern</li>)}</ul>}<details><summary>Verified drawing dimensions</summary>{(result.installation_geometry as any).reference_dimensions?.map((s:any,i:number)=><p key={i}>{s.manufacturer} {s.models.join(' / ')}: horizontal hole intervals 1–3–1 inches; row separation 2¼ inches. {s.mount}; installation sheet page {s.page_no}, {s.drawing}. These are reference dimensions, not measurements of your photo.</p>)}</details></section>}
      {text('component_class')==='DOOR_CLOSER'&&<section aria-label="Closer arm analysis"><h3>Arm analysis</h3><p>Arm type: {String((result.attributes as any)?.arm_type||'unconfirmed').replace(/_/g,' ')}. Mounting: {String((result.attributes as any)?.mounting||'unconfirmed').replace(/_/g,' ')}.</p><ul>{((result.evidence as any[])||[]).filter(e=>['arm_type','mounting'].includes(e.supports)).map((e,i)=><li key={i}>{String(e.observation)}</li>)}</ul><p>These observed features support comparison; they do not uniquely identify the manufacturer or model.</p></section>}
      <details><summary>Recognition evidence</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(result,null,2)}</pre></details>
      {response&&<ReferenceEvidence run={response}/>}
      <button type="button" disabled={!text('model')&&!response?.reported_identity&&!response?.label_candidate} onClick={()=>onUse(text('model')?text('manufacturer'):response?.reported_identity?.manufacturer||response?.label_candidate?.manufacturer||'',text('model')||response?.reported_identity?.model||response?.label_candidate?.model||'',response?.run_id||'',photographedComponentTypes[text('component_class')]||null)}>{text('model')?'Use photograph suggestion for technician review':response?.reported_identity?'Use reported product for technician review':'Use label candidate for technician review'}</button>
      <p>Identity and review remain pending until you verify them. This does not approve a purchase.</p>
    </div>}
  </section>;
}
