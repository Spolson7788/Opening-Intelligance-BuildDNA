export const DIAGNOSTIC_ORIGIN = 'https://oi-connected-release-candidate.netlify.app';
export const DIAGNOSTIC_ROUTE = '/diagnostics/photo-isolation';
export const PHOTO = 'b05bb191-1a45-424b-bcb1-a17e85489f0f';
export const OPENING = 'f6ee2e93-4589-42e4-850e-643780f57dfc';
export const PROBES = [`/photos/by-opening/${OPENING}`, `/photos/${PHOTO}/access`] as const;
export type Actor = 'A' | 'B';
export type Principal = {userId:string; organizationId:string; role:string};
export type Result = {check:'Photo list'|'Private URL issuance'; status:number|null; verdict:'PASS'|'FAIL'|'INCONCLUSIVE'; detail:string};
export type ProbeResponse = {status:number; redirected:boolean; contentType:string; data:unknown};
export function diagnosticActor(p:Principal|null):Actor|null {
  if (!p?.userId || p.role !== 'technician') return null;
  if (p.organizationId === '44b157d8-acf7-408c-a833-c83f5c4b09bc') return 'A';
  if (p.organizationId === 'fb7f7867-aa5c-497f-9dc0-b400fbc1ce31') return 'B';
  return null;
}
export function diagnosticAvailable(enabled:boolean, origin:string, apiBase:string) {
  return enabled && origin === DIAGNOSTIC_ORIGIN && apiBase === '/api';
}
export function classifyPhotoProbe(actor:Actor, index:number, response:ProbeResponse):Result {
  const result:Result = {check:index===0?'Photo list':'Private URL issuance',status:response.status,verdict:'INCONCLUSIVE',detail:'Unexpected response; stop and review.'};
  if(response.redirected || response.status>=300&&response.status<400) return {...result,detail:'Redirect refused.'};
  if(response.status===401) return {...result,detail:'Authentication or site access was not established.'};
  if(!/^application\/json(?:\s*;|$)/i.test(response.contentType)) return {...result,detail:'Non-JSON response; application authorization is unverified.'};
  const data=response.data;
  if(actor==='B') {
    const expected=index===0?403:404, error=index===0?'forbidden':'not_found';
    const pass=response.status===expected && !!data && typeof data==='object' && !Array.isArray(data) && Object.keys(data).length===1 && (data as {error?:unknown}).error===error;
    return {...result,verdict:pass?'PASS':'FAIL',detail:pass?'Expected application refusal.':'Unexpected application access or refusal.'};
  }
  if(response.status!==200) return {...result,verdict:'FAIL',detail:'Expected access was not granted.'};
  let pass=false;
  if(index===0) pass=Array.isArray(data)&&data.length>0&&data.every(p=>p?.opening_id===OPENING)&&data.some(p=>p?.id===PHOTO);
  else if(data && typeof data==='object') {
    const d=data as {url?:unknown;expires_in_seconds?:unknown};
    try {const url=new URL(String(d.url));pass=url.protocol==='https:'&&!url.username&&!url.password&&typeof d.expires_in_seconds==='number'&&d.expires_in_seconds>0&&d.expires_in_seconds<=300;}catch{/* No server text is surfaced. */}
  }
  return {...result,verdict:pass?'PASS':'FAIL',detail:pass?(index===0?'Designated photo present.':'Short-lived private URL issued; not displayed or opened.'):'Unexpected application response.'};
}
export async function readBoundedProbe(res:Response):Promise<ProbeResponse> {
  const contentType=res.headers.get('content-type')||'';
  if(res.redirected || !/^application\/json(?:\s*;|$)/i.test(contentType)) return {status:res.status,redirected:res.redirected,contentType,data:null};
  const reader=res.body?.getReader(); if(!reader) throw Error('invalid_response');
  let text='',bytes=0; const decoder=new TextDecoder();
  try {while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>262144)throw Error('response_limit');text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();return {status:res.status,redirected:res.redirected,contentType,data:JSON.parse(text)};}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function runPhotoProbes(actor:Actor, request:(path:typeof PROBES[number])=>Promise<ProbeResponse>):Promise<Result[]> {
  const results:Result[]=[];
  for(let i=0;i<PROBES.length;i++) {
    try {results.push(classifyPhotoProbe(actor,i,await request(PROBES[i])));}
    catch {results.push({check:i===0?'Photo list':'Private URL issuance',status:null,verdict:'INCONCLUSIVE',detail:'Request interrupted, session changed, or response could not be verified.'});}
    if(results.at(-1)?.verdict!=='PASS') break;
  }
  return results;
}
