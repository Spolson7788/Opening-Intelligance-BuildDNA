import {useEffect,useRef,useState} from 'react';
import {fetchRecognitionAvailability,recognizeHardware} from '../lib/api';
import {ReferenceEvidence} from './ReferenceEvidence';

export function recognitionFailureMessage(code:string){
  const messages:Record<string,string>={
    recognition_disabled:'Photograph recognition is switched off on this server. The staging administrator must enable OI_RECOGNITION_ENABLED for this preview.',
    recognition_provider_not_configured:'The recognition provider key is missing from this server. The staging administrator must configure ANTHROPIC_API_KEY for this preview.',
    recognition_opening_access_unavailable:'Recognition could not check opening access. Please try again when the server connection is restored.',
    recognition_recording_unavailable:'Recognition could not save its evidence. No suggestion was applied. The staging administrator must check recognition storage.',
    recognition_provider_failed:'The recognition provider could not complete the request. No suggestion was applied.',
    recognition_unavailable:'Photograph recognition is unavailable on this server. No suggestion was applied.',
  };
  return messages[code]||code;
}

export function RecognitionReview({openingId,attributes={},onUse}:{openingId:string;attributes?:Record<string,string>;onUse:(manufacturer:string,model:string,runId:string)=>void}) {
  const [files,setFiles]=useState<File[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [result,setResult]=useState<Record<string,unknown>|null>(null);
  const [response,setResponse]=useState<any>(null);
  const [markings,setMarkings]=useState('');
  const [features,setFeatures]=useState('');
  const generation=useRef(0);
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
    setError('');setResult(null);setBusy(true);
    try{
      if(!files.length||files.length>5||files.reduce((n,f)=>n+f.size,0)>2*1024*1024)throw Error('Select one to five photographs, totaling at most 2 MB.');
      if(!['image/jpeg','image/png','image/webp'].includes(files[0].type)||files.some(f=>f.type!==files[0].type))throw Error('Use JPEG, PNG or WebP photographs of the same format.');
      const images=await Promise.all(files.map(f=>new Promise<string>((resolve,reject)=>{
        const reader=new FileReader();reader.onerror=()=>reject(Error('Could not read photograph.'));
        reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(f);
      })));
      const response=await recognizeHardware(openingId,images,files[0].type,{...attributes,visible_markings:markings,observed_features:features});
      if(current===generation.current){setResult(response.suggestion);setResponse(response);}
    }catch(e){if(current===generation.current)setError(recognitionFailureMessage(e instanceof Error?e.message:'Recognition unavailable.'));}
    finally{if(current===generation.current)setBusy(false);}
  }
  const text=(key:string)=>typeof result?.[key]==='string'?String(result[key]):'';
  return <section className="card" aria-label="Photograph recognition">
    <h2>Identify from photographs</h2>
    <p>Photograph the same component from up to five views. Review the suggestion before using it. Save photographs to the component record separately.</p>
    {!availability&&!availabilityError&&<p role="status">Checking recognition availability…</p>}
    {availabilityError&&<p role="alert">{availabilityError}</p>}
    {availability&&!availability.available&&<div role="alert">{(availability.blocking_reasons||[availability.reason||'recognition_unavailable']).map(reason=><p key={reason}>{recognitionFailureMessage(reason)}</p>)}</div>}
    {availability?.available&&!availability.reference_comparison_enabled&&<p>Photograph recognition is available. Manufacturer reference comparison is switched off on this server.</p>}
    <label>Readable markings<input value={markings} maxLength={300} onChange={e=>setMarkings(e.target.value)}/></label>
    <label>Observed features or measurements<input value={features} maxLength={300} onChange={e=>setFeatures(e.target.value)}/></label>
    <input aria-label="Recognition photographs" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={e=>{generation.current++;setFiles(Array.from(e.target.files||[]));setResult(null);setError('');}}/>
    <button type="button" disabled={busy||!files.length||!availability?.available} onClick={analyze}>{busy?'Analyzing…':'Analyze photographs'}</button>
    {error&&<p role="alert">{error}</p>}
    {result&&<div>
      <p>Manufacturer: {text('manufacturer')||'Not established'} · Series: {text('series')||'Not established'} · Model: {text('model')||'Not established'}</p>
      <details><summary>Recognition evidence</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(result,null,2)}</pre></details>
      {response&&<ReferenceEvidence run={response}/>}
      <button type="button" onClick={()=>onUse(text('manufacturer'),text('model'),response?.run_id||'')}>Use suggestion for technician review</button>
      <p>Identity and review remain pending until you verify them. This does not approve a purchase.</p>
    </div>}
  </section>;
}
