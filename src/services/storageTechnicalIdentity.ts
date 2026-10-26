// This identity is exclusively for server-side Storage, never an OI app user.
const ORIGIN='https://boaoedvyvifppuklbwad.supabase.co';
type Transport=(url:string,init:RequestInit)=>Promise<Response>;
export interface StorageIdentityConfiguration {apiKey:string;email:string;password:string;userId:string;}
export function createStorageIdentityProvider(config:StorageIdentityConfiguration,transport:Transport=fetch,now:()=>number=Date.now){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.userId)||![config.apiKey,config.email,config.password].every(v=>typeof v==='string'&&v.length>0&&!/[\r\n]/.test(v)))throw Error('storage_identity_not_configured');
 let session:{access:string;refresh:string;expires:number}|undefined;
 let pending:Promise<string>|undefined,blocked=false,retryAfter=0;
 async function acquire(){
  if(blocked)throw Error('storage_identity_unavailable');
  if(now()<retryAfter)throw Error('storage_identity_temporarily_unavailable');
  if(session&&session.expires>now()+60000)return session.access;
  const refresh=!!session;
  let response:Response;
  try{response=await transport(ORIGIN+'/auth/v1/token?grant_type='+(refresh?'refresh_token':'password'),{method:'POST',headers:{apikey:config.apiKey,'Content-Type':'application/json'},body:JSON.stringify(refresh?{refresh_token:session!.refresh}:{email:config.email,password:config.password}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});}
  catch{retryAfter=now()+30000;throw Error('storage_identity_temporarily_unavailable');}
  if(!response.ok){
   const transient=response.status===429||response.status>=500;
   const delay=response.headers.get('retry-after');
   try{await response.body?.cancel();}catch{}
   if(transient){
    const deadline=delay?(/^\d+$/.test(delay)?now()+Number(delay)*1000:Date.parse(delay)):NaN;
    // Never retry sooner than a valid provider Retry-After, even if very long.
    if(delay&&/^\d+$/.test(delay)&&!Number.isSafeInteger(deadline)){blocked=true;session=undefined;}
    else retryAfter=Math.max(now()+30000,Number.isFinite(deadline)?deadline:0);
   }
   else{blocked=true;session=undefined;}
   throw Error(transient?'storage_identity_temporarily_unavailable':'storage_identity_unavailable');
  }
  try{
   if(!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw Error();
   const reader=response.body?.getReader();if(!reader)throw Error();
   const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>65536)throw Error();chunks.push(part.value);}}
   finally{try{await reader.cancel();}catch{}reader.releaseLock();}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   // Only parse the token returned directly by the fixed trusted HTTPS issuer.
   // This is a fail-closed consistency check, not standalone signature verification.
   if(typeof value.access_token!=='string'||typeof value.refresh_token!=='string'||!value.refresh_token||/[\r\n]/.test(value.access_token+value.refresh_token))throw Error();
   const parts=value.access_token.split('.');if(parts.length!==3)throw Error();
   const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
   if(value.user?.id!==config.userId||claims.sub!==config.userId||claims.iss!==ORIGIN+'/auth/v1'||claims.role!=='authenticated'||claims.aud!=='authenticated'||!Number.isSafeInteger(claims.exp)||claims.exp*1000<=now()+60000)throw Error();
   session={access:value.access_token,refresh:value.refresh_token,expires:claims.exp*1000};
   retryAfter=0;return session.access;
  }catch{blocked=true;session=undefined;throw Error('storage_identity_unavailable');}
 }
 return {getAccessToken():Promise<string>{if(!pending)pending=acquire().finally(()=>{pending=undefined;});return pending;}};
}

let runtimeProvider:ReturnType<typeof createStorageIdentityProvider>|undefined;
export function runtimeStorageIdentity(){
 // One independent in-memory session per warm Function instance; no shared
 // refresh token, filesystem persistence, browser session, or background timer.
 if(!runtimeProvider)runtimeProvider=createStorageIdentityProvider({apiKey:process.env.OI_COMMERCIAL_STORAGE_API_KEY||'',email:process.env.OI_STORAGE_IDENTITY_EMAIL||'',password:process.env.OI_STORAGE_IDENTITY_PASSWORD||'',userId:process.env.OI_STORAGE_IDENTITY_USER_ID||''});
 return runtimeProvider;
}
