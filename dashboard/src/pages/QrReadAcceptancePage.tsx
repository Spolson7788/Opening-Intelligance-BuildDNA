import {useEffect,useRef,useState} from 'react';
import {qrCheckAvailable,runQrReadChecks,type ReadResult} from '../lib/qrReadAcceptance';
const STOP:Record<string,string>={
 still_signed_in:'Still signed in \u2014 sign out from the Dashboard first. This phase was not run.',
 not_signed_in_as_b:'Not signed in as Admin B. This phase was not run.',
 phase_already_used:'This phase was already run in this tab. Do not retry.',
 expired:'Verification window has expired. This phase was not run.',
};
const GENERIC='Verification stopped. Check the account or expiry with the operator; do not retry.';
export function QrReadAcceptancePage(){
 const [results,setResults]=useState<ReadResult[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[available,setAvailable]=useState(qrCheckAvailable);
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>{const timer=setInterval(()=>setAvailable(qrCheckAvailable()),1000);return()=>{clearInterval(timer);pending.current?.abort();};},[]);
 async function run(mode:'anonymous'|'foreign'){
  if(pending.current)return;const c=new AbortController();pending.current=c;setBusy(true);setError(null);setResults([]);
  try{const value=await runQrReadChecks(mode,c.signal);if(!c.signal.aborted)setResults(value);}
  catch(e){if(!c.signal.aborted)setError(STOP[(e as Error)?.message]??GENERIC);}
  finally{if(pending.current===c){pending.current=null;if(!c.signal.aborted)setBusy(false);}}
 }
 if(!available)return <main><h1>Verification unavailable</h1></main>;
 return <main><h1>Staging QR read verification</h1><p>Operator use only. No uploads or record changes. Keep the Field workspace untouched.</p>
 <p>Use the ordinary Dashboard controls to sign out, run the signed-out checks here, then privately sign in as B and return here. Finish by returning to A. Do not repeat a failed phase.</p>
 <a href="/dashboard/">Open Dashboard for account controls</a>
 <p>Expires at 18:00 UTC on October 28, 2026, or 15 minutes after the first phase in this tab.</p>
 <button disabled={busy} onClick={()=>run('anonymous')}>Run three signed-out reads</button>
 <button disabled={busy} onClick={()=>run('foreign')}>Run three B reads</button>
 {busy&&<p role="status">Checking read access.</p>}{error&&<p role="status">{error}</p>}
 <ul>{results.map(r=><li key={r.target}>{r.target}: {r.status} {r.outcome}</li>)}</ul></main>;
}
