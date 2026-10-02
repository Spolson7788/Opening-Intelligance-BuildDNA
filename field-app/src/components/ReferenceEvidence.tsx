import {useEffect,useState} from 'react';
import {fetchRecognitionRuns,fetchReferencePage} from '../lib/api';
export function ReferenceEvidence({run}:{run:any}){
 const [page,setPage]=useState<any>(null),[error,setError]=useState('');
 async function open(c:any){setPage(null);setError('');try{setPage((await fetchReferencePage(c.doc_sha256,c.page_no)).page);}catch{setError('Reference unavailable. It may have been withdrawn or superseded.');}}
 return <section aria-label="Manufacturer reference evidence">
  <p>{run.status==='reference_evidence'?'Manufacturer reference evidence — technician review required':'No reference evidence — preliminary photograph analysis only'}</p>
  {(run.citations||[]).map((c:any,i:number)=><div key={i}><button type="button" onClick={()=>open(c)}>Open supporting page {c.page_no}</button><blockquote>{c.quote}</blockquote></div>)}
  {(run.conflicts||[]).map((c:any,i:number)=><p key={i}>Unresolved specification: {c.field} — {(c.values||[]).map((v:any)=>`${v.value} (page ${v.page})`).join(' / ')}</p>)}
  {(run.comparison?.unresolved||run.stage_two?.unresolved||[]).map((v:any,i:number)=><p key={i}>{String(v)}</p>)}
  {error&&<p role="alert">{error}</p>}
  {page&&<details open><summary>{page.brand} — {page.title} — page {page.page_no}</summary>{page.pdf_url&&<a href={`${page.pdf_url}#page=${page.page_no}`} target="_blank" rel="noopener noreferrer">Open original manufacturer PDF</a>}{page.image_url&&<img src={page.image_url} alt={`Reference page ${page.page_no}`} style={{maxWidth:'100%'}}/>}<pre style={{whiteSpace:'pre-wrap'}}>{page.text}</pre><button type="button" onClick={()=>setPage(null)}>Close page</button></details>}
 </section>;
}
export function RecognitionHistory({openingId}:{openingId:string}){
 const [runs,setRuns]=useState<any[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;setRuns([]);setError('');fetchRecognitionRuns(openingId).then(r=>{if(active)setRuns(r.runs);}).catch(()=>{if(active)setError('Recognition evidence history is unavailable while offline or disconnected.');});return()=>{active=false;};},[openingId]);
 return <section className="card"><h2>Saved recognition evidence</h2>{error&&<p>{error}</p>}{runs.map(r=><details key={r.id}><summary>{r.component_id?`Component ${r.component_id}`:'Opening recognition'} — {r.suggestion?.manufacturer||'Unknown'} {r.suggestion?.model||''}</summary><ReferenceEvidence run={r}/></details>)}</section>;
}
