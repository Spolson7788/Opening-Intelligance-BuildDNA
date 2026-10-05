// Validate provider envelopes separately from transport success. Never repair text.
import {providerObject} from './providerReply';
export function parseLabelResponse(body:any,stage:string,expected:number|number[]){
 if(body?.stop_reason==='refusal')throw Error('label_refused');
 if(body?.stop_reason==='max_tokens')throw Error('label_truncated');
 let value:any;try{value=providerObject(body);}catch{throw Error('label_invalid_json');}
 if(stage==='label_locator'){
  if(!Array.isArray(value.regions)||value.regions.length>6)throw Error('label_invalid_regions');
  for(const r of value.regions){
   if(r&&typeof r.rotation==='string'&&/^(0|90|180|270)$/.test(r.rotation))r.rotation=Number(r.rotation);
   if(!r||!Number.isInteger(r.photo_index)||r.photo_index<0||r.photo_index>=Number(expected)||![r.x,r.y,r.w,r.h].every(v=>typeof v==='number'&&Number.isFinite(v))||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>1.000001||r.y+r.h>1.000001||![0,90,180,270].includes(r.rotation))throw Error('label_invalid_regions');
  }
 }else{
  if(!Array.isArray(value.reads))throw Error('label_invalid_reads');
  const indices=Array.isArray(expected)?expected:Array.from({length:expected},(_,i)=>i);
  const seen=new Set<number>();
  for(const r of value.reads){
   // A decimal index string is unambiguous; normalize its type, never its text.
   if(r&&typeof r.crop_index==='string'&&/^(0|[1-9]\d*)$/.test(r.crop_index))r.crop_index=Number(r.crop_index);
   if(!r||!Number.isInteger(r.crop_index)||!indices.includes(r.crop_index)||seen.has(r.crop_index)||typeof r.text!=='string')throw Error('label_invalid_reads');
   seen.add(r.crop_index);
  }
  if(seen.size!==indices.length)throw Error('label_incomplete_reads');
 }
 return value;
}
