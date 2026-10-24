import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { compareStagingStorage } from '../lib/api';

const labels: Record<string,string> = {
  accessKeyMatches:'Access key matches the operator reference', endpointMatches:'Endpoint matches isolated staging',
  regionMatches:'Region matches isolated staging', bucketMatches:'Bucket matches isolated staging',
  accessKeyPresent:'Runtime access key is present', secretKeyPresent:'Runtime secret key is present',
};
export function StagingStorageComparisonPage() {
  const {auth}=useAuth();
  if (location.hostname !== 'oi-video-workflows-staging.netlify.app' || auth?.role !== 'admin' ||
      auth.organizationId !== '66c07d0e-887d-4b78-a6bc-181b2a644c34') return <p>Unavailable.</p>;
  return <Comparison key={auth.userId + ':' + auth.organizationId} />;
}
function Comparison() {
  const [result,setResult]=useState<Record<string,boolean>|null>(null);
  const [busy,setBusy]=useState(false); const [failed,setFailed]=useState(false);
  const [alive]=useState(()=>({current:true}));
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[alive]);
  async function run() {
    setBusy(true);setFailed(false);setResult(null);
    try {const value=await compareStagingStorage();if(alive.current)setResult(value);}
    catch {if(alive.current)setFailed(true);}
    finally {if(alive.current)setBusy(false);}
  }
  return <main style={{maxWidth:640,margin:'40px auto',padding:20}}>
    <h1>Temporary storage comparison</h1>
    <p>Uses the approved operator reference. No keys are entered here. This check does not upload, delete or change storage settings.</p>
    <button onClick={run} disabled={busy}>{busy?'Checking…':'Compare configured identity'}</button>
    {failed && <p role="status">Comparison unavailable. It may be disabled, expired or not authorized. No credential changes were made.</p>}
    {result && <dl>{Object.entries(labels).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{result[key]?'Yes':'No'}</dd></div>)}</dl>}
    <p>A match confirms identity equality only, not provider acceptance or secret validity.</p>
  </main>;
}
