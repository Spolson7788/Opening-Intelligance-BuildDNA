// Validate provider envelopes separately from transport success. Never repair text.
import {providerObject} from './providerReply';
export const LABEL_RESPONSE_VERSION='oi-label-response-5';
export interface LabelValidationIssue {reason:string;entry_index?:number;crop_index?:number}
export function labelReadContract(indices:number[]){
 return ` Return exactly ${indices.length} reads, one for each crop_index in [${indices.join(',')}], with no duplicate or extra indices. Use a string text for every entry, including an empty string when unreadable or no label is visible. Never omit an unreadable crop or use null text.`;
}
export function parseLabelResponse(body:any,stage:string,expected:number|number[]){
 if(body?.stop_reason==='refusal')throw Error('label_refused');
 if(body?.stop_reason==='max_tokens')throw Error('label_truncated');
 let value:any;try{value=providerObject(body);}catch{
  // Accept exactly one complete JSON fence surrounded by explanatory prose.
  // Parse only its bytes; never repair JSON, text, crop indices or coordinates.
  if(body?.error)throw Error('label_invalid_json');
  const text=(Array.isArray(body?.content)?body.content:[]).filter((c:any)=>c?.type==='text'&&typeof c.text==='string').map((c:any)=>c.text).join('');
  const fences=[...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  if(fences.length!==1||text.replace(fences[0][0],'').includes('```')||/[{}]/.test(text.replace(fences[0][0],'')))throw Error('label_invalid_json');
  try{value=JSON.parse(fences[0][1]);}catch{throw Error('label_invalid_json');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('label_invalid_json');
  value.response_format='single_json_fence_with_prose';
 }
 if(stage==='label_locator'){
  if(!Array.isArray(value.regions)||value.regions.length>6)throw Error('label_invalid_regions');
  for(const r of value.regions){
   if(r&&typeof r.rotation==='string'&&/^(0|90|180|270)$/.test(r.rotation))r.rotation=Number(r.rotation);
   if(!r||!Number.isInteger(r.photo_index)||r.photo_index<0||r.photo_index>=Number(expected)||![r.x,r.y,r.w,r.h].every(v=>typeof v==='number'&&Number.isFinite(v))||r.x<0||r.y<0||r.w<=0||r.h<=0||r.x+r.w>1.000001||r.y+r.h>1.000001||![0,90,180,270].includes(r.rotation))throw Error('label_invalid_regions');
  }
 }else{
  if(!Array.isArray(value.reads))throw Error('label_invalid_reads');
  const indices=Array.isArray(expected)?expected:Array.from({length:expected},(_,i)=>i);
  const valid=new Map<number,any>(),seen=new Set<number>(),invalid=new Set<number>();
  const issues:LabelValidationIssue[]=[];
  for(const [entry_index,entry] of value.reads.entries()){
   const r=entry&&typeof entry==='object'?{...entry}:entry;
   // A decimal index string is unambiguous; normalize its type, never its text.
   if(r&&typeof r.crop_index==='string'&&/^(0|[1-9]\d*)$/.test(r.crop_index))r.crop_index=Number(r.crop_index);
   if(!r||!Number.isInteger(r.crop_index)){issues.push({entry_index,reason:'invalid_crop_index'});continue;}
   if(!indices.includes(r.crop_index)){issues.push({entry_index,crop_index:r.crop_index,reason:'crop_index_out_of_range'});continue;}
   if(seen.has(r.crop_index)){
    // Neither duplicate is unambiguous. Preserve other crops, not a guessed winner.
    valid.delete(r.crop_index);invalid.add(r.crop_index);
    issues.push({entry_index,crop_index:r.crop_index,reason:'duplicate_crop_index'});continue;
   }
   seen.add(r.crop_index);
   if(typeof r.text!=='string'){invalid.add(r.crop_index);issues.push({entry_index,crop_index:r.crop_index,reason:'invalid_text'});continue;}
   // Preserve the transcription for miss review, but flag malformed device
   // association. A descriptive string must never be coerced into proof.
   if(['native_tile','focused_crop','focused_view'].includes(r.source)&&typeof r.target_device!=='boolean')issues.push({entry_index,crop_index:r.crop_index,reason:'invalid_target_device'});
   if(r.source==='focused_view'){
    if(!Number.isInteger(r.view_index)||r.view_index<0||r.view_index>3)issues.push({entry_index,crop_index:r.crop_index,reason:'invalid_view_index'});
    if(typeof r.all_characters_visible!=='boolean')issues.push({entry_index,crop_index:r.crop_index,reason:'invalid_marking_completeness'});
   }
   valid.set(r.crop_index,r);
  }
  const not_returned=indices.filter(i=>!seen.has(i));
  for(const crop_index of not_returned)issues.push({crop_index,reason:'not_returned'});
  value.reads=indices.flatMap(i=>valid.has(i)?[valid.get(i)]:[]);
  value.validation={version:LABEL_RESPONSE_VERSION,status:issues.length?'partial':'completed',issues,not_returned,invalid_crops:[...invalid]};
 }
 return value;
}
