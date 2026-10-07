import {createHash} from 'node:crypto';
import {auditedFetch,recordRecognitionEvidence} from './recognitionAudit';
import {prepareProviderImage} from './recognitionImage';
import {providerObject,classifierObject} from './providerReply';
import type {LabelEvidence,LabelRead} from './labelReading';

export const GROUPED_MODEL='claude-opus-5-5';
export const GROUPED_PROMPT_VERSION='oi-grouped-device-1';
export const GROUPED_MAX_TOKENS=4096;
export const GROUPED_READER_MS=40_000;
export const GROUPED_PROMPT=`These photographs are different views of ONE installed door-hardware device. Read them together, like a technician inspecting the same device. Identify the component type, manufacturer, series and exact model at the highest level the photographs support. First read visible maker letters and model labels, including cast or embossed maker markings. Combine evidence across photographs; a label in one view and a maker mark in another may establish the same device. Shape supports the device type but must not override readable markings or establish a manufacturer by itself. Do not complete missing letters from familiarity. Leave unreadable identity fields null. Report disagreements explicitly. No external search, catalog or expected identity is supplied. Series inferred from a model must be labeled as inferred; it is not a literal transcription.
Return only JSON: {component_class,manufacturer,series,model,reads:[{photo_index,kind,text,legibility,all_characters_visible,target_device}],disagreements:[string],limiting_factor}. component_class is EXIT_DEVICE, DOOR_CLOSER, LOCKSET, HINGE_BUTT, HINGE_CONT, ELECTRIC_STRIKE, POWER_TRANSFER, or null. photo_index is the zero-based INTEGER printed beside the image. kind is brand_mark for maker letters or product_label for printed model/label text. text is the literal visible marking, not an explanation. Include each distinct relevant marking once, citing its source photo. legibility is clear, partial or illegible. all_characters_visible and target_device MUST be JSON booleans, never descriptions or strings. Use clear and all_characters_visible:true only when every transcribed character is readable and complete in that photo. Use ? for uncertain characters. Empty text is valid. Decorative stars are not maker letters. Mention any other hardware separately; do not use its markings to identify the target device. Confidence percentages are not requested.`;

export function parseGroupedReply(body:any,count:number):{labels:LabelEvidence;result:Record<string,any>} {
 const value=providerObject(body);
 const classified=classifierObject(value);
 if(!Array.isArray(value.reads)||value.reads.length>20)throw Error('grouped_invalid_reads');
 const reads:LabelRead[]=[];const issues:string[]=[];const seen=new Set<string>();
 for(const r of value.reads){
  if(!r||!Number.isInteger(r.photo_index)||r.photo_index<0||r.photo_index>=count||!['brand_mark','product_label'].includes(r.kind)||typeof r.text!=='string'||r.text.length>1200){issues.push('invalid_photo_marking');continue;}
  const key=JSON.stringify([r.photo_index,r.kind,r.text]);if(seen.has(key))continue;seen.add(key);
  const complete=r.legibility==='clear'&&r.all_characters_visible===true&&Boolean(r.text.trim())&&!r.text.includes('?');
  const associated=typeof r.target_device==='boolean';
  if(!associated||typeof r.all_characters_visible!=='boolean')issues.push('invalid_marking_booleans');
  const region={photo_index:r.photo_index,x:0,y:0,w:1,h:1,rotation:0,kind:r.kind};
  reads.push({region,vision_text:r.text,vision_status:r.text.trim()?'read':'unreadable',legibility:complete?'clear':r.text.trim()?'partial':'illegible',
   provenance:{source:'grouped_view',verification_scope:'supplied_view',marking_complete:complete,target_device:r.target_device===true,location_validated:complete&&associated,...(!associated?{association_status:'invalid' as const}:{})},
   ocr_text:'',ocr_confidence:0,ocr_status:'not_attempted',agreed_markings:[],status:r.text.trim()?'unconfirmed':'unreadable'});
 }
 const disagreements=Array.isArray(value.disagreements)?value.disagreements.filter((s:any)=>typeof s==='string').map((s:string)=>s.slice(0,600)).slice(0,10):[];
 const limiting=issues.length?issues.join(','):typeof value.limiting_factor==='string'?value.limiting_factor.slice(0,600):null;
 const labels:LabelEvidence={version:GROUPED_PROMPT_VERSION,status:issues.length?'partial':'completed',reads,limiting_factor:limiting,stage_outcomes:{grouped_reader:{status:issues.length?'partial':'succeeded',reason:'single_engine_joint_photo_read_not_independent_confirmation'}}};
 return {labels,result:{component_class:classified.component_class,manufacturer:null,series:null,model:null,visible_text:reads.map(r=>r.vision_text),attributes:{},evidence:[],confidence:{manufacturer:null,series:null,model:null},
  grouped_identity_claim:{manufacturer:typeof value.manufacturer==='string'?value.manufacturer:null,series:typeof value.series==='string'?value.series:null,model:typeof value.model==='string'?value.model:null,disagreements,source:'joint_photo_reader_unverified'},grouped_prompt_version:GROUPED_PROMPT_VERSION}};
}

export async function readGroupedDevice(images:Buffer[],deadline:number){
 if(images.length<3||images.length>5)throw Error('grouped_photo_count');
 const views=await Promise.all(images.map(image=>prepareProviderImage(image,3_000_000,GROUPED_MODEL)));
 await recordRecognitionEvidence('grouped_photo_inputs',{model:GROUPED_MODEL,effort:'medium',prompt_version:GROUPED_PROMPT_VERSION,one_device:true,expected_identity_supplied:false,
  views:views.map((view,photo_index)=>({photo_index,original_upright_sha256:createHash('sha256').update(images[photo_index]).digest('hex'),provider_sha256:createHash('sha256').update(view.data).digest('hex'),...view.metadata}))});
 const request={model:GROUPED_MODEL,max_tokens:GROUPED_MAX_TOKENS,output_config:{effort:'medium'},messages:[{role:'user',content:[...views.flatMap((view,photo_index)=>[{type:'text',text:`Photo ${photo_index}: a view of the SAME target device.`},{type:'image',source:{type:'base64',media_type:'image/jpeg',data:view.data.toString('base64')}}]),{type:'text',text:GROUPED_PROMPT}]}]};
 const timeout=Math.min(GROUPED_READER_MS,deadline-Date.now());if(timeout<1000)throw Error('grouped_reader_budget_insufficient');
 const response=await auditedFetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:AbortSignal.timeout(timeout),headers:{'x-api-key':process.env.ANTHROPIC_API_KEY!,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify(request)},'grouped_device_reader',body=>parseGroupedReply(body,images.length));
 if(!response.ok)throw Error('grouped_provider_unavailable');
 const result=parseGroupedReply(await response.json(),images.length);
 await recordRecognitionEvidence('grouped_device_result',result);
 return result;
}
