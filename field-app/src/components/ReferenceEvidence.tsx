import {useEffect,useState} from 'react';
import {fetchRecognitionRuns,fetchReferencePage} from '../lib/api';
export function ReferenceEvidence({run}:{run:any}){
 const incomplete=['running','failed'].includes(run.status);
 const comparison=incomplete?null:run.comparison||run.stage_two;
 const candidates=Array.isArray(comparison?.candidates)?comparison.candidates.filter((c:any)=>c&&typeof c==='object').slice(0,3):[];
 const [page,setPage]=useState<any>(null),[error,setError]=useState('');
 async function open(c:any){setPage(null);setError('');try{setPage((await fetchReferencePage(c.doc_sha256,c.page_no)).page);}catch{setError('Reference unavailable. It may have been withdrawn or superseded.');}}
 if(incomplete)return <section aria-label="Manufacturer reference evidence"><p>{run.status==='running'?'Analysis is still processing; no completed result is available.':'Analysis failed; this run is not a completed recognition result.'}</p></section>;
 return <section aria-label="Manufacturer reference evidence">
  <p>{run.status==='saved_evidence_review'?'Saved markings reviewed against the identity catalog; no new AI analysis.':run.status==='no_reference_evidence'&&run.suggestion?.catalog_identity_review?'Identity catalog checked; no additional reference-page comparison was run.':run.status==='running'?'Analysis is still processing; no completed result is available.':run.status==='failed'?'Analysis failed; this run is not a completed recognition result.':run.status==='reference_evidence'?'Manufacturer reference evidence — technician review required':run.status==='no_valid_reference_citations'?'Reference documents found, but the analysis did not produce valid source citations. Product identity remains unverified.':run.status==='reference_comparison_unavailable'?'Reference documents found, but comparison is temporarily unavailable.':run.status==='reference_comparison_disabled'?'Reference documents found; comparison is disabled.':'No reference evidence — preliminary photograph analysis only'}</p>
  {(run.reference_comparison_failure||run.stage_one?.reference_comparison_failure)&&<p>Comparison did not complete: {String((run.reference_comparison_failure||run.stage_one?.reference_comparison_failure).code).replace(/_/g,' ')}. No reference match was established.</p>}
  {(run.comparison?.processing?.excerpted_pages||run.stage_two?.processing?.excerpted_pages)>0&&<p>Reference comparison used selected excerpts. Open the supporting pages for the full documents.</p>}
  {candidates.length>0&&<section aria-label="Possible products"><h3>Possible products in the compared reference set</h3><p>These are possibilities, not confirmed identities. Other products may also fit.</p><ul>{candidates.map((candidate:any,i:number)=><li key={i}><strong>{[candidate.manufacturer,candidate.model||candidate.series].filter(Boolean).join(' ')||'Unspecified candidate'}</strong>{Array.isArray(candidate.supporting_features)&&candidate.supporting_features.map((feature:any,j:number)=><p key={'support'+j}>{feature?.citation?'Consistent observation':'Visual hypothesis without a supporting source citation'}: {String(feature?.observation||'')}</p>)}{Array.isArray(candidate.contradicting_features)&&candidate.contradicting_features.map((feature:any,j:number)=><p key={'conflict'+j}>Possible difference: {String(feature?.observation||'')}</p>)}</li>)}</ul></section>}
  {comparison?.cover_comparison==='unavailable_without_installed_cover'&&<p>The cover is removed or not visible. Cover style cannot be compared and does not rule out these products.</p>}
  {(run.citations||[]).map((c:any,i:number)=><div key={i}><button type="button" onClick={()=>open(c)}>Open supporting page {c.page_no}</button><blockquote>{c.quote}</blockquote></div>)}
  {(run.conflicts||[]).map((c:any,i:number)=><p key={i}>Unresolved specification: {c.field} — {(c.values||[]).map((v:any)=>`${v.value} (page ${v.page})`).join(' / ')}</p>)}
  {(Array.isArray(comparison?.unresolved)?comparison.unresolved:[]).filter((v:any)=>typeof v==='string').map((v:any,i:number)=><p key={i}>{String(v)}</p>)}
  {error&&<p role="alert">{error}</p>}
  {page&&<details open><summary>{page.brand} — {page.title} — page {page.page_no}</summary>{page.pdf_url&&<a href={`${page.pdf_url}#page=${page.page_no}`} target="_blank" rel="noopener noreferrer">Open original manufacturer PDF</a>}{page.image_url&&<img src={page.image_url} alt={`Reference page ${page.page_no}`} style={{maxWidth:'100%'}}/>}<pre style={{whiteSpace:'pre-wrap'}}>{page.text}</pre><button type="button" onClick={()=>setPage(null)}>Close page</button></details>}
 </section>;
}
export function RecognitionHistory({openingId}:{openingId:string}){
 const [runs,setRuns]=useState<any[]>([]),[error,setError]=useState('');
 useEffect(()=>{let active=true;setRuns([]);setError('');fetchRecognitionRuns(openingId).then(r=>{if(active)setRuns(r.runs);}).catch(()=>{if(active)setError('Recognition evidence history is unavailable while offline or disconnected.');});return()=>{active=false;};},[openingId]);
 return <section className="card"><h2>Saved recognition evidence</h2>{error&&<p>{error}</p>}{runs.map(r=><details key={r.id}><summary>{r.component_id?`Component ${r.component_id}`:'Opening recognition'} — {r.suggestion?.manufacturer||'Unknown'} {r.suggestion?.model||''}</summary><ReferenceEvidence run={r}/></details>)}</section>;
}
