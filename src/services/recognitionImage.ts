import {recognitionInputPixelLimit} from './recognitionOriginalLimits';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
// Coordinates downstream refer to this upright, opaque image, never EXIF storage axes.
export async function normalizeRecognitionImage(image:Buffer){
 return sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).rotate().removeAlpha().png().toBuffer();
}

export const PROVIDER_IMAGE_VERSION='oi-provider-image-1';
export const PROVIDER_LONG_EDGE=1568;
export const MAX_PROVIDER_IMAGE_BYTES=1_000_000;
export const MAX_PROVIDER_REQUEST_BYTES=24_000_000;
// Local crops retain their pixels. Only the outgoing view is resampled/encoded.
export async function prepareProviderImage(image:Buffer,maxBytes=MAX_PROVIDER_IMAGE_BYTES){
 const source=await sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).metadata();
 // Reuse a verified bounded JPEG. This is checked from the bytes, never a
 // caller-supplied flag, and retains both hashes in the request audit.
 if(source.format==='jpeg'&&source.width&&source.height&&Math.max(source.width,source.height)<=PROVIDER_LONG_EDGE&&(!source.orientation||source.orientation===1)&&image.length<=maxBytes){
  return {data:image,metadata:{version:PROVIDER_IMAGE_VERSION,operation:'verified_jpeg_passthrough',source_width:source.width,source_height:source.height,source_orientation:source.orientation||1,width:source.width,height:source.height,quality:null,long_edge_limit:PROVIDER_LONG_EDGE,bytes:image.length,media_type:'image/jpeg'}};
 }
 for(const [longEdge,quality] of [[PROVIDER_LONG_EDGE,85],[PROVIDER_LONG_EDGE,70],[1200,65],[900,60],[700,50]]){
  const {data,info}=await sharp(image,{limitInputPixels:recognitionInputPixelLimit()}).rotate().flatten({background:'white'}).resize({width:longEdge,height:longEdge,fit:'inside',withoutEnlargement:true}).jpeg({quality,chromaSubsampling:'4:4:4'}).toBuffer({resolveWithObject:true});
  if(data.length<=maxBytes)return {data,metadata:{version:PROVIDER_IMAGE_VERSION,operation:'exif_orient_resize_jpeg',source_width:source.width,source_height:source.height,source_orientation:source.orientation||1,width:info.width,height:info.height,quality,long_edge_limit:longEdge,bytes:data.length,media_type:'image/jpeg'}};
 }
 throw Error('recognition_image_budget_exceeded');
}

export async function prepareProviderRequest(request:any){
 const manifest:any[]=[];
 const imageCount=(request.messages||[]).reduce((n:number,m:any)=>n+(m.content||[]).filter((c:any)=>c.type==='image').length,0);
 const imageBudget=Math.min(MAX_PROVIDER_IMAGE_BYTES,Math.floor((MAX_PROVIDER_REQUEST_BYTES-1_000_000)*.75/Math.max(1,imageCount)));
 if(imageCount>100)throw Error('recognition_image_count_exceeded');
 for(const message of request.messages||[]){
  const content:any[]=[];
  for(const block of message.content||[]){
   if(block.type!=='image'){content.push(block);continue;}
   if(block.source?.type!=='base64'||typeof block.source.data!=='string')throw Error('recognition_image_source_unsupported');
   const original=Buffer.from(block.source.data,'base64');
   const prepared=await prepareProviderImage(original,imageBudget);
   block.source={type:'base64',media_type:'image/jpeg',data:prepared.data.toString('base64')};
   content.push({type:'image',...prepared.metadata,source_sha256:hash(original),sha256:hash(prepared.data)});
  }
  manifest.push({...message,content});
 }
 const body=JSON.stringify(request);
 if(Buffer.byteLength(body,'utf8')>MAX_PROVIDER_REQUEST_BYTES)throw Error('recognition_request_budget_exceeded');
 return {body,manifest};
}
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
