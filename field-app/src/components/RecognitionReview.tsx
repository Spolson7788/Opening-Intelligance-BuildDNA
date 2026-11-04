import {useEffect,useRef,useState} from 'react';
import {listOpeningPhotos,startRecognitionRun,type RecognitionRun,type StoredPhoto, serverFeatures } from '../lib/api';

// Recognition runs on photographs already saved to this opening (stored originals), never on files
// picked here. Each attempt is a recorded run; a refused or failed run shows its reason.
const REASONS:Record<string,string>={
  budget_exceeded:'Your company has used its recognition budget for this month.',
  budget_not_configured:'Recognition is not set up for your company yet.',
  stored_original_checksum_mismatch:'A saved photograph did not match its record. Recognition was not run.',
  stored_original_unreadable:'A saved photograph could not be read. Recognition was not run.',
  downscale_unavailable:'A large photograph could not be prepared. Recognition was not run.',
};
export const recognitionReason=(run:Pick<RecognitionRun,'status'|'failure_code'>)=>run.failure_code?(REASONS[run.failure_code]??`Recognition did not complete (${run.failure_code}).`):'';
export const usablePhotos=(rows:StoredPhoto[])=>rows.filter(p=>p.media_type==='photo'&&['verified','legacy_confirmed'].includes(p.upload_state)&&['image/jpeg','image/png','image/webp'].includes(p.content_type??''));

export function RecognitionReview({openingId,onUse}:{openingId:string;onUse:(manufacturer:string,model:string)=>void}) {
  const [photos,setPhotos]=useState<StoredPhoto[]|null>(null);
  const [selected,setSelected]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [run,setRun]=useState<RecognitionRun|null>(null);
  const generation=useRef(0);
  const [enabled,setEnabled]=useState(false);
  useEffect(()=>{let live=true;serverFeatures().then(f=>{if(live)setEnabled(f.recognition);});return()=>{live=false;};},[]);
  useEffect(()=>{let live=true;listOpeningPhotos(openingId).then(r=>{if(live)setPhotos(usablePhotos(r));}).catch(()=>{if(live)setPhotos([]);});return()=>{live=false;};},[openingId]);
  function toggle(id:string){generation.current++;setRun(null);setError('');setSelected(s=>s.includes(id)?s.filter(x=>x!==id):s.length>=5?s:[...s,id]);}
  async function analyze(){
    const current=++generation.current;
    setError('');setRun(null);setBusy(true);
    try{
      const chosen=(photos??[]).filter(p=>selected.includes(p.id));
      if(!chosen.length||chosen.length>5)throw Error('Select one to five saved photographs.');
      if(chosen.some(p=>p.content_type!==chosen[0].content_type))throw Error('Select saved photographs of the same format.');
      const response=await startRecognitionRun(openingId,chosen.map(p=>p.id),crypto.randomUUID());
      if(current===generation.current)setRun(response.run);
    }catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Recognition unavailable.');}
    finally{if(current===generation.current)setBusy(false);}
  }
  const ok=run&&(run.status==='succeeded'||run.status==='abstained');
  if(!enabled)return null;
  return <section className="card" aria-label="Photograph recognition">
    <h2>Identify from saved photographs</h2>
    <p>Choose up to five saved photographs of the same component. Save photographs to this opening first. Review the suggestion before using it.</p>
    {photos===null?<p>Loading saved photographs…</p>:!photos.length?<p>No saved photographs on this opening yet.</p>:
      <ul aria-label="Saved photographs">{photos.map(p=><li key={p.id}><label>
        <input type="checkbox" checked={selected.includes(p.id)} disabled={busy||(!selected.includes(p.id)&&selected.length>=5)} onChange={()=>toggle(p.id)}/>
        {p.original_filename||'Photograph'} · {new Date(p.created_at).toLocaleString()}</label></li>)}</ul>}
    <button type="button" disabled={busy||!selected.length} onClick={analyze}>{busy?'Analyzing…':'Analyze photographs'}</button>
    {error&&<p role="alert">{error}</p>}
    {run&&!ok&&<p role="alert">{recognitionReason(run)}</p>}
    {run&&ok&&<div>
      <p>Manufacturer: {run.manufacturer||'Not established'} · Series: {run.series||'Not established'} · Model: {run.model||'Not established'}</p>
      <details><summary>Recognition evidence</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(run.result,null,2)}</pre></details>
      {run.status==='succeeded'&&<button type="button" onClick={()=>onUse(run.manufacturer||'',run.model||'')}>Use suggestion for technician review</button>}
      <p>Identity and review remain pending until you verify them. This does not approve a purchase.</p>
    </div>}
  </section>;
}
