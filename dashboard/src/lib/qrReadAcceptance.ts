import {withQrReadSession} from './api';
export const QR_CHECK_END=Date.parse('2026-10-27T18:00:00Z');
const KEY='oi_qr_read_acceptance_20261027';
export const qrCheckAvailable=()=>{
  if(window.location.origin!=='https://oi-video-workflows-staging.netlify.app'||Date.now()>=QR_CHECK_END)return false;
  try{const saved=JSON.parse(sessionStorage.getItem(KEY)||'null');return !saved||(Number.isFinite(saved.end)&&Date.now()<saved.end&&saved.end<=QR_CHECK_END);}catch{return false;}
};
const targets=[
  ['opening','/api/openings/faedecd4-4e92-44ec-a224-3c1c4f5c8256'],
  ['photo','/api/photos/0c8ab3d0-5c2a-41ca-a951-44e1c5328af6/access'],
  ['document','/api/commercial/documents/ca665af9-a08b-423d-97ef-a90ecdee95f5'],
] as const;
export type ReadResult={target:string;status:number;outcome:'denied'|'inconclusive'|'unexpected_access'};
let running=false;
export async function runQrReadChecks(mode:'anonymous'|'foreign', outer:AbortSignal):Promise<ReadResult[]> {
  if(!['anonymous','foreign'].includes(mode)||!qrCheckAvailable()||running||outer.aborted)throw Error('check_unavailable');
  const saved=JSON.parse(sessionStorage.getItem(KEY)||'null') || {end:Math.min(Date.now()+15*60_000,QR_CHECK_END),used:[]};
  if(!Number.isFinite(saved.end)||saved.end>Date.now()+15*60_000||saved.end>QR_CHECK_END||Date.now()>=saved.end||!Array.isArray(saved.used)||saved.used.includes(mode))throw Error('check_unavailable');
  saved.used.push(mode);sessionStorage.setItem(KEY,JSON.stringify(saved));
  running=true;
  const controller=new AbortController();const abort=()=>controller.abort();outer.addEventListener('abort',abort);
  // Bound the entire phase, including identity and response-body reads.
  const timeout=setTimeout(abort,Math.min(15000,saved.end-Date.now()));
  const results:ReadResult[]=[];
  try {
    return await withQrReadSession(mode,controller.signal,async(read,stable)=>{
      for(const [target,path] of targets){
        if(!stable()||!qrCheckAvailable()||Date.now()>=saved.end)throw Error('check_unavailable');
        const r=await read(path);let outcome:ReadResult['outcome']='inconclusive';
        if(!stable()){await r.body?.cancel();throw Error('check_unavailable');}
        if(r.ok){outcome='unexpected_access';await r.body?.cancel();}
        else if(r.status===(mode==='anonymous'?401:404)&&r.headers.get('content-type')?.split(';')[0].trim()==='application/json'){
          const reader=r.body?.getReader(); if(!reader)throw Error('check_unavailable');
          let size=0;const chunks:Uint8Array[]=[];
          try{while(true){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>1024)throw Error('check_unavailable');chunks.push(v.value);}}
          finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
          const body=JSON.parse(new TextDecoder().decode(bytes));
          if(body&&!Array.isArray(body)&&body.error===(mode==='anonymous'?'missing_token':'not_found')&&Object.keys(body).every(k=>['error','reference'].includes(k))&&(body.reference===undefined||/^[0-9a-f-]{36}$/i.test(body.reference)))outcome='denied';
        }else await r.body?.cancel();
        if(!stable()||!qrCheckAvailable()||Date.now()>=saved.end)throw Error('check_unavailable');
        results.push({target,status:r.status,outcome});if(outcome!=='denied')break;
      }
      return results;
    });
  }finally{clearTimeout(timeout);outer.removeEventListener('abort',abort);controller.abort();running=false;}
}
