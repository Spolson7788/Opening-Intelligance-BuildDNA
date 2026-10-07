import {pool} from '../db/pool';
import {buildPrivatePhotoStorageKey,readPrivatePhotoBytes} from './storage';
import {MAX_RECOGNITION_ORIGINAL_BYTES,MAX_RECOGNITION_SET_BYTES,MAX_RECOGNITION_SET_PIXELS,recognitionInputPixelLimit} from './recognitionOriginalLimits';
import sharp from 'sharp';
import {normalizeRecognitionImage} from './recognitionImage';
import {createHash} from 'node:crypto';

export function orderedRecognitionPhotos(ids:string[],rows:any[],scope:{openingId:string;organizationId:string;userId:string},mediaType:string){
 if(ids.length<1||ids.length>5||new Set(ids).size!==ids.length||rows.length!==ids.length)throw Error('recognition_source_not_available');
 const ordered=ids.map(id=>rows.find(r=>r.id===id));let total=0;
 for(const r of ordered){
  if(!r||r.opening_id!==scope.openingId||r.organization_id!==scope.organizationId||r.uploaded_by_user_id!==scope.userId||r.upload_state!=='verified'||!r.storage_verified_at||!r.authorized_retrieval_verified_at||r.content_type!==mediaType||!/^[a-f0-9]{64}$/.test(r.sha256_checksum||'')||r.storage_object_key!==buildPrivatePhotoStorageKey(scope.organizationId,scope.openingId,r.id,mediaType))throw Error('recognition_source_not_available');
  if(!Number.isSafeInteger(Number(r.byte_size))||Number(r.byte_size)<=0||Number(r.byte_size)>MAX_RECOGNITION_ORIGINAL_BYTES)throw Error('recognition_source_too_large');
  total+=Number(r.byte_size);
 }
 if(total>MAX_RECOGNITION_SET_BYTES)throw Error('recognition_source_too_large');
 return ordered;
}
export function originalPreparationReason(error:unknown){
 const e=error as {name?:string;message?:string};
 if(['AbortError','TimeoutError'].includes(e?.name||''))return 'source_timeout';
 if(['AccessDenied','Forbidden','NoSuchKey','NotFound'].includes(e?.name||''))return 'source_storage_unavailable';
 const known=['recognition_source_not_available','recognition_source_too_large','recognition_source_timeout','recognition_source_size_mismatch','recognition_source_checksum_mismatch','recognition_source_pixel_limit','image_type_mismatch'];
 if(known.includes(e?.message||''))return e.message!;
 if(/exceeds pixel limit/i.test(e?.message||''))return 'recognition_source_pixel_limit';
 return 'source_preparation_failed';
}
export async function prepareRecognitionOriginals(ids:string[],scope:{openingId:string;organizationId:string;userId:string},mediaType:string,onStage:(stage:'original_retrieval'|'original_metadata'|'image_normalization')=>void=()=>{}){
 onStage('original_retrieval');
 const sources=await loadRecognitionOriginals(ids,scope,mediaType);
 onStage('original_metadata');
 // Read headers without decoding, then enforce explicit bounds before pixels
 // are decoded. This also lets diagnostics report the actual camera resolution.
 const metadata=await Promise.all(sources.images.map(x=>sharp(x,{limitInputPixels:false}).metadata()));
 const dimensions=metadata.map(m=>({width:m.width,height:m.height,orientation:m.orientation||1}));
 const formats:Record<string,string>={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
 if(metadata.some(m=>m.format!==formats[mediaType]))throw Error('image_type_mismatch');
 const pixels=metadata.map(m=>(m.width||0)*(m.height||0));
 if(pixels.some(n=>!Number.isSafeInteger(n)||n<1||n>recognitionInputPixelLimit())||pixels.reduce((n,p)=>n+p,0)>MAX_RECOGNITION_SET_PIXELS)throw Object.assign(Error('recognition_source_pixel_limit'),{dimensions});
 const hashes=sources.images.map(x=>createHash('sha256').update(x).digest('hex'));
 onStage('image_normalization');
 const images:Buffer[]=[];for(const image of sources.images)images.push(await normalizeRecognitionImage(image));
 return {images,sources:sources.sources,hashes,dimensions};
}
export async function loadRecognitionOriginals(ids:string[],scope:{openingId:string;organizationId:string;userId:string},mediaType:string){
 const rows=(await pool.query('SELECT id,opening_id,organization_id,uploaded_by_user_id,upload_state,storage_verified_at,authorized_retrieval_verified_at,content_type,byte_size,sha256_checksum,storage_object_key FROM photos WHERE id=ANY($1::uuid[]) AND opening_id=$2 AND organization_id=$3 AND uploaded_by_user_id=$4',[ids,scope.openingId,scope.organizationId,scope.userId])).rows;
 const ordered=orderedRecognitionPhotos(ids,rows,scope,mediaType);
 const images:Buffer[]=[];const signal=AbortSignal.timeout(10000);
 for(const row of ordered)images.push(await readPrivatePhotoBytes(row.storage_object_key,Number(row.byte_size),row.sha256_checksum,signal));
 return {images,sources:ordered.map(r=>({photo_id:r.id,sha256:r.sha256_checksum,byte_size:Number(r.byte_size)}))};
}
