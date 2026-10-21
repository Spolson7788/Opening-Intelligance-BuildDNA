import {useRef,useState} from 'react';
import {useAuth} from '../lib/AuthContext';
import {runCandidatePhotoDiagnostic} from '../lib/api';
import {diagnosticActor,diagnosticAvailable} from '../lib/photoDiagnostic';
import type {Result} from '../lib/photoDiagnostic';

export default function PhotoIsolationPage() {
  const {auth}=useAuth();
  const principal=auth?{userId:auth.userId,organizationId:auth.organizationId,role:auth.role}:null;
  const actor=diagnosticActor(principal);
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[results,setResults]=useState<Result[]|null>(null);
  const started=useRef(false);
  const available=diagnosticAvailable(__PHOTO_ISOLATION_ENABLED__,window.location.origin,import.meta.env.VITE_API_BASE_URL||'/api');
  async function run(){
    if(started.current||!confirmed||!principal||!actor||!available)return;
    started.current=true;setBusy(true);
    try {setResults(await runCandidatePhotoDiagnostic(principal));}
    catch {setResults([{check:'Photo list',status:null,verdict:'INCONCLUSIVE',detail:'Candidate or session checks did not pass.'}]);}
    finally {setBusy(false);}
  }
  return <main style={{maxWidth:720,margin:'32px auto',padding:24,lineHeight:1.6}}>
    <h1>Candidate photo-access check</h1>
    <p>Synthetic CA demo only. Two read-only checks; no photos or permissions are changed.</p>
    {!available||!actor?<p role="alert">Unavailable: this requires the protected candidate and an expected technician session.</p>:<>
      <h2>Technician {actor}</h2>
      <p>The saved session has the expected technician role and {actor==='A'?'California provider':'Florida provider'} organization. The server validates authentication on each request. Email identity is user-confirmed, not independently verified by this check.</p>
      <p>Expected result: {actor==='A'?'photo list allowed (200) and private URL issued (200).':'photo list refused (403) and private URL issuance refused (404).'}</p>
      <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={confirmed} disabled={busy||!!results} onChange={e=>setConfirmed(e.target.checked)}/> I signed in as stg-tech-{actor.toLowerCase()}@oi-nonprod.invalid and confirmed my expected facility list.</label>
      <button onClick={run} disabled={!confirmed||busy||!!results} style={{padding:'12px 20px'}}> {busy?'Checking.':'Run read-only checks once'} </button>
    </>}
    <section aria-live="polite" aria-label="Check results">{results?.map(r=><div key={r.check} style={{border:'1px solid #888',borderRadius:8,padding:16,marginTop:16}}><h2>{r.check}: {r.verdict}</h2><p>{r.status===null?'No verified HTTP result':`HTTP ${r.status}`}. {r.detail}</p></div>)}</section>
    <p>No tokens, private image links, or photo contents are displayed. A 401 or site-gate response is inconclusive. These checks are not a full security signoff.</p>
  </main>;
}
