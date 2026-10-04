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
export function identityValues(input:IdentityInput,userId:string){
 return {identity_source:input.identity_source||'unknown',identity_acknowledged_by:input.identity_acknowledged?userId:null,identity_acknowledged_at:input.identity_acknowledged?new Date().toISOString():null,identity_recognition_run_id:input.recognition_run_id||null};
}
