import type {CommercialStore} from './commercialStorage';
import {documentHash} from './commercialStorage';

// Runtime must explicitly supply an approved server-only credential provider.
// Existing S3 access keys cannot authenticate this REST transport.
// Standard REST upload is create-only (x-upsert:false), unlike S3 PutObject.
// https://supabase.com/docs/guides/storage/uploads/standard-uploads
// This is application-level version immutability, NOT provider WORM retention.
const ORIGIN='https://boaoedvyvifppuklbwad.supabase.co';
const BUCKET='oi-video-workflows-media';
const ROOT=ORIGIN+'/storage/v1';
const PREFIX='commercial-documents/v1/';
export const COMMERCIAL_PDF_MAX_BYTES=2_000_000;
type Transport=(input:string,init:RequestInit)=>Promise<Response>;
export interface SupabaseCommercialConfiguration {
 enabled:true;
 apiKey:string;
 getAccessToken:()=>Promise<string>;
}
function failure(code:string):never{throw new Error(code);}
function objectPath(key:string){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))failure('commercial_object_key_invalid');
 return ROOT+'/object/'+BUCKET+'/'+PREFIX+key.toLowerCase()+'.pdf';
}
function pdf(bytes:Buffer){if(!bytes.length||bytes.length>COMMERCIAL_PDF_MAX_BYTES||bytes.subarray(0,5).toString('ascii')!=='%PDF-')failure('commercial_pdf_invalid');}
async function discard(response:Response){try{await response.body?.cancel();}catch{/* Never include provider errors in logs or responses. */}}
async function bounded(response:Response,limit:number):Promise<Buffer>{
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)){await discard(response);failure('commercial_object_size_invalid');}
 if(!response.body)failure('commercial_object_unavailable');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
 try{for(;;){const next=await reader.read();if(next.done)break;count+=next.value.byteLength;if(count>limit)failure('commercial_object_size_invalid');chunks.push(next.value);}}
 finally{try{await reader.cancel();}catch{}reader.releaseLock();}
 if(length!==null&&count!==Number(length))failure('commercial_object_size_invalid');
 return Buffer.concat(chunks,count);
}
export async function createSupabaseCommercialStore(config:SupabaseCommercialConfiguration,transport:Transport=fetch):Promise<CommercialStore>{
 if(config?.enabled!==true||!config.apiKey?.trim()||typeof config.getAccessToken!=='function'||/[\r\n]/.test(config.apiKey))failure('commercial_storage_not_configured');
 // Capture config once; never read credentials from client input or global env.
 const apiKey=config.apiKey;
 async function request(path:string,method:'GET'|'POST',bytes?:Buffer){
  const token=await config.getAccessToken();if(!token||/[\r\n]/.test(token))failure('commercial_storage_not_configured');
  const headers={apikey:apiKey,Authorization:'Bearer '+token};
  return transport(path,{method,headers:{...headers,...(bytes?{'Content-Type':'application/pdf','Content-Length':String(bytes.length),'Cache-Control':'private, no-store','x-upsert':'false'}:{})},...(bytes?{body:new Uint8Array(bytes)}:{}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
 }
 async function privateBucket(){
  try{const r=await request(ROOT+'/bucket/'+BUCKET,'GET');if(!r.ok){await discard(r);failure('commercial_private_bucket_required');}
   const metadata=JSON.parse((await bounded(r,16384)).toString('utf8'));if(metadata.id!==BUCKET||metadata.public!==false)failure('commercial_private_bucket_required');
  }catch{failure('commercial_private_bucket_required');}
 }
 async function readObject(key:string){
  const path=objectPath(key);
  try{const r=await request(path,'GET');if(!r.ok){await discard(r);failure('commercial_object_unavailable');}if(r.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/pdf'){await discard(r);failure('commercial_object_invalid');}
   const bytes=await bounded(r,COMMERCIAL_PDF_MAX_BYTES);pdf(bytes);return bytes;
  }catch{failure('commercial_object_unavailable');}
 }
 await privateBucket();
 return {privateImmutable:true,mode:'verified',
  async putOnce(key,bytes){
   const path=objectPath(key);pdf(bytes);const frozen=Buffer.from(bytes),hash=documentHash(frozen);await privateBucket();
   let response:Response|undefined;
   try{response=await request(path,'POST',frozen);}catch{/* A response can be lost after create. Read the same key once; never repeat the POST. */}
   if(response){const status=response.status;await discard(response);if(!response.ok&&![400,409].includes(status)&&status<500)failure('commercial_object_create_failed');}
   let actual:Buffer;try{actual=await readObject(key);}catch{failure('commercial_object_create_unconfirmed');}
   if(actual.length!==frozen.length||documentHash(actual)!==hash)failure('immutable_object_exists');
  },
  async read(key){objectPath(key);await privateBucket();return readObject(key);}
 };
}
