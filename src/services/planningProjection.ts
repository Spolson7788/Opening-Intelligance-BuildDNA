// Descriptive counts only. This threshold is a display guardrail, not reliability evidence.
export const CONDITION_METHOD = 'recorded-condition-v1';
export const CONDITION_THRESHOLD = 12;
const materials=new Set(['steel','wood','aluminum','aluminium','glass','fiberglass','hollow metal','unknown','n/a']);
export function conditionCohorts(components:any[]){
 const groups=new Map<string,any>();let excluded=0;
 for(const h of components.filter(h=>h.lifecycle_state==='active')){
  const raw=String(h.manufacturer||'').trim();
  if(!raw||materials.has(raw.toLowerCase())){excluded++;continue;}
  // No automatic manufacturer aliases or model/variant merges.
  const key=JSON.stringify([raw,h.model_number||'',h.component_type]);
  const g=groups.get(key)||{manufacturer:raw,model:h.model_number||'',component_type:h.component_type,installed:0,assessed:0,worn_failed:0,unverified:0};
  g.installed++;if(['good','worn','failed'].includes(h.condition)){g.assessed++;if(h.condition!=='good')g.worn_failed++;}else g.unverified++;
  groups.set(key,g);
 }
 return {method:CONDITION_METHOD,threshold:CONDITION_THRESHOLD,excluded_manufacturer_count:excluded,cohorts:[...groups.values()].map(g=>({...g,rate:g.assessed>=CONDITION_THRESHOLD?g.worn_failed/g.assessed:null,rate_withheld:g.assessed<CONDITION_THRESHOLD}))};
}
export const PROCUREMENT_GAPS=['named_approver_and_authority_limits','self_approval_policy','verified_provider_recipient','approved_terms_and_service_address','accounting_and_invoice_recognition_policy'];
