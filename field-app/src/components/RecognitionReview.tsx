import {useRef,useState} from 'react';
import {recognizeHardware} from '../lib/api';

export function RecognitionReview({openingId,onUse}:{openingId:string;onUse:(manufacturer:string,model:string)=>void}) {
  const [files,setFiles]=useState<File[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [result,setResult]=useState<Record<string,unknown>|null>(null);
  const generation=useRef(0);
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
      const response=await recognizeHardware(openingId,images,files[0].type);
      if(current===generation.current)setResult(response.suggestion);
    }catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Recognition unavailable.');}
    finally{if(current===generation.current)setBusy(false);}
  }
  const text=(key:string)=>typeof result?.[key]==='string'?String(result[key]):'';
  return <section className="card" aria-label="Photograph recognition">
    <h2>Identify from photographs</h2>
    <p>Photograph the same component from up to five views. Review the suggestion before using it. Save photographs to the component record separately.</p>
    <input aria-label="Recognition photographs" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy} onChange={e=>{generation.current++;setFiles(Array.from(e.target.files||[]));setResult(null);setError('');}}/>
    <button type="button" disabled={busy||!files.length} onClick={analyze}>{busy?'Analyzing…':'Analyze photographs'}</button>
    {error&&<p role="alert">{error}</p>}
    {result&&<div>
      <p>Manufacturer: {text('manufacturer')||'Not established'} · Series: {text('series')||'Not established'} · Model: {text('model')||'Not established'}</p>
      <details><summary>Recognition evidence</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(result,null,2)}</pre></details>
      <button type="button" onClick={()=>onUse(text('manufacturer'),text('model'))}>Use suggestion for technician review</button>
      <p>Identity and review remain pending until you verify them. This does not approve a purchase.</p>
    </div>}
  </section>;
}
