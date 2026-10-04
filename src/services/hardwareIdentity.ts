export type IdentitySource='unknown'|'technician_identified'|'photo_suggestion';
export interface IdentityInput {manufacturer?:string|null;model_number?:string|null;component_type?:string;identity_status?:string;identity_source?:IdentitySource;identity_acknowledged?:boolean;recognition_run_id?:string}
export function identityInputError(input:IdentityInput):string|null{
 if(input.identity_source==='technician_identified'&&!input.identity_acknowledged)return 'identity_acknowledgment_required';
 if(input.identity_source==='photo_suggestion'&&!input.recognition_run_id)return 'recognition_run_required';
 if(input.identity_acknowledged){
  if(!input.manufacturer?.trim()||!input.model_number?.trim())return 'identity_details_required';
  if(!input.identity_source||input.identity_source==='unknown')return 'identity_source_required';
 }
 if(input.identity_source==='photo_suggestion'&&input.identity_status==='established'&&!input.identity_acknowledged)return 'identity_acknowledgment_required';
 return null;
}
export function identityValues(input:IdentityInput,userId:string,run?:any){
 const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&!!a.trim()&&a.trim().toLowerCase()===b.trim().toLowerCase();
 const matches=(v:any)=>v&&same(input.manufacturer,v.manufacturer)&&same(input.model_number,v.model);
 const photo=run&&!run.stage_one?.shadow_mode&&matches(run.suggestion);
 const catalog=run&&!run.stage_one?.shadow_mode&&(run.stage_one?.label_reading?.candidates||[]).some((c:any)=>c.manufacturer_basis!=='catalog_partial_model_match'&&matches(c));
 const source=photo||catalog?'photo_suggestion':input.identity_acknowledged?'technician_identified':'unknown';
 return {identity_source:source,identity_value_producer:photo?'AI':catalog?'catalog':source==='technician_identified'?'technician':'unknown',identity_acknowledged_by:input.identity_acknowledged?userId:null,identity_acknowledged_at:input.identity_acknowledged?new Date().toISOString():null,identity_recognition_run_id:input.recognition_run_id||null};
}
