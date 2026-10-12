const dbp=new Promise((resolve,reject)=>{const r=indexedDB.open('oi-preview-sync-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('operations',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function dbAction(mode,fn){const db=await dbp;return new Promise((resolve,reject)=>{const tx=db.transaction('operations',mode);const request=fn(tx.objectStore('operations'));tx.oncomplete=()=>resolve(request.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function pending(user,project){return (await dbAction('readonly',s=>s.getAll())).filter(x=>x.user===user&&x.project===project).sort((a,b)=>a.created-b.created);}
export async function enqueue(user,project,kind,payload,file=null){const op={id:crypto.randomUUID(),user,project,kind,payload,file,created:Date.now()};await dbAction('readwrite',s=>s.put(op));return op;}
const digest=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('');
export async function applyOne(sb,op){
  async function sameAccount(){const {data,error}=await sb.auth.getSession();if(error||data.session?.user.id!==op.user)throw Error('Account changed; queued work retained for its owner');}
  await sameAccount();
  if(op.kind==='photo'){
    const bucket=sb.storage.from('opening-photos');
    const {error}=await bucket.upload(op.payload.storage_path,op.file,{upsert:false,contentType:op.file.type||'image/jpeg'});
    if(error){
      const retained=await bucket.download(op.payload.storage_path);
      if(retained.error||!retained.data)throw Error('Photo upload pending: '+error.message);
      if(await digest(retained.data)!==await digest(op.file))throw Error('Photo identity conflict; original retained');
    }
  }
  await sameAccount();
  const result=await sb.rpc('oi_apply_operation',{p_id:op.id,p_kind:op.kind,p_payload:op.payload});
  if(result.error)throw Error(result.error.message);
  if(!['applied','already_applied'].includes(result.data?.status))throw Error('Unexpected synchronization response');
  return result.data;
}
let busy=false;
export async function flush(sb,user,project,onResult=()=>{}){if(busy)throw Error('Synchronization already running');busy=true;try{for(const op of await pending(user,project)){const result=await applyOne(sb,op);await dbAction('readwrite',s=>s.delete(op.id));onResult(result);}}finally{busy=false;}}
